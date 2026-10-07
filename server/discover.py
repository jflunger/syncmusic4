"""
Discover: one candidate track at a time, drawn from the related tracks of a
random "seed" song, pre-downloaded so it is ready to play, then rated.

Drawing a candidate (DiscoverManager._advance):
  1. Seed: a uniformly random song from all of the user's Play-tab feeder
     playlists combined (not the queue's random-playlist-then-random-song
     pick). Only YouTube/SoundCloud songs can seed, since only they have
     related tracks.
  2. If the seed's related tracks were never fetched, a lookup is queued on the
     RelatedManager and the candidate waits ('fetching_related'); the lookup
     finishing (on_related_finished) resumes the draw with the same seed.
  3. Candidate: the seed's first related track (rank order) that the user has
     not rated or put in one of their playlists (a playlist song counts as a
     like; both are matched on URL and on title, so a re-upload of the same
     track is skipped too), that is not already in the library, that has not failed to
     download before and that isn't the user's other candidate. A seed with
     none left is replaced by another random seed.
  4. The candidate is downloaded through the normal DownloadManager, flagged
     with 'discover_owner' so the file lands in static/audio but no songs row is
     written ('downloading' → 'ready').

Each user has two candidate slots: 'current' (shown and rated) and 'next'
(drawn and downloaded in the background as soon as the current one is ready,
so the following track is usually ready the moment the current one is rated).
When the current candidate goes away, the next one is promoted in its place.

Rating (rate): 'like' moves the file into the library as a normal song,
'dislike' deletes the file. Either way the rating is stored in track_ratings
(keyed on the track URL, so a track reached through another seed is never
suggested again) and the next candidate takes over. redraw() discards the
current candidate without recording a rating.

A liked track may keep playing in the client's preview after the like (the
client shows the next candidate only when asked). Since the library move
renames the file, the old name is kept as a hard link until the user's next
rate/redraw.

Candidates are stored in discover_candidates so they survive restarts.
Changes are announced with a 'discover_updated' event carrying the owner;
clients refetch their own state.
"""

import json
import os
import queue
import sqlite3
import threading
from datetime import datetime, timezone

import related_tracks

MAX_SEEDS_PER_DRAW = 12   # seeds tried in one draw before giving up
SLOTS = ('current', 'next')

_CANDIDATES_SQL = '''
    CREATE TABLE IF NOT EXISTS discover_candidates (
        owner TEXT NOT NULL,
        slot TEXT NOT NULL DEFAULT 'current',
        seed_song_id INTEGER,
        status TEXT NOT NULL,
        url TEXT,
        source TEXT,
        title TEXT,
        artist TEXT,
        cover TEXT,
        duration_ms INTEGER,
        metrics TEXT,
        file_path TEXT,
        error TEXT,
        updated_at TIMESTAMP NOT NULL,
        PRIMARY KEY (owner, slot)
    );
'''


def migrate_discover_tables(conn):
    """
    Create the discover tables if missing (idempotent).

    track_ratings: a user's like/dislike per track URL (permanent).
    discover_candidates: each user's current and next candidate and their progress.
    discover_failures: track URLs whose candidate download failed, skipped
        in later draws for every user.
    """
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS track_ratings (
            owner TEXT NOT NULL,
            url TEXT NOT NULL,
            source TEXT,
            title TEXT,
            artist TEXT,
            rating TEXT NOT NULL CHECK (rating IN ('like', 'dislike')),
            seed_song_id INTEGER,
            rated_at TIMESTAMP NOT NULL,
            PRIMARY KEY (owner, url)
        );
        CREATE TABLE IF NOT EXISTS discover_failures (
            url TEXT PRIMARY KEY,
            error TEXT,
            failed_at TIMESTAMP NOT NULL
        );
    ''')
    columns = [r[1] for r in conn.execute('PRAGMA table_info(discover_candidates)').fetchall()]
    if columns and 'slot' not in columns:
        # First version keyed candidates on owner alone: rebuild with a slot,
        # keeping existing candidates as each user's current one.
        conn.execute('ALTER TABLE discover_candidates RENAME TO discover_candidates_old')
        conn.executescript(_CANDIDATES_SQL)
        conn.execute('''
            INSERT INTO discover_candidates
                (owner, slot, seed_song_id, status, url, source, title, artist, cover,
                 duration_ms, metrics, file_path, error, updated_at)
            SELECT owner, 'current', seed_song_id, status, url, source, title, artist, cover,
                   duration_ms, metrics, file_path, error, updated_at
            FROM discover_candidates_old
        ''')
        conn.execute('DROP TABLE discover_candidates_old')
    else:
        conn.executescript(_CANDIDATES_SQL)
    conn.commit()


def _now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


MIN_TITLE_KEY = 8   # shorter normalized titles ("Down", "E.T.") are too ambiguous to match on


def _url_key(url):
    """A track URL reduced to its identity: YouTube video id, else host+path without query/case/slash."""
    match = related_tracks.YT_ID_RE.search(url or '')
    if match and 'youtu' in url:
        return 'yt:' + match.group(1)
    url = (url or '').split('#')[0].split('?')[0].lower().rstrip('/')
    for prefix in ('https://', 'http://', 'www.', 'm.'):
        url = url.removeprefix(prefix)
    return url


def _title_key(title):
    """A title reduced to lowercase letters/digits, or None if too short to identify a track."""
    key = ''.join(ch for ch in (title or '').lower() if ch.isalnum())
    return key if len(key) >= MIN_TITLE_KEY else None


def _known_tracks(conn, owner):
    """
    Tracks the user already has an opinion on: every song in one of their
    playlists (which counts as a like) plus every rated track.

    Returns:
        (set of URL keys, set of title keys) — title keys catch re-uploads of
        the same track under another URL.
    """
    rows = conn.execute('''
        SELECT s.download_link AS url, s.title FROM songs s
        JOIN playlist_songs ps ON ps.song_id = s.id
        JOIN playlists p ON p.id = ps.playlist_id
        WHERE p.owner = ?
        UNION
        SELECT url, title FROM track_ratings WHERE owner = ?
    ''', (owner, owner)).fetchall()
    urls = {_url_key(r['url']) for r in rows if r['url']}
    titles = {key for key in (_title_key(r['title']) for r in rows) if key}
    return urls, titles


class DiscoverManager:
    """
    Draws, downloads and rates discover candidates (see module docstring).

    All state changes go through self.lock: they are triggered both by
    requests and by the download/related worker threads.
    """

    def __init__(self, db_path, download_manager, related_manager):
        self.db_path = db_path
        self.downloads = download_manager
        self.related = related_manager
        self.lock = threading.RLock()
        self.event_queue = queue.Queue()
        # owner -> (alias, library path): a just-liked candidate's old file name, hard-linked to
        # the renamed library file so a preview still streaming it keeps working until the
        # user's next rate/redraw.
        self.liked_aliases = {}

    def _connect(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    # ------------------------------------------------------------ public

    def get_state(self, owner):
        """
        The user's current candidate as a JSON-ready dict, drawing one if there
        is none and nudging candidates whose background work was lost (e.g. a
        restart dropped the download or related queue).
        """
        with self.lock:
            conn = self._connect()
            try:
                for slot in SLOTS:
                    row = self._candidate(conn, owner, slot)
                    if row is not None:
                        self._recover(conn, row)
                if self._candidate(conn, owner) is None:
                    self._fill_current(conn, owner)
                self._ensure_next(conn, owner)
                return self._state(conn, owner)
            finally:
                conn.close()

    def rate(self, owner, url, rating):
        """
        Rate the current candidate and move on to the next one.

        Args:
            url: the candidate URL the client rated (guards against rating a
                candidate that changed underneath it)
            rating: 'like' (requires the download to be ready) or 'dislike'

        Raises:
            ValueError: bad rating, stale url, or liking an unfinished download
        """
        if rating not in ('like', 'dislike'):
            raise ValueError("rating must be 'like' or 'dislike'")
        with self.lock:
            conn = self._connect()
            try:
                row = self._candidate(conn, owner)
                if row is None or not row['url'] or row['url'] != url:
                    raise ValueError('That candidate is no longer current')
                if rating == 'like' and row['status'] != 'ready':
                    raise ValueError('The candidate is not downloaded yet')

                self._drop_liked_alias(owner)
                song_id = None
                if rating == 'like':
                    song_id = self._add_to_library(owner, row)
                else:
                    self._delete_file(conn, row['file_path'])

                conn.execute('''
                    INSERT INTO track_ratings (owner, url, source, title, artist, rating, seed_song_id, rated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(owner, url) DO UPDATE SET rating = excluded.rating,
                        seed_song_id = excluded.seed_song_id, rated_at = excluded.rated_at
                ''', (owner, row['url'], row['source'], row['title'], row['artist'],
                      rating, row['seed_song_id'], _now()))
                self._remove(conn, owner, 'current')

                self._fill_current(conn, owner)
                self._ensure_next(conn, owner)
                state = self._state(conn, owner)
                state['added_song_id'] = song_id
                return state
            finally:
                conn.close()

    def redraw(self, owner):
        """Discard the current candidate without rating it and move on to the next one."""
        with self.lock:
            self._drop_liked_alias(owner)
            conn = self._connect()
            try:
                row = self._candidate(conn, owner)
                skip = None
                if row is not None:
                    skip = row['url']
                    self._delete_file(conn, row['file_path'])
                    self._remove(conn, owner, 'current')
                self._fill_current(conn, owner, skip_url=skip)
                self._ensure_next(conn, owner)
                return self._state(conn, owner)
            finally:
                conn.close()

    def process_events(self):
        """Emit queued 'discover_updated' events (called from the app's event loop thread)."""
        socketio = self.downloads.socketio
        while True:
            try:
                event_type, data = self.event_queue.get_nowait()
            except queue.Empty:
                break
            if socketio:
                try:
                    socketio.emit(event_type, data)
                except Exception as e:
                    print(f'[Discover] Error emitting {event_type}: {e}')

    # ----------------------------------------- hooks from worker threads

    def on_related_finished(self, song_id):
        """A related lookup finished (ok or not): resume draws waiting on that seed."""
        with self.lock:
            conn = self._connect()
            try:
                waiting = conn.execute(
                    "SELECT owner, slot FROM discover_candidates WHERE status = 'fetching_related' AND seed_song_id = ?",
                    (song_id,)).fetchall()
                for r in waiting:
                    self._remove(conn, r['owner'], r['slot'])
                    self._advance(conn, r['owner'], r['slot'], seed_id=song_id)
                    self._ensure_next(conn, r['owner'])
            finally:
                conn.close()

    def still_wanted(self, song_data):
        """False when a queued candidate download was redrawn/rated away before it started."""
        conn = self._connect()
        try:
            return self._row_for_url(conn, song_data['discover_owner'], song_data['download_link'],
                                     'downloading') is not None
        finally:
            conn.close()

    def download_finished(self, song_data, file_path):
        """
        A candidate download landed in static/audio. Attach it to its candidate,
        or delete it if the candidate moved on meanwhile. A ready current
        candidate kicks off the next one's draw and download.

        Returns:
            str | None: the kept file path (None if discarded)
        """
        owner = song_data['discover_owner']
        with self.lock:
            conn = self._connect()
            try:
                row = self._row_for_url(conn, owner, song_data['download_link'], 'downloading')
                if row is None:
                    self._delete_file(conn, file_path)
                    return None
                conn.execute(
                    "UPDATE discover_candidates SET status = 'ready', file_path = ?, error = NULL, updated_at = ? "
                    "WHERE owner = ? AND slot = ?",
                    (file_path, _now(), owner, row['slot']))
                conn.commit()
                self._notify(owner)
                self._ensure_next(conn, owner)
                return file_path
            finally:
                conn.close()

    def download_failed(self, song_data, reason):
        """A candidate download failed: remember the track as undownloadable and draw another."""
        owner = song_data['discover_owner']
        url = song_data['download_link']
        with self.lock:
            conn = self._connect()
            try:
                conn.execute(
                    'INSERT OR REPLACE INTO discover_failures (url, error, failed_at) VALUES (?, ?, ?)',
                    (url, reason or 'download failed', _now()))
                conn.commit()
                row = self._row_for_url(conn, owner, url)
                if row is None:
                    return
                print(f"[Discover] {row['slot']} candidate download failed for {owner} ({reason}): {url} — drawing another")
                self._remove(conn, owner, row['slot'])
                self._advance(conn, owner, row['slot'], seed_id=row['seed_song_id'])
                self._ensure_next(conn, owner)
            finally:
                conn.close()

    # ---------------------------------------------------------- drawing

    def _fill_current(self, conn, owner, skip_url=None):
        """Give the user a current candidate: promote the next one, or draw a fresh one."""
        nxt = self._candidate(conn, owner, 'next')
        if nxt is not None and nxt['status'] != 'error':
            conn.execute("UPDATE discover_candidates SET slot = 'current' WHERE owner = ? AND slot = 'next'", (owner,))
            conn.commit()
            self._notify(owner)
            return
        if nxt is not None:
            self._remove(conn, owner, 'next')
        self._advance(conn, owner, 'current', skip_url=skip_url)

    def _ensure_next(self, conn, owner):
        """Draw (and start downloading) the next candidate once the current one is ready."""
        current = self._candidate(conn, owner)
        if current is None or current['status'] != 'ready':
            return
        if self._candidate(conn, owner, 'next') is None:
            self._advance(conn, owner, 'next')

    def _advance(self, conn, owner, slot, seed_id=None, skip_url=None):
        """
        Draw a new candidate into an empty `slot`. Tries `seed_id` first when
        given, then random seeds. Leaves exactly one row in the slot:
        'fetching_related', 'downloading' or 'error'.
        """
        exclude_urls = {r['url'] for r in conn.execute(
            'SELECT url FROM discover_candidates WHERE owner = ? AND url IS NOT NULL', (owner,)).fetchall()}
        if skip_url:
            exclude_urls.add(skip_url)

        tried = set()
        for _ in range(MAX_SEEDS_PER_DRAW):
            seed = self._seed(conn, owner, seed_id, tried)
            seed_id = None
            if seed is None:
                break
            tried.add(seed['id'])

            fetch = conn.execute('SELECT * FROM related_fetches WHERE song_id = ?', (seed['id'],)).fetchone()
            if not fetch or not fetch['fetched_at']:
                if fetch and fetch['last_error'] and not self.related.job_status(seed['id'], seed['source']):
                    continue  # lookup already failed for this seed; try another
                self.related.enqueue(seed['id'], seed['source'], seed['download_link'])
                self._save(conn, owner, slot, seed['id'], 'fetching_related')
                return

            track = self._first_unrated(conn, owner, seed['id'], exclude_urls)
            if track is None:
                continue
            self._save(conn, owner, slot, seed['id'], 'downloading', track)
            self._start_download(conn, owner, slot, track)
            return

        if not tried:
            error = 'No seed songs: mark playlists as feeders on the Play tab (YouTube/SoundCloud tracks only).'
        else:
            error = 'No unrated related tracks found for the seeds tried — try Redraw.'
        self._save(conn, owner, slot, None, 'error', error=error)

    def _seed(self, conn, owner, seed_id, exclude):
        """The given seed song, or a uniformly random song from the user's feeder playlists."""
        if seed_id is not None:
            row = conn.execute('SELECT id, LOWER(source) AS source, download_link FROM songs WHERE id = ?',
                               (seed_id,)).fetchone()
            if row and (row['source'] or '').lower() in related_tracks.SOURCES:
                return row
        placeholders = ','.join('?' * len(related_tracks.SOURCES))
        excluded = ','.join('?' * len(exclude))
        return conn.execute(f'''
            SELECT DISTINCT s.id, LOWER(s.source) AS source, s.download_link
            FROM play_feeders pf
            JOIN playlists p ON p.id = pf.playlist_id AND p.owner = pf.owner
            JOIN playlist_songs ps ON ps.playlist_id = pf.playlist_id
            JOIN songs s ON s.id = ps.song_id
            WHERE pf.owner = ? AND LOWER(s.source) IN ({placeholders})
              AND s.download_link IS NOT NULL AND s.download_link != ''
              {f'AND s.id NOT IN ({excluded})' if exclude else ''}
            ORDER BY RANDOM() LIMIT 1
        ''', (owner, *related_tracks.SOURCES, *exclude)).fetchone()

    def _first_unrated(self, conn, owner, seed_id, exclude_urls):
        """
        The seed's first related track the user hasn't rated or put in a
        playlist (matched on URL or title, see _known_tracks), that isn't in
        the library, known-broken or excluded.
        """
        _, results = related_tracks.load_related(conn, seed_id)
        known_urls, known_titles = _known_tracks(conn, owner)
        for track in results:
            url = track['url']
            if not url or url in exclude_urls:
                continue
            if _url_key(url) in known_urls or _title_key(track['title']) in known_titles:
                continue
            if conn.execute('SELECT 1 FROM songs WHERE download_link = ?', (url,)).fetchone():
                continue
            if conn.execute('SELECT 1 FROM discover_failures WHERE url = ?', (url,)).fetchone():
                continue
            return track
        return None

    def _start_download(self, conn, owner, slot, track):
        """Queue the candidate on the normal download pipeline (flagged so it skips the library)."""
        queued = self.downloads.add_download({
            'source': track['source'],
            'download_link': track['url'],
            'title': track['title'],
            'artist': track['artist'],
            'cover': track['cover'],
            'discover_owner': owner,
        })
        if not queued:
            # Already queued as a normal library download (the only duplicate case
            # left, since library tracks are never candidates).
            self._save(conn, owner, slot, None, 'error',
                       error='This track is already being downloaded to the library — try Redraw.')

    def _recover(self, conn, row):
        """Restart background work a restart (or lost event) left a candidate waiting on."""
        owner, slot, status = row['owner'], row['slot'], row['status']
        if status == 'fetching_related':
            seed = conn.execute('SELECT LOWER(source) AS source, download_link FROM songs WHERE id = ?',
                                (row['seed_song_id'],)).fetchone()
            if seed is None or not self.related.job_status(row['seed_song_id'], seed['source']):
                fetch = conn.execute('SELECT * FROM related_fetches WHERE song_id = ?', (row['seed_song_id'],)).fetchone()
                if seed is not None and not (fetch and (fetch['fetched_at'] or fetch['last_error'])):
                    self.related.enqueue(row['seed_song_id'], seed['source'], seed['download_link'])
                    return
                self._remove(conn, owner, slot)
                self._advance(conn, owner, slot, seed_id=row['seed_song_id'] if seed else None)
        elif status == 'downloading' and not self._download_pending(row['source'], row['url']):
            self._start_download(conn, owner, slot, dict(row))
        elif status == 'ready' and not (row['file_path'] and os.path.isfile(row['file_path'])):
            conn.execute("UPDATE discover_candidates SET status = 'downloading', file_path = NULL "
                         "WHERE owner = ? AND slot = ?", (owner, slot))
            conn.commit()
            self._start_download(conn, owner, slot, dict(row))

    def _download_pending(self, source, url):
        """True if the URL is waiting in, or being fetched by, the download manager."""
        if any(item.get('download_link') == url for item in list(self.downloads.queues.get(source, queue.Queue()).queue)):
            return True
        active = self.downloads.current_downloads.get(source)
        return bool(active and active.get('url') == url)

    # ---------------------------------------------------------- storage

    def _candidate(self, conn, owner, slot='current'):
        return conn.execute('SELECT * FROM discover_candidates WHERE owner = ? AND slot = ?',
                            (owner, slot)).fetchone()

    def _row_for_url(self, conn, owner, url, status=None):
        """The user's candidate (either slot) for a track URL, optionally only in a given status."""
        row = conn.execute('SELECT * FROM discover_candidates WHERE owner = ? AND url = ?', (owner, url)).fetchone()
        if row is None or (status and row['status'] != status):
            return None
        return row

    def _remove(self, conn, owner, slot):
        conn.execute('DELETE FROM discover_candidates WHERE owner = ? AND slot = ?', (owner, slot))
        conn.commit()

    def _save(self, conn, owner, slot, seed_id, status, track=None, error=None):
        """Replace one of the user's candidate slots and announce the change."""
        track = track or {}
        conn.execute('''
            INSERT OR REPLACE INTO discover_candidates
                (owner, slot, seed_song_id, status, url, source, title, artist, cover,
                 duration_ms, metrics, file_path, error, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        ''', (owner, slot, seed_id, status, track.get('url'), track.get('source'), track.get('title'),
              track.get('artist'), track.get('cover'), track.get('duration') or track.get('duration_ms'),
              json.dumps(track['metrics']) if track.get('metrics') is not None else None,
              error, _now()))
        conn.commit()
        self._notify(owner)

    def _notify(self, owner):
        self.event_queue.put(('discover_updated', {'owner': owner}))

    def _delete_file(self, conn, path):
        """Delete a candidate's audio file unless a library song points at it."""
        if not path or not os.path.isfile(path):
            return
        if conn.execute('SELECT 1 FROM songs WHERE file_path = ?', (path,)).fetchone():
            return
        try:
            os.remove(path)
        except OSError as e:
            print(f'[Discover] Could not delete {path}: {e}')

    def _add_to_library(self, owner, row):
        """
        Turn a ready candidate into a normal library song. Returns the new song id.
        The candidate's file name is kept as a hard link (see liked_aliases).
        """
        stored = self.downloads._add_to_database({
            'source': row['source'],
            'download_link': row['url'],
            'title': row['title'],
            'artist': row['artist'],
            'cover': row['cover'],
            'added_by': owner,
            'added_via': 'like',
        }, row['file_path'])
        if not stored:
            raise ValueError('Could not add the track to the library')
        old = row['file_path']
        if old and old != stored and not os.path.exists(old):
            try:
                os.link(stored, old)
                self.liked_aliases[owner] = (old, stored)
            except OSError as e:
                print(f'[Discover] Could not keep {old} for the liked preview: {e}')
        conn = self._connect()
        try:
            song = conn.execute('SELECT id FROM songs WHERE file_path = ?', (stored,)).fetchone()
            return song['id'] if song else None
        finally:
            conn.close()

    def _drop_liked_alias(self, owner):
        """Remove the user's liked-preview hard link, unless the name now holds another file."""
        alias, target = self.liked_aliases.pop(owner, (None, None))
        if not alias:
            return
        try:
            if os.path.isfile(target) and os.path.samefile(alias, target):
                os.remove(alias)
        except OSError as e:
            print(f'[Discover] Could not remove liked alias {alias}: {e}')

    def _state(self, conn, owner):
        """JSON-ready view of the user's current candidate, its seed, and the next candidate's progress."""
        row = self._candidate(conn, owner)
        nxt = self._candidate(conn, owner, 'next')
        next_info = {'status': nxt['status'], 'title': nxt['title'], 'artist': nxt['artist']} if nxt else None
        if row is None:
            return {'status': 'empty', 'seed': None, 'track': None, 'next': next_info}
        seed = None
        if row['seed_song_id'] is not None:
            s = conn.execute('SELECT id, title, artist, cover, source FROM songs WHERE id = ?',
                             (row['seed_song_id'],)).fetchone()
            if s:
                seed = dict(s)
                seed['related_job'] = self.related.job_status(s['id'], (s['source'] or '').lower())
        track = None
        if row['url']:
            track = {
                'url': row['url'],
                'source': row['source'],
                'title': row['title'],
                'artist': row['artist'],
                'cover': row['cover'] or '',
                'duration': row['duration_ms'] or 0,
                'metrics': json.loads(row['metrics']) if row['metrics'] else None,
                'audio_url': f"/audio/{os.path.basename(row['file_path'])}"
                             if row['status'] == 'ready' and row['file_path'] else None,
            }
        return {'status': row['status'], 'seed': seed, 'track': track, 'error': row['error'], 'next': next_info}
