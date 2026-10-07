"""
Related-track discovery for YouTube and SoundCloud, fetched by a slow
background queue and stored in the `related_tracks` table.

Lookups hit the platforms, so they never run inline in a request. A request
enqueues a library song (RelatedManager.enqueue); one worker per platform
takes a job, fetches up to LIMIT related tracks with a single listing call,
replaces that song's stored rows, then sleeps POLL_DELAY seconds before
taking the next job. Stored results older than REFETCH_AFTER are refetched
the next time they are asked for.

  - YouTube: the auto-generated "Mix" radio playlist (list=RD<videoId>), read
    flat with yt-dlp. --playlist-end stops yt-dlp's Mix pager after the first
    page. The flat listing has no stats, so YouTube rows have no metrics.
  - SoundCloud: the `soundcloud-v2` library's get_track_related, whose items
    already carry play/like/repost/comment counts.

Every result has the same shape as an /api/search result (id, title, artist,
duration, url, cover, source) plus `rank`, `metrics` and `channel_url`.
"""

import json
import os
import queue
import re
import sqlite3
import subprocess
import threading
import time
from datetime import datetime, timedelta, timezone

YT_ID_RE = re.compile(r'(?:v=|youtu\.be/|/shorts/|/embed/|/live/)([A-Za-z0-9_-]{11})')
YT_COOKIES = os.path.join(os.path.dirname(__file__), '..', 'cookies_youtube.txt')
YT_TIMEOUT = 60                         # seconds per yt-dlp call
LIMIT = 20                              # related tracks stored per song
POLL_DELAY = 30                         # seconds a worker rests after each job
REFETCH_AFTER = timedelta(days=90)      # stored results older than this get refetched
SOURCES = ('youtube', 'soundcloud')


def detect_source(url):
    """Return 'youtube' / 'soundcloud' for a track URL, or None."""
    host = (url or '').lower()
    if 'youtube.com' in host or 'youtu.be' in host:
        return 'youtube'
    if 'soundcloud.com' in host:
        return 'soundcloud'
    return None


def fetch_related(url, source=None):
    """
    Fetch up to LIMIT tracks related to `url` from the platform (network call).

    Raises:
        ValueError: unsupported source or unparseable URL
        RuntimeError: the platform lookup failed
    """
    source = (source or detect_source(url) or '').lower()
    if source == 'youtube':
        return related_youtube(url)
    if source == 'soundcloud':
        return related_soundcloud(url)
    raise ValueError(f'Related tracks are only supported for YouTube and SoundCloud (got {source or url!r})')


# ---------------------------------------------------------------- YouTube

def youtube_video_id(url):
    """Extract the 11-char video id from any common YouTube URL form."""
    match = YT_ID_RE.search(url or '')
    if match:
        return match.group(1)
    raise ValueError(f'Could not find a YouTube video id in {url!r}')


def _yt_dlp_json(args):
    """Run yt-dlp with -J and return the parsed JSON document."""
    cmd = ['yt-dlp', '-J', '--no-warnings', *args]
    if os.path.exists(YT_COOKIES):
        cmd[1:1] = ['--cookies', YT_COOKIES]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=YT_TIMEOUT)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip().splitlines()[-1] if result.stderr.strip() else 'yt-dlp failed')
    return json.loads(result.stdout)


def _best_thumbnail(info):
    thumbs = info.get('thumbnails') or []
    if thumbs:
        best = max(thumbs, key=lambda t: (t.get('width') or 0) * (t.get('height') or 0))
        return best.get('url', '')
    return info.get('thumbnail', '') or ''


def related_youtube(url):
    """Related tracks from the video's YouTube Mix (RD) playlist, one listing call."""
    video_id = youtube_video_id(url)
    mix_url = f'https://www.youtube.com/watch?v={video_id}&list=RD{video_id}'
    # +1: the Mix starts with the seed video itself, which is dropped below.
    mix = _yt_dlp_json(['--flat-playlist', '--playlist-end', str(LIMIT + 1), mix_url])

    entries = [e for e in (mix.get('entries') or []) if e.get('id') and e.get('id') != video_id]
    return [_youtube_result(entry, rank) for rank, entry in enumerate(entries[:LIMIT], start=1)]


def _youtube_result(info, rank):
    vid = info.get('id', '')
    return {
        'id': f'{vid}_youtube',
        'external_id': vid,
        'title': info.get('title') or 'Unknown',
        'artist': info.get('uploader') or info.get('channel') or 'Unknown',
        'duration': int((info.get('duration') or 0) * 1000),
        'url': f'https://www.youtube.com/watch?v={vid}',
        'cover': _best_thumbnail(info),
        'channel_url': info.get('channel_url'),
        'source': 'youtube',
        'rank': rank,
        'metrics': None,
    }


# ------------------------------------------------------------- SoundCloud

def related_soundcloud(url):
    """Related tracks from SoundCloud's own related-tracks endpoint."""
    from soundcloud import SoundCloud
    client = SoundCloud()
    seed = client.resolve(url.split('?')[0])
    if seed is None or getattr(seed, 'kind', None) != 'track':
        raise ValueError(f'{url!r} is not a SoundCloud track')

    results = []
    for track in client.get_track_related(seed.id, limit=LIMIT):
        results.append(_soundcloud_result(track, len(results) + 1))
        if len(results) >= LIMIT:
            break
    return results


def _soundcloud_result(track, rank):
    user = getattr(track, 'user', None)
    cover = getattr(track, 'artwork_url', None) or getattr(user, 'avatar_url', None) or ''
    created = getattr(track, 'created_at', None)
    tag_list = getattr(track, 'tag_list', '') or ''
    return {
        'id': f'{track.id}_soundcloud',
        'external_id': str(track.id),
        'title': getattr(track, 'title', None) or 'Unknown',
        'artist': getattr(user, 'username', None) or 'Unknown',
        'duration': getattr(track, 'duration', 0) or 0,
        'url': getattr(track, 'permalink_url', ''),
        'cover': cover.replace('-large', '-t500x500'),
        'channel_url': getattr(user, 'permalink_url', None),
        'source': 'soundcloud',
        'rank': rank,
        'metrics': _derive_metrics({
            'plays': getattr(track, 'playback_count', None),
            'likes': getattr(track, 'likes_count', None),
            'comments': getattr(track, 'comment_count', None),
            'reposts': getattr(track, 'reposts_count', None),
            'followers': getattr(user, 'followers_count', None),
            'verified': getattr(user, 'verified', None),
            'genre': getattr(track, 'genre', None) or None,
            'tags': re.findall(r'"[^"]+"|\S+', tag_list)[:10],
            'uploaded_at': created.isoformat() if isinstance(created, datetime) else created,
        }),
    }


# ---------------------------------------------------------------- metrics

def _derive_metrics(raw):
    """Add ratios that compare tracks across platforms and ages."""
    plays, likes = raw.get('plays'), raw.get('likes')
    m = dict(raw)
    m['like_ratio'] = round(likes / plays, 4) if plays and likes is not None else None
    m['age_days'] = None
    m['plays_per_day'] = None
    if raw.get('uploaded_at'):
        try:
            uploaded = datetime.fromisoformat(str(raw['uploaded_at']).replace('Z', '+00:00'))
            if uploaded.tzinfo is None:
                uploaded = uploaded.replace(tzinfo=timezone.utc)
            age = max((datetime.now(timezone.utc) - uploaded).days, 1)
            m['age_days'] = age
            m['plays_per_day'] = round(plays / age, 1) if plays is not None else None
        except ValueError:
            pass
    return m


# ---------------------------------------------------------------- storage

def migrate_related_tables(conn):
    """
    Create the related-tracks tables if missing (idempotent).

    related_fetches: one row per seed song — when its related list was last
        fetched successfully, and the last error if a later attempt failed.
    related_tracks: up to LIMIT rows per seed song, replaced on every fetch.
    """
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS related_fetches (
            song_id INTEGER PRIMARY KEY,
            fetched_at TIMESTAMP,
            last_error TEXT,
            attempted_at TIMESTAMP,
            FOREIGN KEY (song_id) REFERENCES songs (id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS related_tracks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            song_id INTEGER NOT NULL,
            rank INTEGER NOT NULL,
            source TEXT NOT NULL,
            external_id TEXT NOT NULL,
            url TEXT NOT NULL,
            title TEXT,
            artist TEXT,
            duration_ms INTEGER,
            cover TEXT,
            channel_url TEXT,
            metrics TEXT,
            fetched_at TIMESTAMP NOT NULL,
            UNIQUE (song_id, source, external_id),
            FOREIGN KEY (song_id) REFERENCES songs (id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_related_tracks_song ON related_tracks (song_id, rank);
        CREATE INDEX IF NOT EXISTS idx_related_tracks_url ON related_tracks (url);
    ''')
    conn.commit()


def _now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def load_related(conn, song_id):
    """
    Stored related tracks for a song.

    Returns:
        (fetch_row or None, [result dicts in rank order])
    """
    fetch = conn.execute('SELECT * FROM related_fetches WHERE song_id = ?', (song_id,)).fetchone()
    rows = conn.execute(
        'SELECT * FROM related_tracks WHERE song_id = ? ORDER BY rank', (song_id,)
    ).fetchall()
    results = [{
        'id': f"{row['external_id']}_{row['source']}",
        'external_id': row['external_id'],
        'title': row['title'],
        'artist': row['artist'],
        'duration': row['duration_ms'] or 0,
        'url': row['url'],
        'cover': row['cover'] or '',
        'channel_url': row['channel_url'],
        'source': row['source'],
        'rank': row['rank'],
        'metrics': json.loads(row['metrics']) if row['metrics'] else None,
    } for row in rows]
    return fetch, results


def is_stale(fetch_row):
    """True when a song has never been fetched successfully, or not within REFETCH_AFTER."""
    if not fetch_row or not fetch_row['fetched_at']:
        return True
    fetched = datetime.fromisoformat(fetch_row['fetched_at'])
    if fetched.tzinfo is None:
        fetched = fetched.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - fetched > REFETCH_AFTER


def _store_results(conn, song_id, results):
    now = _now()
    conn.execute('DELETE FROM related_tracks WHERE song_id = ?', (song_id,))
    conn.executemany('''
        INSERT OR IGNORE INTO related_tracks
            (song_id, rank, source, external_id, url, title, artist, duration_ms,
             cover, channel_url, metrics, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', [(song_id, r['rank'], r['source'], r['external_id'], r['url'], r['title'], r['artist'],
           r['duration'], r['cover'], r['channel_url'],
           json.dumps(r['metrics']) if r['metrics'] is not None else None, now)
          for r in results])
    conn.execute('''
        INSERT INTO related_fetches (song_id, fetched_at, last_error, attempted_at)
        VALUES (?, ?, NULL, ?)
        ON CONFLICT(song_id) DO UPDATE SET fetched_at = excluded.fetched_at,
            last_error = NULL, attempted_at = excluded.attempted_at
    ''', (song_id, now, now))
    conn.commit()


def _store_error(conn, song_id, error):
    """Record a failed attempt; keeps any earlier successful results and fetched_at."""
    conn.execute('''
        INSERT INTO related_fetches (song_id, last_error, attempted_at) VALUES (?, ?, ?)
        ON CONFLICT(song_id) DO UPDATE SET last_error = excluded.last_error,
            attempted_at = excluded.attempted_at
    ''', (song_id, error, _now()))
    conn.commit()


# ---------------------------------------------------------------- queue

class RelatedManager:
    """
    One queue + one worker thread per platform for related-track lookups.

    Each worker handles one job at a time and rests POLL_DELAY seconds after
    every job, so each platform sees at most one related lookup per ~30s.
    Jobs are deduplicated: a song already queued or being fetched is not
    queued again. Completion is announced with a 'related_updated' event.
    """

    def __init__(self, db_path, socketio=None):
        self.db_path = db_path
        self.socketio = socketio
        self.queues = {source: queue.Queue() for source in SOURCES}
        self.pending = {source: [] for source in SOURCES}   # song ids, queue order
        self.active = {source: None for source in SOURCES}  # song id being fetched
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.event_queue = queue.Queue()
        self.threads = []
        # Called with the song id after every finished lookup (ok or failed),
        # from the worker thread once the job no longer counts as active.
        self.on_finished = None

    def start(self):
        """Start one worker thread per platform (idempotent)."""
        if self.threads:
            return
        for source in SOURCES:
            thread = threading.Thread(target=self._worker, args=(source,), daemon=True,
                                      name=f'RelatedWorker-{source}')
            thread.start()
            self.threads.append(thread)

    def stop(self):
        self.stop_event.set()

    def enqueue(self, song_id, source, url):
        """
        Queue a related lookup for a library song unless one is already pending.

        Returns:
            bool: True if newly queued, False if it was already queued/running
        """
        source = (source or '').lower()
        if source not in self.queues:
            raise ValueError(f'Related tracks are only supported for YouTube and SoundCloud (got {source!r})')
        with self.lock:
            if song_id in self.pending[source] or self.active[source] == song_id:
                return False
            self.pending[source].append(song_id)
        self.queues[source].put((song_id, url))
        return True

    def job_status(self, song_id, source):
        """
        Where a song is in its platform's queue.

        Returns:
            dict | None: {'state': 'fetching'} or {'state': 'queued', 'position': n}
            (position 1 = next up), or None if not queued
        """
        source = (source or '').lower()
        with self.lock:
            if self.active.get(source) == song_id:
                return {'state': 'fetching'}
            pending = self.pending.get(source, [])
            if song_id in pending:
                return {'state': 'queued', 'position': pending.index(song_id) + 1}
        return None

    def process_events(self):
        """Emit queued WebSocket events (called from the app's event loop thread)."""
        while True:
            try:
                event_type, data = self.event_queue.get_nowait()
            except queue.Empty:
                break
            if self.socketio:
                try:
                    self.socketio.emit(event_type, data)
                except Exception as e:
                    print(f'[Related] Error emitting {event_type}: {e}')

    def _worker(self, source):
        while not self.stop_event.is_set():
            try:
                song_id, url = self.queues[source].get(timeout=1)
            except queue.Empty:
                continue
            with self.lock:
                if song_id in self.pending[source]:
                    self.pending[source].remove(song_id)
                self.active[source] = song_id
            try:
                self._run_job(source, song_id, url)
            finally:
                with self.lock:
                    self.active[source] = None
                self.queues[source].task_done()
            if self.on_finished:
                try:
                    self.on_finished(song_id)
                except Exception as e:
                    print(f'[Related] on_finished hook failed for song {song_id}: {e}')
            self.stop_event.wait(POLL_DELAY)

    def _run_job(self, source, song_id, url):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            try:
                results = fetch_related(url, source)
            except Exception as e:
                print(f'[Related] {source} lookup failed for song {song_id}: {e}')
                _store_error(conn, song_id, str(e))
                self.event_queue.put(('related_updated', {'song_id': song_id, 'status': 'error', 'error': str(e)}))
                return
            _store_results(conn, song_id, results)
            print(f'[Related] Stored {len(results)} {source} related tracks for song {song_id}')
            self.event_queue.put(('related_updated', {'song_id': song_id, 'status': 'ready', 'count': len(results)}))
        finally:
            conn.close()
