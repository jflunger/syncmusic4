#!/usr/bin/env python3
"""
Dedicated download manager for the DownCloudMe SoundCloud fallback.

This is a sibling of DownloadManager (download_manager.py) with a single
'downcloud' queue/worker. It exists so the fallback path runs through the same
queue/worker/backoff/WebSocket machinery as the primary downloaders instead of
being a one-shot function — handy when yt-dlp can't fetch a track (e.g.
SoundCloud Go+ tracks) and you want to retry it through downcloudme.com.

It subclasses DownloadManager to reuse all of the DB insert, sync_items,
event-emitting and backoff logic, and only swaps in:
  - a single platform key 'downcloud' (queues/current/backoff/dashboard), and
  - download_downcloud(), which delegates to downcloud_downloader.download_audio.

Tracks are stored in the DB tagged source='soundcloud' (the songs.source CHECK
constraint only allows youtube/soundcloud/spotify, and a fallback-fetched track
is still a SoundCloud track), so they dedup against the primary SoundCloud
library and satisfy sync_items keyed by download_link.

Usage:
    from downcloud_manager import DownCloudManager
    dc = DownCloudManager(socketio=socketio)
    dc.start()
    dc.add_download({'source': 'downcloud',
                     'download_link': 'https://soundcloud.com/.../track',
                     'title': 'Track', 'artist': 'Artist'})

Emits: download_queued / download_started / download_completed / download_failed
       (source='downcloud'), plus sync_item_updated / song_redownloaded.
"""

import os
import queue
import shutil
from typing import Dict, Any

from download_manager import DownloadManager
import downcloud_downloader

# DB source tag for fallback-fetched tracks. Must be one of the values allowed
# by the songs.source CHECK constraint; a DownCloudMe download is still a
# SoundCloud track, so it shares the SoundCloud library and dedup space.
DB_SOURCE = 'soundcloud'

# Internal platform key for this manager's queue/worker/dashboard. Distinct from
# DB_SOURCE so the dashboard shows fallback downloads separately from the
# primary SoundCloud worker.
PLATFORM = 'downcloud'


class DownCloudManager(DownloadManager):
    """Single-queue download manager backed by the DownCloudMe service."""

    def __init__(self, db_path: str = None, downloads_path: str = None,
                 audio_path: str = None, socketio=None):
        """
        @param {str} db_path - Path to the SQLite database (shared with the app)
        @param {str} downloads_path - Temporary downloads directory
        @param {str} audio_path - Final audio files directory
        @param {object} socketio - Flask-SocketIO instance for emitting events
        """
        super().__init__(db_path=db_path, downloads_path=downloads_path,
                         audio_path=audio_path, socketio=socketio)

        # Replace the inherited spotify/soundcloud/youtube setup with a single
        # 'downcloud' platform. start()/stop()/get_status() all iterate
        # self.queues, so they pick this up without further changes.
        self.queues = {PLATFORM: queue.Queue()}
        self.current_downloads = {PLATFORM: None}
        self.download_delays = {PLATFORM: 2.0}
        self.backoff_max = {PLATFORM: 300.0}
        self.consecutive_failures = {PLATFORM: 0}

    def _download_func_for(self, platform: str):
        """Route the 'downcloud' platform to the DownCloudMe download path."""
        if platform == PLATFORM:
            return self.download_downcloud
        return None

    def is_duplicate(self, source: str, download_link: str) -> bool:
        """
        True if the track is already in the SoundCloud library, queued here, or
        currently downloading.

        Overridden because the inherited check keys the DB lookup on the queue's
        platform name ('downcloud'), but rows are stored under source='soundcloud'.
        We dedup against the SoundCloud library so the fallback won't re-fetch
        what the primary downloader already has.

        @param {str} source - Ignored; kept for signature compatibility
        @param {str} download_link - The SoundCloud track URL
        @returns {bool} - True if duplicate
        """
        conn = self.get_db_connection()
        existing = conn.execute(
            'SELECT id FROM songs WHERE source = ? AND download_link = ?',
            (DB_SOURCE, download_link)
        ).fetchone()
        conn.close()
        if existing:
            return True

        for q in self.queues.values():
            for item in list(q.queue):
                if item.get('download_link') == download_link:
                    return True

        active = self.current_downloads.get(PLATFORM)
        if active and active.get('url') == download_link:
            return True

        return False

    def download_downcloud(self, song_data: Dict[str, Any]) -> bool:
        """
        Download a SoundCloud track via downcloudme.com and store it.

        Mirrors download_soundcloud: fetch into downloads_path, move into
        audio_path (de-duplicating the file name), then insert/relink in the DB.

        @param {Dict} song_data - Song metadata (needs 'download_link')
        @returns {bool} - True if successful
        """
        url = song_data['download_link']
        title = song_data.get('title', 'Unknown')
        print(f"[DownCloud] Starting download  title='{title}'  url={url}")

        try:
            result = downcloud_downloader.download_audio(url, download_dir=self.downloads_path)

            if not result.get('success'):
                details = result.get('details') or result.get('error', '')
                reason = self._note_failure(song_data, details)
                print(f"[DownCloud] DOWNLOAD FAILED ({reason})  title='{title}'  {details}")
                return False

            src_path = result['file']
            filename = os.path.basename(src_path)

            # Move to the audio directory, de-duplicating the file name.
            dest_path = os.path.join(self.audio_path, filename)
            if os.path.exists(dest_path):
                base, ext = os.path.splitext(filename)
                counter = 1
                while os.path.exists(os.path.join(self.audio_path, f"{base}_{counter}{ext}")):
                    counter += 1
                dest_path = os.path.join(self.audio_path, f"{base}_{counter}{ext}")

            shutil.move(src_path, dest_path)

            # Store as a SoundCloud track (CHECK constraint + library dedup).
            song_data['source'] = DB_SOURCE
            stored_path = self._add_to_database(song_data, dest_path)
            if stored_path is None:
                # Lost a dedup race (UNIQUE(source, download_link)); drop the
                # orphaned file rather than leaving it in the audio dir.
                if os.path.isfile(dest_path):
                    os.remove(dest_path)
                self._note_failure(song_data, 'Track already exists in library')
                print(f"[DownCloud] Skipped (already in library)  title='{title}'")
                return False

            song_data['stored_path'] = stored_path
            print(f"[DownCloud] Download completed  title='{title}'  "
                  f"file='{os.path.basename(stored_path)}'")
            return True

        except Exception as e:
            self._note_failure(song_data, str(e))
            print(f"[DownCloud] EXCEPTION  title='{title}'  {type(e).__name__}: {e}")
            return False


# Global instance (mirrors download_manager.manager).
manager = DownCloudManager()


def _self_test():
    """
    Live end-to-end test against the project sample track, isolated from the
    real library: uses a temp DB + temp audio dir so it never touches music.db
    or static/audio. Verifies the file lands and a songs row is written.
    """
    import sqlite3
    import tempfile
    import time

    tmp = tempfile.mkdtemp(prefix='downcloud_mgr_test_')
    db_path = os.path.join(tmp, 'test.db')
    audio_path = os.path.join(tmp, 'audio')
    os.makedirs(audio_path, exist_ok=True)

    # Minimal schema matching server/app.py's songs table.
    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE songs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL, artist TEXT, cover TEXT,
            source TEXT CHECK(source IN ('youtube','soundcloud','spotify')),
            download_link TEXT NOT NULL, file_path TEXT NOT NULL,
            start_time REAL, end_time REAL,
            UNIQUE(source, download_link)
        )""")
    conn.execute("CREATE TABLE sync_items (id INTEGER PRIMARY KEY, playlist_id INTEGER, "
                 "download_link TEXT, status TEXT, song_id INTEGER)")
    conn.commit()
    conn.close()

    dc = DownCloudManager(db_path=db_path, audio_path=audio_path)
    dc.start()
    print("Queuing sample track through the fallback manager...")
    queued = dc.add_download({
        'source': PLATFORM,
        'download_link': 'https://soundcloud.com/outsidersnlmusic/free',
        'title': 'Free (feat. Starsplash)',
        'artist': 'Outsiders',
    })
    if not queued:
        print("Test failed: add_download returned False")
        return False

    # Wait for the worker to finish (poll the queue + stats).
    deadline = time.time() + 150
    while time.time() < deadline:
        dc.process_events()
        if dc.stats['completed'] or dc.stats['failed']:
            break
        time.sleep(1)
    dc.stop()

    conn = sqlite3.connect(db_path)
    row = conn.execute("SELECT title, source, file_path FROM songs").fetchone()
    conn.close()

    if dc.stats['completed'] == 1 and row and os.path.exists(row[2]):
        print(f"Test passed: stored '{row[0]}' (source={row[1]}) -> {row[2]} "
              f"({os.path.getsize(row[2])} bytes)")
        return True

    print(f"Test failed: stats={dc.stats} row={row}")
    return False


if __name__ == '__main__':
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == '--test':
        sys.exit(0 if _self_test() else 1)
    print("DownCloudManager — SoundCloud fallback download manager.")
    print("Run a live end-to-end test with:  python downcloud_manager.py --test")
