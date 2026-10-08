#!/usr/bin/env python3
"""
Centralized download manager for SyncMusic4.
Manages separate queues for Spotify, SoundCloud, and YouTube downloads.
Processes up to 3 downloads simultaneously (one per platform).
"""

import os
import re
import sqlite3
import threading
import time
import queue
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from typing import List, Dict, Any


def probe_duration(path):
    """Length of an audio file in seconds via ffprobe, or None if it can't be read."""
    try:
        out = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=noprint_wrappers=1:nokey=1', path],
            capture_output=True, text=True, timeout=20
        ).stdout.strip()
        return float(out) if out else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None

# A SoundCloud Go+ preview is ~30s. Any SoundCloud download shorter than this is
# treated as a preview snippet rather than the full track, and (when a fallback
# manager is wired up) retried through the DownCloudMe fallback.
SNIPPET_MAX_SECONDS = 31


def sanitize_filename(filename: str) -> str:
    """
    Remove all characters from a filename that are not alphanumeric or in the
    allowed set: space, hyphen (-), underscore (_), period (.), comma (,).

    The file extension is preserved and sanitized separately.

    @param {str} filename - Original filename (may include extension)
    @returns {str} - Sanitized filename
    """
    base, ext = os.path.splitext(filename)
    # Keep only alphanumeric and allowed special characters
    sanitized_base = re.sub(r'[^\w ,.\-]', '', base, flags=re.UNICODE)
    # Collapse multiple spaces into one and strip leading/trailing whitespace
    sanitized_base = re.sub(r' {2,}', ' ', sanitized_base).strip()
    # Sanitize the extension too (keep only alphanumeric)
    sanitized_ext = re.sub(r'[^\w.]', '', ext)
    return sanitized_base + sanitized_ext

class DownloadManager:
    """
    Centralized download manager with separate queues for each platform.
    Processes downloads simultaneously but only one per platform at a time.
    Emits WebSocket events for download status updates.
    """

    def __init__(self, db_path: str = None, downloads_path: str = None, audio_path: str = None, socketio=None):
        """
        Initialize the download manager.

        @param {str} db_path - Path to the SQLite database
        @param {str} downloads_path - Temporary downloads directory
        @param {str} audio_path - Final audio files directory
        @param {object} socketio - Flask-SocketIO instance for emitting events
        """
        self.db_path = db_path or os.path.join(os.path.dirname(__file__), 'music.db')
        self.downloads_path = downloads_path or os.path.join(os.path.dirname(__file__), 'downloads')
        self.audio_path = audio_path or os.path.join(os.path.dirname(__file__), 'static', 'audio')
        self.socketio = socketio

        # Optional DownCloudMe fallback manager. When set, SoundCloud downloads
        # that only yield a <31s preview snippet are rerouted onto its queue
        # instead of being failed outright. Wired up by app.py; left None for
        # standalone use and to avoid a circular import here.
        self.fallback_manager = None

        # Create queues for each platform
        self.queues = {
            'spotify': queue.Queue(),
            'soundcloud': queue.Queue(),
            'youtube': queue.Queue()
        }

        # Track downloading tracks (track_id -> status)
        self.downloading_status = {}

        # Currently active download per platform (track info dict or None)
        self.current_downloads = {'spotify': None, 'soundcloud': None, 'youtube': None}

        # Base delay (seconds) the worker waits after finishing a download before
        # pulling the next one from the same platform's queue. Throttles bursts
        # so the platform doesn't rate-limit us (which manifested as every track
        # after the first ~8 failing). SoundCloud is the most aggressive limiter.
        self.download_delays = {'spotify': 1.0, 'soundcloud': 2.0, 'youtube': 1.0}

        # Exponential backoff per platform. On consecutive failures (usually
        # rate-limiting) the inter-download wait grows as
        # base * factor ** failures, capped at backoff_max, and resets to the
        # base delay after any success. Tracked separately per platform so one
        # platform being throttled doesn't slow the others.
        self.backoff_factor = 2.0
        self.backoff_max = {'spotify': 60.0, 'soundcloud': 300.0, 'youtube': 60.0}
        self.consecutive_failures = {'spotify': 0, 'soundcloud': 0, 'youtube': 0}

        # Lifetime counters for the downloader dashboard
        self.stats = {'completed': 0, 'failed': 0}

        # Recent events ring buffer (most recent last) for the dashboard
        self.recent_events = []
        self._max_recent_events = 100

        # Worker threads (one per platform)
        self.workers = {}
        self.stop_event = threading.Event()

        # Event queue for thread-safe communication with main thread
        self.event_queue = queue.Queue()

        # DiscoverManager (set by app.py). Downloads flagged 'discover_owner' are
        # discover candidates: their file is handed to it instead of the library.
        self.discover = None

        # Ensure directories exist
        os.makedirs(self.downloads_path, exist_ok=True)
        os.makedirs(self.audio_path, exist_ok=True)

    def get_db_connection(self):
        """Get database connection with row factory."""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def is_duplicate(self, source: str, download_link: str) -> bool:
        """
        Check if a song is already downloaded or in queue.

        @param {str} source - Platform ('spotify', 'soundcloud', 'youtube')
        @param {str} download_link - The download URL
        @returns {bool} - True if duplicate
        """
        # Check database
        conn = self.get_db_connection()
        existing = conn.execute(
            'SELECT id FROM songs WHERE source = ? AND download_link = ?',
            (source, download_link)
        ).fetchone()
        conn.close()

        if existing:
            return True

        # Check queues
        for platform, q in self.queues.items():
            for item in list(q.queue):  # Peek at queue contents
                if item['source'] == source and item['download_link'] == download_link:
                    return True

        # Check the in-flight download (popped off the queue, not yet written to
        # the songs table) so a re-sync doesn't double-download what's downloading.
        active = self.current_downloads.get(source)
        if active and active.get('url') == download_link:
            return True

        return False

    def _emit_event(self, event_type: str, data: Dict[str, Any]):
        """
        Queue a WebSocket event to be emitted from the main thread.

        @param {str} event_type - Type of event
        @param {Dict} data - Event data
        """
        # Record into the ring buffer for the /downloader dashboard
        entry = {'event': event_type, 'data': data, 'ts': time.time()}
        self.recent_events.append(entry)
        if len(self.recent_events) > self._max_recent_events:
            self.recent_events = self.recent_events[-self._max_recent_events:]

        self.event_queue.put((event_type, data))

    def process_events(self):
        """
        Process queued events by emitting them via WebSocket.
        This should be called from the main thread only.
        """
        while not self.event_queue.empty():
            try:
                event_type, data = self.event_queue.get_nowait()
                if self.socketio:
                    try:
                        self.socketio.emit(event_type, data)
                    except Exception as e:
                        print(f"Error emitting {event_type}: {str(e)}")
                self.event_queue.task_done()
            except queue.Empty:
                break

    def add_download(self, song_data: Dict[str, Any]) -> bool:
        """
        Add a song to the appropriate download queue.

        @param {Dict} song_data - Song info with source, download_link, etc.
        @returns {bool} - True if added successfully
        """
        source = song_data.get('source')
        download_link = song_data.get('download_link')

        if not source or not download_link:
            return False

        # Validate source
        if source not in self.queues:
            return False

        # Check for duplicates
        if self.is_duplicate(source, download_link):
            print(f"Duplicate detected: {source} - {download_link}")
            return False

        # Add to appropriate queue
        self.queues[source].put(song_data.copy())

        # Emit event: download queued
        track_info = {
            'url': download_link,
            'title': song_data.get('title', 'Unknown'),
            'artist': song_data.get('artist', 'Unknown'),
            'source': source
        }
        self._emit_event('download_queued', track_info)

        print(f"Added {source} download: {song_data.get('title', 'Unknown')} - {song_data.get('artist', 'Unknown')}")
        return True

    def redownload_song(self, song_id: int) -> bool:
        """
        Re-download an existing song from its original link and swap in the new
        audio file, keeping the same song row. Used to fix songs that ended up
        with the wrong file attached.

        Unlike add_download this bypasses the duplicate check (the song already
        exists by design) and does not create a new row.

        @param {int} song_id - ID of the song to re-download
        @returns {bool} - True if queued successfully
        """
        conn = self.get_db_connection()
        song = conn.execute(
            'SELECT id, title, artist, cover, source, download_link FROM songs WHERE id = ?',
            (song_id,)
        ).fetchone()
        conn.close()

        if not song:
            return False

        source = song['source']
        if source not in self.queues:
            return False

        song_data = {
            'source': source,
            'download_link': song['download_link'],
            'title': song['title'],
            'artist': song['artist'],
            'cover': song['cover'],
            'redownload_song_id': song['id']
        }
        self.queues[source].put(song_data)

        self._emit_event('download_queued', {
            'url': song['download_link'],
            'title': song['title'],
            'artist': song['artist'],
            'source': source
        })

        print(f"Re-downloading {source} song id={song_id}: {song['title']} - {song['artist']}")
        return True

    def download_spotify(self, song_data: Dict[str, Any]) -> bool:
        """
        Download a Spotify track using votify.

        @param {Dict} song_data - Song metadata
        @returns {bool} - True if successful
        """
        try:
            url = song_data['download_link']
            print(f"DEBUG: Starting Spotify download for URL: {url}")

            # Check if votify is installed
            if not shutil.which('votify'):
                print("ERROR: votify is not installed or not in PATH")
                return False

            # Run votify command
            cookies_path = os.path.join(os.path.dirname(__file__), '..', 'cookies.txt')
            if not os.path.exists(cookies_path):
                print(f"ERROR: Cookies file not found at {cookies_path}")
                return False
            print(f"DEBUG: Using cookies from {cookies_path}")

            cmd = ['votify', '--cookies-path', cookies_path, url]
            print(f"DEBUG: Running command: {' '.join(cmd)} in {self.downloads_path}")

            result = subprocess.run(cmd, cwd=self.downloads_path, capture_output=True, text=True)
            print(f"DEBUG: votify return code: {result.returncode}")
            print(f"DEBUG: votify stdout: {result.stdout}")
            print(f"DEBUG: votify stderr: {result.stderr}")

            if result.returncode == 0:
                # Find downloaded files
                downloaded_files = []
                extensions = ('.mp3', '.m4a', '.webm', '.wav', '.flac', '.ogg')
                for root, dirs, files in os.walk(self.downloads_path):
                    for file in files:
                        if file.lower().endswith(extensions):
                            downloaded_files.append(os.path.join(root, file))

                if downloaded_files:
                    # Process first file (should only be one)
                    src_path = downloaded_files[0]
                    filename = os.path.basename(src_path)

                    # Convert M4A to MP3 if needed
                    if filename.lower().endswith('.m4a'):
                        mp3_filename = filename.replace('.m4a', '.mp3')
                        mp3_path = os.path.join(self.audio_path, mp3_filename)
                        convert_result = subprocess.run(
                            ['ffmpeg', '-i', src_path, '-acodec', 'libmp3lame', '-ab', '192k', '-y', mp3_path],
                            capture_output=True, text=True
                        )
                        if convert_result.returncode == 0:
                            dest_path = mp3_path
                            os.remove(src_path)
                        else:
                            # Failed conversion, move M4A as-is
                            dest_path = os.path.join(self.audio_path, filename)
                            shutil.move(src_path, dest_path)
                    else:
                        dest_path = os.path.join(self.audio_path, filename)
                        shutil.move(src_path, dest_path)

                    # Add to database
                    song_data['stored_path'] = self._add_to_database(song_data, dest_path)
                    print(f"Spotify download completed: {song_data.get('title', 'Unknown')}")
                    return True

            reason = self._note_failure(song_data, f"{result.stderr}\n{result.stdout}")
            print(f"Spotify download failed ({reason}): {result.stderr}")
            return False

        except Exception as e:
            self._note_failure(song_data, str(e))
            print(f"Spotify download error: {str(e)}")
            return False

    def download_soundcloud(self, song_data: Dict[str, Any]) -> bool:
        """
        Download a SoundCloud track using yt-dlp.

        @param {Dict} song_data - Song metadata
        @returns {bool} - True if successful
        """
        try:
            url = song_data['download_link']
            print(f"DEBUG: Starting SoundCloud download for URL: {url}")

            # Check if yt-dlp is installed
            if not shutil.which('yt-dlp'):
                print("ERROR: yt-dlp is not installed or not in PATH")
                return False

            # yt-dlp command for audio extraction
            output_template = os.path.join(self.downloads_path, '%(title)s.%(ext)s')
            cmd = [
                'yt-dlp',
                '-x',
                '--audio-format', 'mp3',
                '--audio-quality', '192K',
                # Print the chosen source format id and the full track duration
                # so we can detect Go+/preview-only tracks. yt-dlp silently
                # downloads those as a 30s snippet and exits 0, so without this
                # the preview would land in the library as a "successful"
                # download. The 'after_move:' prefix keeps the real download
                # running (it does not switch yt-dlp into simulate mode).
                '--print', 'after_move:[SC_META] format_id=%(format_id)s duration=%(duration)s',
                '-o', output_template,
                url
            ]
            print(f"DEBUG: Running command: {' '.join(cmd)}")

            result = subprocess.run(cmd, capture_output=True, text=True)
            print(f"DEBUG: yt-dlp return code: {result.returncode}")
            print(f"DEBUG: yt-dlp stdout: {result.stdout}")
            print(f"DEBUG: yt-dlp stderr: {result.stderr}")

            if result.returncode == 0:
                # Find downloaded file
                downloaded_files = [f for f in os.listdir(self.downloads_path) if f.endswith('.mp3')]

                if downloaded_files:
                    src_path = os.path.join(self.downloads_path, downloaded_files[0])
                    filename = downloaded_files[0]

                    # Detect Go+/preview-only tracks: yt-dlp returns 0 but only
                    # the 30s preview was downloaded. If so, discard the snippet
                    # and either reroute to the DownCloudMe fallback or fail —
                    # never store a truncated track.
                    format_id, meta_duration = self._parse_sc_meta(result.stdout)
                    actual_duration = self._probe_duration(src_path)
                    if self._is_soundcloud_snippet(format_id, actual_duration):
                        os.remove(src_path)
                        print(
                            f"SoundCloud snippet detected, discarding preview: "
                            f"{song_data.get('title', 'Unknown')} "
                            f"[format_id={format_id}, meta_dur={meta_duration}, file_dur={actual_duration}]"
                        )
                        if self._reroute_to_fallback(song_data):
                            # The fallback owns this track's outcome now; tell the
                            # worker not to count it as a failure (see _worker_thread).
                            song_data['rerouted_to_fallback'] = True
                            return False
                        # No fallback wired up (or it refused). Record as an
                        # 'unavailable' failure so the worker fails fast (no backoff).
                        self._note_failure(
                            song_data,
                            "SoundCloud Go+ preview snippet detected "
                            "(only ~30s available, not the full track)"
                        )
                        return False

                    # Move to audio directory
                    dest_path = os.path.join(self.audio_path, filename)
                    if os.path.exists(dest_path):
                        # Handle duplicates
                        base, ext = os.path.splitext(filename)
                        counter = 1
                        while os.path.exists(os.path.join(self.audio_path, f"{base}_{counter}{ext}")):
                            counter += 1
                        dest_path = os.path.join(self.audio_path, f"{base}_{counter}{ext}")

                    shutil.move(src_path, dest_path)

                    # Add to database
                    song_data['stored_path'] = self._add_to_database(song_data, dest_path)
                    print(f"SoundCloud download completed: {song_data.get('title', 'Unknown')}")
                    return True

            reason = self._note_failure(song_data, f"{result.stderr}\n{result.stdout}")
            print(f"SoundCloud download failed ({reason}): {result.stderr}")
            return False

        except Exception as e:
            self._note_failure(song_data, str(e))
            print(f"SoundCloud download error: {str(e)}")
            return False

    def download_youtube(self, song_data: Dict[str, Any]) -> bool:
        """
        Download a YouTube video audio using yt-dlp.

        @param {Dict} song_data - Song metadata
        @returns {bool} - True if successful
        """
        import traceback as tb

        url = song_data['download_link']
        title = song_data.get('title', 'Unknown')

        try:
            print(f"[YouTube] Starting download  title='{title}'  url={url}")

            if not shutil.which('yt-dlp'):
                print("[YouTube] ERROR: yt-dlp is not installed or not in PATH")
                return False

            # Use isolated temp dir to avoid grabbing wrong file when concurrent with SoundCloud
            with tempfile.TemporaryDirectory(dir=self.downloads_path) as tmpdir:
                output_template = os.path.join(tmpdir, '%(title)s.%(ext)s')
                cmd = [
                    'yt-dlp',
                    '-x',
                    '--no-playlist',
                    '--audio-format', 'mp3',
                    '--audio-quality', '192K',
                    # Newer YouTube requires solving JS signature/"n" challenges.
                    # This downloads yt-dlp's EJS solver script and runs it under
                    # the deno runtime; without it only image formats resolve and
                    # the download fails with "Requested format is not available".
                    '--remote-components', 'ejs:github',
                    '-o', output_template,
                ]

                # YouTube blocks datacenter IPs with a "confirm you're not a bot"
                # check unless authenticated. Pass an exported YouTube cookies file
                # if one is present (repo-root youtube_cookies.txt). Spotify's
                # cookies.txt is NOT valid here — these must be YouTube/Google cookies.
                yt_cookies = os.path.join(os.path.dirname(__file__), '..', 'cookies_youtube.txt')
                if os.path.exists(yt_cookies):
                    print(f"[YouTube] Using cookies from {yt_cookies}")
                    cmd += ['--cookies', yt_cookies]
                else:
                    print("[YouTube] WARNING: no youtube_cookies.txt found; "
                          "YouTube may reject the request as a bot")

                cmd.append(url)
                print(f"[YouTube] Running command: {' '.join(cmd)}")

                result = subprocess.run(cmd, capture_output=True, text=True, cwd=self.downloads_path)

                print(f"[YouTube] yt-dlp exit code: {result.returncode}")
                if result.stdout.strip():
                    print(f"[YouTube] yt-dlp stdout:\n{result.stdout.strip()}")
                if result.stderr.strip():
                    print(f"[YouTube] yt-dlp stderr:\n{result.stderr.strip()}")

                if result.returncode != 0:
                    reason = self._note_failure(song_data, f"{result.stderr}\n{result.stdout}")
                    print(f"[YouTube] DOWNLOAD FAILED ({reason})  title='{title}'  url={url}")
                    print(f"[YouTube] Exit code {result.returncode} — full stderr above")
                    return False

                # Find downloaded file in our isolated dir only
                extensions = ('.mp3', '.m4a', '.webm', '.opus')
                downloaded_files = [f for f in os.listdir(tmpdir) if f.lower().endswith(extensions)]
                print(f"[YouTube] Files found in tmpdir after download: {downloaded_files}")

                # Prefer mp3
                mp3_files = [f for f in downloaded_files if f.lower().endswith('.mp3')]
                target_files = mp3_files if mp3_files else downloaded_files

                if not target_files:
                    print(f"[YouTube] ERROR: yt-dlp exited 0 but no audio files found in tmpdir '{tmpdir}'")
                    print(f"[YouTube] All tmpdir contents: {os.listdir(tmpdir)}")
                    return False

                src_path = os.path.join(tmpdir, target_files[0])
                filename = target_files[0]
                dest_path = os.path.join(self.audio_path, filename)
                if os.path.exists(dest_path):
                    base, ext = os.path.splitext(filename)
                    counter = 1
                    while os.path.exists(os.path.join(self.audio_path, f"{base}_{counter}{ext}")):
                        counter += 1
                    dest_path = os.path.join(self.audio_path, f"{base}_{counter}{ext}")

                shutil.move(src_path, dest_path)
                song_data['stored_path'] = self._add_to_database(song_data, dest_path)
                print(f"[YouTube] Download completed  title='{title}'  file='{os.path.basename(dest_path)}'")
                return True

        except Exception as e:
            print(f"[YouTube] EXCEPTION during download  title='{title}'  url={url}")
            print(f"[YouTube] Exception type: {type(e).__name__}  message: {e}")
            print(f"[YouTube] Traceback:\n{tb.format_exc()}")
            return False

    def _add_to_database(self, song_data: Dict[str, Any], file_path: str):
        """
        Add downloaded song to database with file renamed to start with song ID.
        Also checks sync_items and auto-adds the song to playlists.

        When song_data carries 'redownload_song_id', the freshly downloaded file
        replaces the audio for that existing song row instead of inserting a new
        one (used to fix songs that ended up with the wrong file attached).

        @param {Dict} song_data - Song metadata
        @param {str} file_path - Current file path
        @returns {str|None} - Final stored path (with song-id prefix), or None on conflict
        """
        if song_data.get('discover_owner') and self.discover:
            return self.discover.download_finished(song_data, file_path)

        conn = self.get_db_connection()

        try:
            redownload_id = song_data.get('redownload_song_id')
            old_path = None

            if redownload_id:
                existing = conn.execute(
                    'SELECT file_path FROM songs WHERE id = ?', (redownload_id,)
                ).fetchone()
                if existing:
                    song_id = redownload_id
                    old_path = existing['file_path']
                else:
                    # Song was deleted mid re-download; fall back to a normal insert
                    redownload_id = None

            if not redownload_id:
                # Insert into database first to get ID
                cursor = conn.execute(
                    'INSERT INTO songs (title, artist, cover, source, download_link, file_path) VALUES (?, ?, ?, ?, ?, ?)',
                    (
                        song_data.get('title', 'Unknown'),
                        song_data.get('artist', 'Unknown'),
                        song_data.get('cover'),
                        song_data['source'],
                        song_data['download_link'],
                        file_path  # Temporary, will update
                    )
                )

                song_id = cursor.lastrowid
                if song_data.get('added_by') and song_data.get('added_via'):
                    conn.execute(
                        'INSERT OR REPLACE INTO library_additions (song_id, owner, via, added_at) VALUES (?, ?, ?, ?)',
                        (song_id, song_data['added_by'], song_data['added_via'],
                         datetime.now(timezone.utc).isoformat(timespec='seconds'))
                    )
                conn.commit()

            # Rename file to start with song ID, with special characters removed
            dir_path = os.path.dirname(file_path)
            filename = os.path.basename(file_path)
            clean_filename = sanitize_filename(filename)
            new_filename = f"{song_id}_{clean_filename}"
            new_path = os.path.join(dir_path, new_filename)

            os.rename(file_path, new_path)

            # Update database with correct path (and the new file's length)
            conn.execute(
                'UPDATE songs SET file_path = ?, duration = ? WHERE id = ?',
                (new_path, probe_duration(new_path), song_id)
            )
            conn.commit()

            if redownload_id:
                # Remove the stale audio file the song used to point at
                if old_path and old_path != new_path and os.path.isfile(old_path):
                    try:
                        os.remove(old_path)
                    except OSError as e:
                        print(f"[Redownload] Could not remove old file {old_path}: {e}")
                self._emit_event('song_redownloaded', {
                    'song_id': song_id,
                    'url': f'/audio/{new_filename}'
                })
            else:
                # Check sync_items for matching download_link and auto-add to playlists
                self._process_sync_items_for_download(conn, song_data['download_link'], song_id)

            return new_path

        except sqlite3.IntegrityError:
            return None
        finally:
            conn.close()

    def _process_sync_items_for_download(self, conn, download_link: str, song_id: int):
        """
        After a song is downloaded, update any matching sync_items and
        add the song to the corresponding playlists.
        """
        try:
            pending_items = conn.execute(
                "SELECT * FROM sync_items WHERE download_link = ? AND status IN ('pending', 'downloading')",
                (download_link,)
            ).fetchall()

            for item in pending_items:
                playlist_id = item['playlist_id']

                conn.execute(
                    "UPDATE sync_items SET status = 'downloaded', song_id = ? WHERE id = ?",
                    (song_id, item['id'])
                )

                # Add song to playlist if not already there
                in_playlist = conn.execute(
                    'SELECT id FROM playlist_songs WHERE playlist_id = ? AND song_id = ?',
                    (playlist_id, song_id)
                ).fetchone()
                if not in_playlist:
                    max_pos = conn.execute(
                        'SELECT MAX(position) as mp FROM playlist_songs WHERE playlist_id = ?',
                        (playlist_id,)
                    ).fetchone()
                    next_pos = (max_pos['mp'] or 0) + 1
                    conn.execute(
                        'INSERT OR IGNORE INTO playlist_songs (playlist_id, song_id, position) VALUES (?, ?, ?)',
                        (playlist_id, song_id, next_pos)
                    )

                conn.commit()

                self._emit_event('sync_item_updated', {
                    'playlist_id': playlist_id,
                    'download_link': download_link,
                    'status': 'downloaded',
                    'song_id': song_id
                })

        except Exception as e:
            print(f"[SyncItems] Error processing sync items: {e}")

    def _update_sync_item_status(self, download_link: str, status: str):
        """Update sync_items status for a given download_link and emit WebSocket events."""
        try:
            conn = self.get_db_connection()
            items = conn.execute(
                "SELECT * FROM sync_items WHERE download_link = ? AND status NOT IN ('downloaded', 'error')",
                (download_link,)
            ).fetchall()

            for item in items:
                conn.execute(
                    "UPDATE sync_items SET status = ? WHERE id = ?",
                    (status, item['id'])
                )
                self._emit_event('sync_item_updated', {
                    'playlist_id': item['playlist_id'],
                    'download_link': download_link,
                    'status': status,
                    'song_id': item['song_id']
                })

            conn.commit()
            conn.close()
        except Exception as e:
            print(f"[SyncItems] Error updating sync item status: {e}")

    def _parse_sc_meta(self, stdout: str):
        """
        Pull the format id and full-track duration out of the '[SC_META]' line
        printed by yt-dlp's --print during a SoundCloud download.

        @param {str} stdout - yt-dlp stdout
        @returns {tuple} - (format_id: str|None, duration: float|None)
        """
        m = re.search(r'\[SC_META\] format_id=(\S+) duration=(\S+)', stdout or '')
        if not m:
            return None, None
        format_id = m.group(1)
        try:
            duration = float(m.group(2))
        except ValueError:
            duration = None  # yt-dlp prints 'NA' when duration is unknown
        return format_id, duration

    def _probe_duration(self, path: str):
        """
        Return the real audio duration (seconds) of a file via ffprobe, or None
        if ffprobe is unavailable or fails.

        @param {str} path - Path to the audio file
        @returns {float|None} - Duration in seconds
        """
        if not shutil.which('ffprobe'):
            return None
        try:
            result = subprocess.run(
                ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                 '-of', 'default=noprint_wrappers=1:nokey=1', path],
                capture_output=True, text=True
            )
            return float(result.stdout.strip())
        except (ValueError, OSError):
            return None

    def _is_soundcloud_snippet(self, format_id, actual_duration) -> bool:
        """
        Decide whether a downloaded SoundCloud file is just the Go+/preview
        snippet rather than the full track.

        Two signals: yt-dlp tags preview-only formats with 'preview' in the
        format id, and a snippet runs ~30s, so anything shorter than
        SNIPPET_MAX_SECONDS is treated as a preview.

        @param {str|None} format_id - Source format id chosen by yt-dlp
        @param {float|None} actual_duration - Real duration of the file on disk
        @returns {bool} - True if the file is a preview snippet
        """
        if format_id and 'preview' in format_id.lower():
            return True
        if actual_duration is not None and actual_duration < SNIPPET_MAX_SECONDS:
            return True
        return False

    def _reroute_to_fallback(self, song_data: Dict[str, Any]) -> bool:
        """
        Hand a SoundCloud track that only yielded a preview snippet off to the
        DownCloudMe fallback manager, if one is wired up (self.fallback_manager).

        Used for fresh downloads — the snippet file has already been discarded
        and no songs row was written, so the fallback does a normal insert. (A
        re-download whose new fetch is also a snippet is left to the migration
        script, which enqueues onto the fallback queue directly.)

        @param {Dict} song_data - The track being downloaded
        @returns {bool} - True if the fallback accepted the track
        """
        fb = self.fallback_manager
        if fb is None or song_data.get('discover_owner'):
            # Discover candidates stay out of the fallback: it would add them to the library.
            return False
        accepted = fb.add_download({
            'source': 'downcloud',
            'download_link': song_data['download_link'],
            'title': song_data.get('title', 'Unknown'),
            'artist': song_data.get('artist', 'Unknown'),
            'cover': song_data.get('cover'),
        })
        if accepted:
            print(f"[SoundCloud] Rerouted to DownCloudMe fallback: {song_data.get('title', 'Unknown')}")
        else:
            print(f"[SoundCloud] Fallback refused (duplicate/invalid): {song_data.get('title', 'Unknown')}")
        return accepted

    def _classify_failure(self, text: str) -> str:
        """
        Classify a download failure from the tool's stderr/stdout so the worker
        can decide whether to grow the exponential backoff.

        Returns one of:
          'rate_limit'  - throttled (429 / too many requests). Backoff helps.
          'unavailable' - content/permission issue (SoundCloud Go+/Pro-only,
                          geo-blocked, private, removed, forbidden). Backoff is
                          pointless — the track will never download, so we fail
                          fast without penalising other tracks on the platform.
          'other'       - unknown/transient error. Treated like rate_limit
                          (backoff) since repeated unknown failures are most
                          often throttling in disguise.

        @param {str} text - Combined stderr/stdout from the download tool
        @returns {str} - 'rate_limit' | 'unavailable' | 'other'
        """
        t = (text or '').lower()

        # Rate-limiting is unambiguous and takes priority.
        rate_limit_markers = (
            '429', 'too many requests', 'rate limit', 'rate-limit',
            'rate exceeded', 'throttl', 'try again later', 'temporarily',
        )
        if any(m in t for m in rate_limit_markers):
            return 'rate_limit'

        # Content / permission problems that backing off will never fix.
        unavailable_markers = (
            'go+', 'go plus', 'premium', 'subscription', 'subscriber',
            'only available', 'not available', 'unavailable',
            'geo-restrict', 'geo restrict', 'geoblock', 'geo-block',
            'private', 'no longer available', 'has been removed',
            'been deleted', 'this track is not', 'requires authentication',
            'requires a subscription', 'paywall', 'drm', 'forbidden',
            'http error 403', '403', '404', 'not found', 'sign in', 'log in',
            'login', 'account', 'preview', 'snippet',
        )
        if any(m in t for m in unavailable_markers):
            return 'unavailable'

        return 'other'

    def _note_failure(self, song_data: Dict[str, Any], text: str) -> str:
        """
        Record why a download failed on the song_data so the worker thread can
        read it back. Returns the classified reason.
        """
        reason = self._classify_failure(text)
        song_data['failure_reason'] = reason
        return reason

    def _backoff_delay(self, platform: str) -> float:
        """
        Compute how long the worker should wait before the next download on a
        platform, given its current consecutive-failure count (exponential
        backoff). With zero failures this is just the base throttle delay.

        @param {str} platform - 'spotify', 'soundcloud', or 'youtube'
        @returns {float} - Delay in seconds
        """
        base = self.download_delays.get(platform, 0)
        failures = self.consecutive_failures.get(platform, 0)
        if failures <= 0:
            return base
        delay = base * (self.backoff_factor ** failures)
        return min(delay, self.backoff_max.get(platform, delay))

    def _download_func_for(self, platform: str):
        """
        Map a platform key to the callable that performs its download.

        Factored out so subclasses (e.g. the DownCloudMe fallback manager) can
        register their own platform without re-implementing the worker loop.

        @param {str} platform - Platform key for one of self.queues
        @returns {callable|None} - download_<platform>(song_data) -> bool
        """
        return {
            'spotify': self.download_spotify,
            'soundcloud': self.download_soundcloud,
            'youtube': self.download_youtube
        }.get(platform)

    def _worker_thread(self, platform: str):
        """
        Worker thread for processing downloads from a specific platform.

        @param {str} platform - 'spotify', 'soundcloud', or 'youtube'
        """
        download_func = self._download_func_for(platform)

        if not download_func:
            return

        while not self.stop_event.is_set():
            try:
                # Get song from queue (blocks if empty)
                song_data = self.queues[platform].get(timeout=1)
                # Clear any stale failure reason from a previous attempt.
                song_data.pop('failure_reason', None)
                print(f"Worker {platform}: Got song from queue: {song_data.get('title', 'Unknown')}")

                # A discover candidate that was rated/redrawn while still queued.
                if song_data.get('discover_owner') and self.discover and not self.discover.still_wanted(song_data):
                    print(f"Worker {platform}: Skipping discarded discover candidate: {song_data.get('title', 'Unknown')}")
                    self.queues[platform].task_done()
                    continue

                # Emit download started event
                track_info = {
                    'url': song_data['download_link'],
                    'title': song_data.get('title', 'Unknown'),
                    'artist': song_data.get('artist', 'Unknown'),
                    'source': platform
                }
                print(f"Worker {platform}: Emitting download_started for {track_info['title']}")
                self.current_downloads[platform] = track_info
                self._emit_event('download_started', track_info)

                # Update sync_items status to 'downloading'
                self._update_sync_item_status(song_data['download_link'], 'downloading')

                # Download
                print(f"Worker {platform}: Starting download for {track_info['title']}")
                success = download_func(song_data)
                print(f"Worker {platform}: Download finished, success={success} for {track_info['title']}")

                # Clear active download
                self.current_downloads[platform] = None

                # If the download was handed off to the fallback manager (a Go+
                # preview snippet), the fallback now owns the outcome. Don't count
                # it as a failure, don't grow backoff, and leave sync_items as
                # 'downloading' so the fallback can complete it.
                if song_data.get('rerouted_to_fallback'):
                    self._emit_event('download_rerouted', {
                        **track_info,
                        'reason': 'soundcloud_snippet',
                    })
                    print(f"[Worker:{platform}] Rerouted to fallback: '{song_data.get('title', 'Unknown')}'")
                    self.queues[platform].task_done()
                    continue

                # Update lifetime counters
                self.stats['completed' if success else 'failed'] += 1

                # Classify the failure so we only back off when it's likely to
                # help. A success clears the streak; a rate-limit/unknown failure
                # grows it (longer next wait); a content/permission failure
                # ('unavailable', e.g. SoundCloud Go+/Pro-only, geo-blocked,
                # private) is left out of the backoff entirely — waiting won't
                # make an undownloadable track downloadable, and it shouldn't
                # penalise the other tracks queued on that platform.
                failure_reason = None if success else song_data.get('failure_reason', 'other')
                if success:
                    self.consecutive_failures[platform] = 0
                elif failure_reason != 'unavailable':
                    self.consecutive_failures[platform] += 1

                # Emit completion event
                event_type = 'download_completed' if success else 'download_failed'
                track_info['success'] = success
                if success:
                    track_info['path'] = song_data.get('stored_path')
                else:
                    track_info['failure_reason'] = failure_reason
                print(f"Worker {platform}: Emitting {event_type} for {track_info['title']}")
                self._emit_event(event_type, track_info)

                if not success and song_data.get('discover_owner') and self.discover:
                    self.discover.download_failed(song_data, failure_reason)

                if not success:
                    self._update_sync_item_status(song_data['download_link'], 'error')
                    no_backoff = ' (no backoff — content/permission issue)' if failure_reason == 'unavailable' else ''
                    print(
                        f"[Worker:{platform}] Download FAILED [{failure_reason}]: '{song_data.get('title', 'Unknown')}'"
                        f"  url={song_data.get('download_link', 'N/A')}{no_backoff}"
                        f"  (see platform-level logs above for details)"
                    )
                else:
                    print(f"[Worker:{platform}] Download completed: '{song_data.get('title', 'Unknown')}'")
                    # Note: sync_items updated to 'downloaded' in _add_to_database

                # Mark task as done
                self.queues[platform].task_done()

                # Throttle between downloads on the same platform to avoid
                # rate-limiting, backing off exponentially while downloads keep
                # failing. Skip the wait if the queue is already empty so a lone
                # download doesn't pay the delay (and the idle wait on get()
                # serves as backoff anyway).
                delay = self._backoff_delay(platform)
                if delay > 0 and not self.queues[platform].empty():
                    if self.consecutive_failures[platform] > 0:
                        print(
                            f"[Worker:{platform}] Backing off {delay:.1f}s after "
                            f"{self.consecutive_failures[platform]} consecutive failure(s)"
                        )
                    if self.stop_event.wait(delay):
                        break

            except queue.Empty:
                continue
            except Exception as e:
                import traceback as tb
                print(f"[Worker:{platform}] Unhandled exception: {type(e).__name__}: {e}")
                print(f"[Worker:{platform}] Traceback:\n{tb.format_exc()}")

    def start(self):
        """Start the download manager worker threads."""
        print("Starting download manager...")

        # Start worker threads
        for platform in self.queues:
            thread = threading.Thread(target=self._worker_thread, args=(platform,), daemon=True, name=f"DownloadWorker-{platform}")
            thread.start()
            self.workers[platform] = thread
            print(f"Started worker thread for {platform}")

        print(f"Download manager started with {len(self.workers)} worker thread(s).")

    def stop(self):
        """Stop the download manager."""
        print("Stopping download manager...")
        self.stop_event.set()

        # Wait for all tasks to complete
        for platform, q in self.queues.items():
            q.join()

        print("Download manager stopped.")

    def get_queue_sizes(self) -> Dict[str, int]:
        """Get the current sizes of all download queues."""
        return {platform: q.qsize() for platform, q in self.queues.items()}

    def get_status(self) -> Dict[str, Any]:
        """
        Build a full snapshot of the download manager for the /downloader
        dashboard: queued items, the active download per platform, worker
        liveness, lifetime counters and the recent event log.

        @returns {Dict} - Serializable status snapshot
        """
        def track_view(item):
            if not item:
                return None
            return {
                'title': item.get('title', 'Unknown'),
                'artist': item.get('artist', 'Unknown'),
                'url': item.get('download_link') or item.get('url'),
                'source': item.get('source'),
            }

        queues = {}
        for platform, q in self.queues.items():
            # list(q.queue) is a best-effort, non-blocking peek at pending items
            queues[platform] = [track_view(item) for item in list(q.queue)]

        return {
            'active': not self.stop_event.is_set(),
            'queue_sizes': self.get_queue_sizes(),
            'queues': queues,
            'current': {p: track_view(t) for p, t in self.current_downloads.items()},
            'workers': {p: (t.is_alive() if t else False) for p, t in self.workers.items()},
            'backoff': {
                p: {
                    'consecutive_failures': self.consecutive_failures.get(p, 0),
                    'next_delay': self._backoff_delay(p),
                }
                for p in self.queues
            },
            'stats': dict(self.stats),
            'recent_events': list(self.recent_events),
        }


# Global instance
manager = DownloadManager()

if __name__ == '__main__':
    # Example usage
    manager.start()

    # Add some test downloads
    # manager.add_download({
    #     'source': 'spotify',
    #     'download_link': 'https://open.spotify.com/track/...',
    #     'title': 'Test Song',
    #     'artist': 'Test Artist'
    # })

    try:
        while True:
            time.sleep(1)
            sizes = manager.get_queue_sizes()
            if any(sizes.values()):
                print(f"Queue sizes: {sizes}")
    except KeyboardInterrupt:
        manager.stop()