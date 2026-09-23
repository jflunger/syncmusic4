"""
Flask server for SyncMusic4 streaming application.
"""

from flask import Flask, send_from_directory, jsonify, make_response, request, session
from flask_cors import CORS
import os
import json
import sys
import mimetypes
import traceback
import sqlite3
import secrets
import hmac
from datetime import datetime, timedelta, timezone

# Add server directory to path for imports
sys.path.insert(0, os.path.dirname(__file__))

app = Flask(__name__)
# CORS with credentials so the session cookie is honored on cross-origin XHR.
CORS(app, supports_credentials=True)

# --- Authentication -------------------------------------------------------
# Fixed accounts (registration is closed). Plaintext is acceptable here: a
# self-hosted app with three known users, not a public service.
USERS = {
    'pubert': '***REMOVED***',
    'user2': 'passwordx',
    'user3': 'passwordx',
}

def _load_secret_key():
    """Load a stable signing key so sessions survive restarts/deploys."""
    key_path = os.path.join(app.root_path, 'secret_key.txt')
    if os.path.exists(key_path):
        with open(key_path, 'r') as f:
            key = f.read().strip()
            if key:
                return key
    key = secrets.token_hex(32)
    with open(key_path, 'w') as f:
        f.write(key)
    return key

def _load_admin_key():
    """Load (or create) the shared secret that guards /api/admin/*.

    Kept in the repo root next to cookies.txt/credentials.json — not under
    server/ — because deploy.sh ships it as its own item, so the same key
    exists on this machine and on the server and `./deploy.sh restart` can
    present it without an extra lookup.
    """
    key_path = os.path.join(os.path.dirname(__file__), '..', 'admin_key.txt')
    if os.path.exists(key_path):
        with open(key_path, 'r') as f:
            key = f.read().strip()
            if key:
                return key
    key = secrets.token_hex(32)
    with open(key_path, 'w') as f:
        f.write(key)
    print(f"[Admin] generated a new admin key at {os.path.abspath(key_path)}")
    return key

ADMIN_KEY = _load_admin_key()

# Exit code start.sh's supervisor loop reads as "come straight back up".
# Anything else non-zero it treats as a crash (restart after a pause), and 0 or
# 130 (Ctrl-C) as a deliberate stop.
RESTART_EXIT_CODE = 42

app.secret_key = _load_secret_key()
# Keep users logged in for a year and refresh the cookie on each request so the
# expiry keeps sliding forward as long as they use the app.
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=365)
app.config['SESSION_REFRESH_EACH_REQUEST'] = True

def current_user():
    """Return the logged-in username, or None."""
    return session.get('user')

def playlist_owned_by(conn, playlist_id, user):
    """True if the playlist exists and belongs to the given user."""
    row = conn.execute(
        'SELECT 1 FROM playlists WHERE id = ? AND owner = ?',
        (playlist_id, user)
    ).fetchone()
    return row is not None

def yt_dlp_cookie_args(source):
    """
    Return yt-dlp --cookies args for the given feeder source, or [].

    YouTube blocks unauthenticated requests with a "confirm you're not a bot"
    check, which also breaks playlist metadata extraction during feeder sync.
    Reuse the same repo-root cookies_youtube.txt that download_manager.py uses
    for YouTube downloads. Spotify's cookies.txt is NOT valid here.
    """
    if source != 'youtube':
        return []
    yt_cookies = os.path.join(os.path.dirname(__file__), '..', 'cookies_youtube.txt')
    if os.path.exists(yt_cookies):
        return ['--cookies', yt_cookies]
    print("[Sync] WARNING: no cookies_youtube.txt found; "
          "YouTube may reject playlist extraction as a bot")
    return []

# Database setup
DB_PATH = os.path.join(app.root_path, 'music.db')

def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    """Initialize database tables if they don't exist."""
    conn = get_db_connection()
    cursor = conn.cursor()

    # Create songs table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS songs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            artist TEXT NOT NULL,
            cover TEXT,
            source TEXT NOT NULL,
            download_link TEXT NOT NULL,
            file_path TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # Create playlists table (owner ties each playlist to an account)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS playlists (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            owner TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # Create playlist_songs table for many-to-many relationship
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS playlist_songs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            playlist_id INTEGER NOT NULL,
            song_id INTEGER NOT NULL,
            position INTEGER NOT NULL,
            FOREIGN KEY (playlist_id) REFERENCES playlists (id) ON DELETE CASCADE,
            FOREIGN KEY (song_id) REFERENCES songs (id) ON DELETE CASCADE,
            UNIQUE(playlist_id, song_id)
        )
    ''')

    # Create queue table for playback queue persistence (per-account)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            song_id INTEGER NOT NULL,
            position INTEGER NOT NULL,
            owner TEXT NOT NULL,
            FOREIGN KEY (song_id) REFERENCES songs (id) ON DELETE CASCADE,
            UNIQUE(owner, position)
        )
    ''')

    # Create feeder_playlists table for imported YouTube/SoundCloud playlists
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS feeder_playlists (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            playlist_id INTEGER NOT NULL,
            url TEXT NOT NULL,
            name TEXT,
            thumbnail TEXT,
            source TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (playlist_id) REFERENCES playlists (id) ON DELETE CASCADE
        )
    ''')

    # Create play_feeders table: per-account set of the user's own playlists that
    # act as fallback sources on the Play tab. When the playback queue is exhausted,
    # a feeder playlist is chosen at random and a random song is drawn from it.
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS play_feeders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner TEXT NOT NULL,
            playlist_id INTEGER NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (playlist_id) REFERENCES playlists (id) ON DELETE CASCADE,
            UNIQUE(owner, playlist_id)
        )
    ''')

    # Create play_history table: per-account list of recently played songs, most
    # recent first (position 0). Capped at 100 rows per user by the writer.
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS play_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            song_id INTEGER NOT NULL,
            position INTEGER NOT NULL,
            owner TEXT NOT NULL,
            FOREIGN KEY (song_id) REFERENCES songs (id) ON DELETE CASCADE,
            UNIQUE(owner, position)
        )
    ''')

    # Create playback_state table: one row per account holding the currently
    # loaded song and how far into it (seconds) so a reload resumes in place.
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS playback_state (
            owner TEXT PRIMARY KEY,
            song_id INTEGER,
            position REAL NOT NULL DEFAULT 0,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (song_id) REFERENCES songs (id) ON DELETE CASCADE
        )
    ''')

    # Create listens table: an append-only log of "a user actually listened to
    # this track" events (>= LISTEN_THRESHOLD_SECONDS of playback). Rows are never
    # updated, only appended, so row id order is listen order. This is what the
    # evergreens ranking reads.
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS listens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner TEXT NOT NULL,
            song_id INTEGER NOT NULL,
            seconds REAL,
            listened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (song_id) REFERENCES songs (id) ON DELETE CASCADE
        )
    ''')
    # Scoring only ever walks one user's most recent listens, newest first.
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_listens_owner_id ON listens (owner, id DESC)')

    # Create sync_items table for tracking sync/download progress per playlist
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS sync_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            playlist_id INTEGER NOT NULL,
            download_link TEXT NOT NULL,
            title TEXT,
            artist TEXT,
            source TEXT NOT NULL,
            cover TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            song_id INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (playlist_id) REFERENCES playlists (id) ON DELETE CASCADE,
            FOREIGN KEY (song_id) REFERENCES songs (id) ON DELETE SET NULL
        )
    ''')

    conn.commit()
    conn.close()

def migrate_add_start_end_time():
    """Add start_time and end_time columns to songs table if they don't exist."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("PRAGMA table_info(songs)")
    columns = [row[1] for row in cursor.fetchall()]
    if 'start_time' not in columns:
        cursor.execute('ALTER TABLE songs ADD COLUMN start_time REAL')
    if 'end_time' not in columns:
        cursor.execute('ALTER TABLE songs ADD COLUMN end_time REAL')
    conn.commit()
    conn.close()

def migrate_add_playlist_description():
    """Add description column to playlists table if it doesn't exist."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("PRAGMA table_info(playlists)")
    columns = [row[1] for row in cursor.fetchall()]
    if 'description' not in columns:
        cursor.execute('ALTER TABLE playlists ADD COLUMN description TEXT')
    conn.commit()
    conn.close()

def migrate_add_playlist_icon():
    """Add icon column to playlists table if it doesn't exist."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("PRAGMA table_info(playlists)")
    columns = [row[1] for row in cursor.fetchall()]
    if 'icon' not in columns:
        cursor.execute('ALTER TABLE playlists ADD COLUMN icon TEXT')
    conn.commit()
    conn.close()

def migrate_add_playlist_owner():
    """Add owner column to playlists. Existing (owner-less) playlists are
    deleted so accounts start clean — songs and audio files are untouched."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("PRAGMA table_info(playlists)")
    columns = [row[1] for row in cursor.fetchall()]
    if 'owner' not in columns:
        # Clear pre-auth playlists first; FK cascades remove their
        # playlist_songs / feeder_playlists / sync_items rows.
        cursor.execute('PRAGMA foreign_keys = ON')
        cursor.execute('DELETE FROM playlists')
        cursor.execute('ALTER TABLE playlists ADD COLUMN owner TEXT')
    conn.commit()
    conn.close()

def migrate_queue_per_account():
    """Add an owner column to the queue. The old table has UNIQUE(position),
    which can't hold one queue per user, so it is rebuilt. Existing rows are
    disposable playback state and are dropped."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("PRAGMA table_info(queue)")
    columns = [row[1] for row in cursor.fetchall()]
    if 'owner' not in columns:
        cursor.execute('DROP TABLE IF EXISTS queue')
        cursor.execute('''
            CREATE TABLE queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                song_id INTEGER NOT NULL,
                position INTEGER NOT NULL,
                owner TEXT NOT NULL,
                FOREIGN KEY (song_id) REFERENCES songs (id) ON DELETE CASCADE,
                UNIQUE(owner, position)
            )
        ''')
    conn.commit()
    conn.close()

# Playlist icon upload directory
UPLOAD_DIR = os.path.join(os.path.dirname(__file__), 'static', 'uploads', 'playlist-icons')
os.makedirs(UPLOAD_DIR, exist_ok=True)

# Initialize database on startup
init_db()
migrate_add_start_end_time()
migrate_add_playlist_description()
migrate_add_playlist_icon()
migrate_add_playlist_owner()
migrate_queue_per_account()

# Initialize SocketIO
# async_mode='threading' lets Socket.IO run under a plain WSGI server (waitress)
# in production. allow_upgrades=False keeps clients on long-polling: waitress
# can't expose the raw socket engine.io needs for a WebSocket upgrade, so without
# this the browser's upgrade attempt raises "Cannot obtain socket from WSGI
# environment". Long-polling is negotiated automatically by the relative `io()`.
from flask_socketio import SocketIO, emit
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading',
                    allow_upgrades=False)

@socketio.on('connect')
def handle_connect():
    emit('test_event', {'message': 'WebSocket connected successfully'})

# Initialize download manager
from download_manager import DownloadManager
manager = DownloadManager(socketio=socketio)

# DownCloudMe fallback for SoundCloud Go+/preview-only tracks. yt-dlp can only
# fetch a ~30s snippet of those; when the primary SoundCloud download comes back
# under 31s, the manager reroutes it onto this fallback's own queue/worker.
from downcloud_manager import DownCloudManager
# Own temp dir: the primary SoundCloud worker grabs files by listing its
# downloads dir, so the fallback must not share it or the two workers race.
fallback_manager = DownCloudManager(
    socketio=socketio,
    downloads_path=os.path.join(app.root_path, 'downloads', 'downcloud'),
)
manager.fallback_manager = fallback_manager

AUDIO_DIR = os.path.join(app.root_path, 'static', 'audio')

@app.route('/')
def index():
    """Serve the main PWA page."""
    resp = send_from_directory('static', 'index.html')
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return resp

@app.route('/downloader')
def downloader_dashboard():
    """Serve the download manager visualization dashboard."""
    resp = send_from_directory('static', 'downloader.html')
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return resp

@app.route('/<path:path>')
def serve_static(path):
    """Serve static files for PWA.

    The app shell (HTML/JS/CSS/manifest/service worker) must always revalidate or
    phones get pinned to stale code — Flask's default caching plus the cache-first
    service worker otherwise serve old files indefinitely. Audio is large and
    immutable, so it keeps the default cacheable headers.
    """
    resp = send_from_directory('static', path)
    if not path.startswith('audio/'):
        resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return resp

@app.before_request
def require_login():
    """Gate the API and audio behind a login session.

    The static app shell (HTML/JS/CSS/manifest/sw) is served freely — it holds
    no data. The real boundary is here: every /api/* call (except the login
    endpoint) and every /audio/* stream needs a logged-in session.
    """
    path = request.path
    # Always allow the login endpoint and CORS preflight.
    if path == '/api/auth/login' or request.method == 'OPTIONS':
        return None
    # /api/admin/* carries its own shared-key auth (see admin_restart) and must
    # stay reachable without a session — it is called by deploy.sh over ssh.
    if path.startswith('/api/admin/'):
        return None
    protected = path.startswith('/api/') or path.startswith('/audio/')
    if protected and not current_user():
        return jsonify({'error': 'Authentication required'}), 401
    return None

@app.route('/api/auth/login', methods=['POST'])
def auth_login():
    """Validate credentials and start a persistent session."""
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''
    expected = USERS.get(username)
    if expected is not None and hmac.compare_digest(expected, password):
        session.permanent = True
        session['user'] = username
        return jsonify({'username': username})
    return jsonify({'error': 'Invalid username or password'}), 401

@app.route('/api/auth/logout', methods=['POST'])
def auth_logout():
    """Clear the session."""
    session.clear()
    return jsonify({'success': True})

@app.route('/api/auth/me')
def auth_me():
    """Return the current user (the before_request gate enforces auth)."""
    return jsonify({'username': current_user()})

def _admin_key_ok():
    """True if the request presents the admin key (header, query or JSON body)."""
    supplied = (
        request.headers.get('X-Admin-Key')
        or request.args.get('key')
        or (request.get_json(silent=True) or {}).get('key')
        or ''
    )
    return hmac.compare_digest(supplied, ADMIN_KEY)

@app.route('/api/admin/restart', methods=['GET', 'POST'])
def admin_restart():
    """Restart the app: exit with RESTART_EXIT_CODE so start.sh relaunches it.

    Auth is the shared key from admin_key.txt, not a login session, so this
    works from deploy.sh, a phone browser or curl. Bare GET is allowed on
    purpose — pasting the URL with ?key=... into a browser is the point.

    The exit happens on a short timer rather than inline so waitress can finish
    writing this response first, and it is os._exit: the download workers and
    the socket.io polling threads are not going to unwind politely, and a hung
    shutdown would leave :8008 bound with nothing behind it.
    """
    if not _admin_key_ok():
        return jsonify({'error': 'Invalid admin key'}), 403

    import threading

    def bail_out():
        print("[Admin] restart requested — exiting for start.sh to relaunch")
        sys.stdout.flush()
        os._exit(RESTART_EXIT_CODE)

    threading.Timer(0.5, bail_out).start()
    return jsonify({'status': 'restarting', 'pid': os.getpid()})

@app.route('/api/admin/health')
def admin_health():
    """Unauthenticated liveness probe — used to poll a restart back to ready."""
    return jsonify({'status': 'ok', 'pid': os.getpid()})

@app.route('/api/songs')
def get_songs():
    """
    Get list of available songs from database.

    Returns:
        JSON response with song metadata
    """
    conn = get_db_connection()
    songs = conn.execute('SELECT * FROM songs').fetchall()
    conn.close()

    songs_list = []
    for song in songs:
        songs_list.append({
            'id': song['id'],
            'title': song['title'],
            'artist': song['artist'],
            'cover': song['cover'],
            'source': song['source'],
            'download_link': song['download_link'],
            'url': f'/audio/{os.path.basename(song["file_path"])}' if song['file_path'] else None,
            'start_time': song['start_time'] if 'start_time' in song.keys() else None,
            'end_time': song['end_time'] if 'end_time' in song.keys() else None
        })

    response = make_response(jsonify({'songs': songs_list}))
    response.headers['Cache-Control'] = 'no-cache'
    return response

@app.route('/api/songs/<int:song_id>', methods=['PUT'])
def update_song(song_id):
    """
    Update a song's metadata.

    Request body:
        title?: string
        artist?: string
        start_time?: number (seconds, nullable)
        end_time?: number (seconds, nullable)

    Returns:
        Updated song object
    """
    data = request.get_json() or {}
    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        song = cursor.execute('SELECT * FROM songs WHERE id = ?', (song_id,)).fetchone()
        if not song:
            return jsonify({'error': 'Song not found'}), 404

        updates = []
        params = []

        if 'title' in data and data['title'] is not None:
            updates.append('title = ?')
            params.append(str(data['title']).strip() or 'Unknown')

        if 'artist' in data and data['artist'] is not None:
            updates.append('artist = ?')
            params.append(str(data['artist']).strip() or 'Unknown')

        if 'start_time' in data:
            val = data['start_time']
            if val is None:
                updates.append('start_time = NULL')
            else:
                try:
                    t = float(val)
                    if t < 0:
                        t = 0
                    updates.append('start_time = ?')
                    params.append(t)
                except (TypeError, ValueError):
                    return jsonify({'error': 'Invalid start_time'}), 400

        if 'end_time' in data:
            val = data['end_time']
            if val is None:
                updates.append('end_time = NULL')
            else:
                try:
                    t = float(val)
                    if t < 0:
                        t = 0
                    updates.append('end_time = ?')
                    params.append(t)
                except (TypeError, ValueError):
                    return jsonify({'error': 'Invalid end_time'}), 400

        if not updates:
            # Return current song
            return jsonify({
                'id': song['id'],
                'title': song['title'],
                'artist': song['artist'],
                'cover': song['cover'],
                'source': song['source'],
                'download_link': song['download_link'],
                'url': f'/audio/{os.path.basename(song["file_path"])}' if song['file_path'] else None,
                'start_time': song['start_time'] if 'start_time' in song.keys() else None,
                'end_time': song['end_time'] if 'end_time' in song.keys() else None
            })

        params.append(song_id)
        cursor.execute(
            f"UPDATE songs SET {', '.join(updates)} WHERE id = ?",
            params
        )
        conn.commit()

        updated = cursor.execute('SELECT * FROM songs WHERE id = ?', (song_id,)).fetchone()
        result = {
            'id': updated['id'],
            'title': updated['title'],
            'artist': updated['artist'],
            'cover': updated['cover'],
            'source': updated['source'],
            'download_link': updated['download_link'],
            'url': f'/audio/{os.path.basename(updated["file_path"])}' if updated['file_path'] else None,
            'start_time': updated['start_time'] if 'start_time' in updated.keys() else None,
            'end_time': updated['end_time'] if 'end_time' in updated.keys() else None
        }
        return jsonify(result)

    except Exception as e:
        conn.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()

@app.route('/api/songs/<int:song_id>', methods=['DELETE'])
def delete_song(song_id):
    """
    Delete a song from the database and remove its audio file.

    Returns:
        JSON response with success or error
    """
    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        song = cursor.execute('SELECT * FROM songs WHERE id = ?', (song_id,)).fetchone()
        if not song:
            return jsonify({'error': 'Song not found'}), 404

        file_path = song['file_path']

        cursor.execute('DELETE FROM songs WHERE id = ?', (song_id,))
        conn.commit()

        # Remove audio file from disk if it exists
        if file_path and os.path.isfile(file_path):
            try:
                os.remove(file_path)
            except OSError as e:
                print(f"Warning: could not remove file {file_path}: {e}")

        return jsonify({'success': True, 'message': 'Song deleted'})

    except Exception as e:
        conn.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()

@app.route('/api/songs/<int:song_id>/redownload', methods=['POST'])
def redownload_song(song_id):
    """
    Re-download a song from its original link, replacing the attached audio
    file in place. Useful when the wrong file got attached to a song.

    Returns:
        JSON response with success or error
    """
    conn = get_db_connection()
    song = conn.execute('SELECT id FROM songs WHERE id = ?', (song_id,)).fetchone()
    conn.close()

    if not song:
        return jsonify({'error': 'Song not found'}), 404

    if manager.redownload_song(song_id):
        return jsonify({'success': True, 'message': 'Re-download queued'})
    return jsonify({'error': 'Could not queue re-download'}), 500

@app.route('/audio/<filename>')
def stream_song(filename):
    """
    Stream an audio file with HTTP Range support.

    Honoring the Range header (returning 206 Partial Content) is what lets clients
    *seek*. iOS Safari in particular will not scrub a media element unless the server
    answers range requests with 206 + Content-Range; without it, setting currentTime
    is silently ignored and playback snaps back to the start.

    Args:
        filename: The audio file name

    Returns:
        Flask response with the full file (200) or the requested byte range (206).
    """
    safe_filename = os.path.basename(filename)
    file_path = os.path.join(AUDIO_DIR, safe_filename)

    if not os.path.exists(file_path):
        return jsonify({'error': 'File not found'}), 404

    file_size = os.path.getsize(file_path)
    mime = mimetypes.guess_type(safe_filename)[0] or 'audio/mpeg'
    range_header = request.headers.get('Range')

    def generate(start, length):
        remaining = length
        with open(file_path, 'rb') as f:
            f.seek(start)
            while remaining > 0:
                chunk = f.read(min(8192, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    # No Range header → serve the whole file (still advertise range support).
    if not range_header:
        response = app.response_class(generate(0, file_size), mimetype=mime)
        response.headers['Accept-Ranges'] = 'bytes'
        response.headers['Content-Length'] = str(file_size)
        return response

    # Parse "bytes=start-end" (end optional). Only the first range is honored.
    start, end = 0, file_size - 1
    try:
        units, _, rng = range_header.partition('=')
        if units.strip() == 'bytes':
            start_s, _, end_s = rng.partition('-')
            if start_s.strip():
                start = int(start_s)
            if end_s.strip():
                end = int(end_s)
    except (ValueError, AttributeError):
        start, end = 0, file_size - 1

    # Clamp to the file and reject unsatisfiable ranges.
    if start >= file_size:
        response = app.response_class(status=416, mimetype=mime)
        response.headers['Content-Range'] = f'bytes */{file_size}'
        return response
    end = min(end, file_size - 1)
    length = end - start + 1

    response = app.response_class(generate(start, length), status=206, mimetype=mime)
    response.headers['Accept-Ranges'] = 'bytes'
    response.headers['Content-Range'] = f'bytes {start}-{end}/{file_size}'
    response.headers['Content-Length'] = str(length)
    return response

@app.route('/api/playlists')
def get_playlists():
    """
    Get list of playlists with their songs.

    Returns:
        JSON response with playlist data
    """
    conn = get_db_connection()

    # Get the current user's playlists with song counts
    playlists = conn.execute('''
        SELECT p.id, p.name, p.description, p.icon, p.created_at, COUNT(ps.song_id) as song_count
        FROM playlists p
        LEFT JOIN playlist_songs ps ON p.id = ps.playlist_id
        WHERE p.owner = ?
        GROUP BY p.id
        ORDER BY p.created_at DESC
    ''', (current_user(),)).fetchall()

    playlists_list = []
    for playlist in playlists:
        # Get songs for this playlist
        songs = conn.execute('''
            SELECT s.* FROM songs s
            JOIN playlist_songs ps ON s.id = ps.song_id
            WHERE ps.playlist_id = ?
            ORDER BY ps.position
        ''', (playlist['id'],)).fetchall()

        songs_list = []
        for song in songs:
            songs_list.append({
                'id': song['id'],
                'title': song['title'],
                'artist': song['artist'],
                'cover': song['cover'],
                'source': song['source'],
                'download_link': song['download_link'],
                'url': f'/audio/{os.path.basename(song["file_path"])}' if song['file_path'] else None,
                'start_time': song['start_time'] if 'start_time' in song.keys() else None,
                'end_time': song['end_time'] if 'end_time' in song.keys() else None
            })

        icon_url = None
        icon_val = playlist['icon'] if 'icon' in playlist.keys() else None
        if icon_val:
            raw = str(icon_val).replace(os.sep, '/')
            icon_url = f"/{raw}" if not raw.startswith('/') else raw
        playlists_list.append({
            'id': playlist['id'],
            'name': playlist['name'],
            'description': playlist['description'] if 'description' in playlist.keys() else None,
            'icon': icon_url,
            'songs': songs_list,
            'created_at': playlist['created_at']
        })

    conn.close()

    response = make_response(jsonify({'playlists': playlists_list}))
    response.headers['Cache-Control'] = 'no-cache'
    return response

@app.route('/api/playlists', methods=['POST'])
def create_playlist():
    """
    Create a new playlist.

    Request body:
        name: Playlist name

    Returns:
        JSON response with created playlist
    """
    data = request.get_json()
    name = data.get('name', '').strip()

    if not name:
        return jsonify({'error': 'Playlist name is required'}), 400

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        cursor.execute('INSERT INTO playlists (name, owner) VALUES (?, ?)',
                       (name, current_user()))
        playlist_id = cursor.lastrowid
        conn.commit()

        # Return the created playlist
        playlist = {
            'id': playlist_id,
            'name': name,
            'songs': [],
            'created_at': None  # Will be set by database
        }

        return jsonify({'playlist': playlist}), 201
    except Exception as e:
        conn.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()

@app.route('/api/playlists/<int:playlist_id>/songs', methods=['POST'])
def add_song_to_playlist(playlist_id):
    """
    Add a song to a playlist.

    Request body:
        song_id: Song ID to add

    Returns:
        JSON response with success or error
    """
    data = request.get_json()
    song_id = data.get('song_id')

    if not song_id:
        return jsonify({'error': 'Song ID is required'}), 400

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        # Check the playlist exists and belongs to this user
        if not playlist_owned_by(conn, playlist_id, current_user()):
            return jsonify({'error': 'Playlist not found'}), 404

        # Check if song exists
        song = cursor.execute('SELECT id FROM songs WHERE id = ?', (song_id,)).fetchone()
        if not song:
            return jsonify({'error': 'Song not found'}), 404

        # Check if song is already in playlist
        existing = cursor.execute('SELECT id FROM playlist_songs WHERE playlist_id = ? AND song_id = ?', (playlist_id, song_id)).fetchone()
        if existing:
            return jsonify({'error': 'Song already in playlist'}), 409

        # Get the next position
        result = cursor.execute('SELECT MAX(position) as max_pos FROM playlist_songs WHERE playlist_id = ?', (playlist_id,)).fetchone()
        next_position = (result['max_pos'] or 0) + 1

        # Add song to playlist
        cursor.execute('INSERT INTO playlist_songs (playlist_id, song_id, position) VALUES (?, ?, ?)', (playlist_id, song_id, next_position))
        conn.commit()

        return jsonify({'success': True, 'message': 'Song added to playlist'}), 201
    except Exception as e:
        conn.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()

@app.route('/api/playlists/<int:playlist_id>/songs/<int:song_id>', methods=['DELETE'])
def remove_song_from_playlist(playlist_id, song_id):
    """
    Remove a single song from a playlist.

    Returns:
        JSON response with success or error
    """
    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        if not playlist_owned_by(conn, playlist_id, current_user()):
            return jsonify({'error': 'Playlist not found'}), 404

        result = cursor.execute(
            'DELETE FROM playlist_songs WHERE playlist_id = ? AND song_id = ?',
            (playlist_id, song_id)
        )
        conn.commit()

        if result.rowcount == 0:
            return jsonify({'error': 'Song not in playlist'}), 404

        return jsonify({'success': True, 'message': 'Song removed from playlist'})
    except Exception as e:
        conn.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()

@app.route('/api/playlists/<int:playlist_id>', methods=['PUT'])
def update_playlist(playlist_id):
    """
    Update a playlist's name and/or description.

    Request body:
        name?: string
        description?: string

    Returns:
        Updated playlist object
    """
    data = request.get_json() or {}
    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        playlist = cursor.execute('SELECT * FROM playlists WHERE id = ? AND owner = ?',
                                  (playlist_id, current_user())).fetchone()
        if not playlist:
            return jsonify({'error': 'Playlist not found'}), 404

        updates = []
        params = []

        if 'name' in data:
            name = str(data['name']).strip()
            if not name:
                return jsonify({'error': 'Playlist name cannot be empty'}), 400
            updates.append('name = ?')
            params.append(name)

        if 'description' in data:
            desc = data['description']
            if desc is not None:
                desc = str(desc).strip()
            updates.append('description = ?')
            params.append(desc)

        if not updates:
            icon_val = playlist['icon'] if 'icon' in playlist.keys() else None
            icon_url = f"/{icon_val}" if icon_val and not str(icon_val).startswith('/') else (icon_val or None)
            return jsonify({
                'id': playlist['id'],
                'name': playlist['name'],
                'description': playlist['description'] if 'description' in playlist.keys() else None,
                'icon': icon_url
            })

        params.append(playlist_id)
        cursor.execute(f"UPDATE playlists SET {', '.join(updates)} WHERE id = ?", params)
        conn.commit()

        updated = cursor.execute('SELECT * FROM playlists WHERE id = ?', (playlist_id,)).fetchone()
        icon_val = updated['icon'] if 'icon' in updated.keys() else None
        icon_url = f"/{icon_val}" if icon_val and not str(icon_val).startswith('/') else (icon_val or None)
        return jsonify({
            'id': updated['id'],
            'name': updated['name'],
            'description': updated['description'] if 'description' in updated.keys() else None,
            'icon': icon_url
        })

    except Exception as e:
        conn.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()

ALLOWED_ICON_EXTENSIONS = {'jpg', 'jpeg', 'png', 'webp', 'gif'}

@app.route('/api/playlists/<int:playlist_id>/icon', methods=['POST'])
def upload_playlist_icon(playlist_id):
    """Upload a custom icon for a playlist. Accepts image files (jpg, png, webp, gif)."""
    if 'file' not in request.files and 'icon' not in request.files:
        return jsonify({'error': 'No file provided'}), 400
    file = request.files.get('file') or request.files.get('icon')
    if not file or file.filename == '':
        return jsonify({'error': 'No file selected'}), 400

    ext = (file.filename.rsplit('.', 1)[-1] or '').lower()
    if ext not in ALLOWED_ICON_EXTENSIONS:
        return jsonify({'error': f'Invalid file type. Allowed: {", ".join(ALLOWED_ICON_EXTENSIONS)}'}), 400

    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        playlist = cursor.execute('SELECT id, icon FROM playlists WHERE id = ? AND owner = ?',
                                  (playlist_id, current_user())).fetchone()
        if not playlist:
            conn.close()
            return jsonify({'error': 'Playlist not found'}), 404

        # Remove old icon file if exists
        old_icon = playlist['icon'] if 'icon' in playlist.keys() and playlist['icon'] else None
        if old_icon:
            old_path = os.path.join(app.root_path, 'static', old_icon)
            if os.path.isfile(old_path):
                try:
                    os.remove(old_path)
                except OSError:
                    pass

        filename = f"{playlist_id}.{ext}"
        rel_path = 'uploads/playlist-icons/' + filename
        save_path = os.path.join(UPLOAD_DIR, filename)
        file.save(save_path)

        cursor.execute('UPDATE playlists SET icon = ? WHERE id = ?', (rel_path, playlist_id))
        conn.commit()
        icon_url = f"/{rel_path}"
        conn.close()
        return jsonify({'icon': icon_url})
    except Exception as e:
        conn.rollback()
        conn.close()
        return jsonify({'error': str(e)}), 500

CONTENT_TYPE_TO_EXT = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/webp': 'webp', 'image/gif': 'gif',
}

@app.route('/api/playlists/<int:playlist_id>/icon/from-feeder', methods=['POST'])
def use_feeder_icon(playlist_id):
    """Adopt a feeder playlist's cover as this playlist's icon.

    Downloads the feeder's remote thumbnail and stores it locally (exactly like
    an uploaded icon), so the icon no longer depends on the external host.

    Request body:
        feeder_id: id of a feeder attached to this playlist
    """
    import requests
    from urllib.parse import urlparse

    data = request.get_json() or {}
    feeder_id = data.get('feeder_id')
    if not feeder_id:
        return jsonify({'error': 'feeder_id is required'}), 400

    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        playlist = cursor.execute('SELECT id, icon FROM playlists WHERE id = ? AND owner = ?',
                                  (playlist_id, current_user())).fetchone()
        if not playlist:
            conn.close()
            return jsonify({'error': 'Playlist not found'}), 404

        feeder = cursor.execute(
            'SELECT thumbnail FROM feeder_playlists WHERE id = ? AND playlist_id = ?',
            (feeder_id, playlist_id)
        ).fetchone()
        if not feeder:
            conn.close()
            return jsonify({'error': 'Feeder not found'}), 404
        thumb_url = feeder['thumbnail']
        if not thumb_url:
            conn.close()
            return jsonify({'error': 'This feeder has no cover image'}), 400

        try:
            resp = requests.get(thumb_url, timeout=30)
            resp.raise_for_status()
            content = resp.content
        except requests.RequestException as e:
            conn.close()
            return jsonify({'error': f'Could not download cover image: {e}'}), 502

        # Prefer the URL's own extension, then fall back to the content type.
        ext = (urlparse(thumb_url).path.rsplit('.', 1)[-1] or '').lower()
        if ext not in ALLOWED_ICON_EXTENSIONS:
            ctype = (resp.headers.get('Content-Type') or '').split(';')[0].strip().lower()
            ext = CONTENT_TYPE_TO_EXT.get(ctype, '')
        if ext not in ALLOWED_ICON_EXTENSIONS:
            conn.close()
            return jsonify({'error': 'Feeder cover is not a supported image type'}), 400

        # Remove the old icon file (a different extension would otherwise orphan it).
        old_icon = playlist['icon'] if 'icon' in playlist.keys() and playlist['icon'] else None
        if old_icon:
            old_path = os.path.join(app.root_path, 'static', old_icon)
            if os.path.isfile(old_path):
                try:
                    os.remove(old_path)
                except OSError:
                    pass

        filename = f"{playlist_id}.{ext}"
        rel_path = 'uploads/playlist-icons/' + filename
        save_path = os.path.join(UPLOAD_DIR, filename)
        with open(save_path, 'wb') as fh:
            fh.write(content)

        cursor.execute('UPDATE playlists SET icon = ? WHERE id = ?', (rel_path, playlist_id))
        conn.commit()
        conn.close()
        return jsonify({'icon': f"/{rel_path}"})
    except Exception as e:
        conn.rollback()
        conn.close()
        return jsonify({'error': str(e)}), 500

@app.route('/api/playlists/<int:playlist_id>/icon', methods=['DELETE'])
def remove_playlist_icon(playlist_id):
    """Remove the custom icon from a playlist."""
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        playlist = cursor.execute('SELECT id, icon FROM playlists WHERE id = ? AND owner = ?',
                                  (playlist_id, current_user())).fetchone()
        if not playlist:
            conn.close()
            return jsonify({'error': 'Playlist not found'}), 404
        old_icon = playlist['icon'] if 'icon' in playlist.keys() and playlist['icon'] else None
        if not old_icon:
            conn.close()
            return jsonify({'icon': None})
        old_path = os.path.join(app.root_path, 'static', playlist['icon'])
        if os.path.isfile(old_path):
            try:
                os.remove(old_path)
            except OSError:
                pass
        cursor.execute('UPDATE playlists SET icon = NULL WHERE id = ?', (playlist_id,))
        conn.commit()
        conn.close()
        return jsonify({'icon': None})
    except Exception as e:
        conn.rollback()
        conn.close()
        return jsonify({'error': str(e)}), 500

@app.route('/api/playlists/<int:playlist_id>', methods=['DELETE'])
def delete_playlist(playlist_id):
    """
    Delete a playlist and all associated data (songs, feeders, sync items).

    Returns:
        JSON response with success or error
    """
    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        playlist = cursor.execute('SELECT id, icon FROM playlists WHERE id = ? AND owner = ?',
                                  (playlist_id, current_user())).fetchone()
        if not playlist:
            return jsonify({'error': 'Playlist not found'}), 404
        if 'icon' in playlist.keys() and playlist['icon']:
            icon_path = os.path.join(app.root_path, 'static', playlist['icon'])
            if os.path.isfile(icon_path):
                try:
                    os.remove(icon_path)
                except OSError:
                    pass

        cursor.execute('DELETE FROM sync_items WHERE playlist_id = ?', (playlist_id,))
        cursor.execute('DELETE FROM feeder_playlists WHERE playlist_id = ?', (playlist_id,))
        cursor.execute('DELETE FROM playlist_songs WHERE playlist_id = ?', (playlist_id,))
        cursor.execute('DELETE FROM playlists WHERE id = ?', (playlist_id,))
        conn.commit()

        return jsonify({'success': True, 'message': 'Playlist deleted'})

    except Exception as e:
        conn.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()

@app.route('/api/playlists/<int:playlist_id>/feeders')
def get_feeders(playlist_id):
    """Get all feeder playlists for a playlist."""
    conn = get_db_connection()
    try:
        if not playlist_owned_by(conn, playlist_id, current_user()):
            return jsonify({'error': 'Playlist not found'}), 404

        feeders = conn.execute(
            'SELECT * FROM feeder_playlists WHERE playlist_id = ? ORDER BY created_at DESC',
            (playlist_id,)
        ).fetchall()

        feeders_list = [{
            'id': f['id'],
            'playlist_id': f['playlist_id'],
            'url': f['url'],
            'name': f['name'],
            'thumbnail': f['thumbnail'],
            'source': f['source'],
            'created_at': f['created_at']
        } for f in feeders]

        return jsonify({'feeders': feeders_list})
    finally:
        conn.close()

def resolve_soundcloud_set_cover(url):
    """Get a SoundCloud set's *own* cover artwork (the playlist icon).

    yt-dlp exposes no set-level artwork, and the first track's art is usually not
    the set cover. Resolve the set via the SoundCloud API and use its artwork_url,
    falling back to the first track's art, then the uploader avatar. '' if none.
    """
    def hq(u):
        # SoundCloud serves '-large' (100px); request the 500px variant instead.
        return u.replace('-large', '-t500x500') if u else ''
    try:
        from soundcloud import SoundCloud
        obj = SoundCloud().resolve(url)
    except Exception as e:
        print(f"[Feeder] SoundCloud cover lookup failed for {url}: {e}")
        return ''
    if obj is None:
        return ''
    art = getattr(obj, 'artwork_url', None)
    if art:
        return hq(art)
    for track in (getattr(obj, 'tracks', None) or []):
        track_art = getattr(track, 'artwork_url', None)
        if track_art:
            return hq(track_art)
    user = getattr(obj, 'user', None)
    return hq(getattr(user, 'avatar_url', None) if user else None)

def resolve_first_track_thumbnail(url, source):
    """Resolve a playlist's cover from its first track.

    Used when the flat playlist dump carries no thumbnail (notably SoundCloud
    sets, whose flat entries omit artwork). Returns a thumbnail URL or ''.
    """
    import subprocess
    try:
        cmd = ['yt-dlp', '--dump-json', '--no-download', '--playlist-items', '1']
        cmd += yt_dlp_cookie_args(source)
        cmd.append(url)
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        stdout = result.stdout.strip()
        if not stdout:
            return ''
        # --dump-json emits one JSON object per line; the first is the track.
        entry = json.loads(stdout.splitlines()[0])
    except (subprocess.TimeoutExpired, json.JSONDecodeError, IndexError, OSError):
        return ''

    thumbs = entry.get('thumbnails') or []
    sized = [t for t in thumbs if t.get('width')]
    if sized:
        best = sorted(sized, key=lambda t: (t.get('width', 0) * t.get('height', 0)), reverse=True)[0]
        return best.get('url', '') or ''
    return entry.get('thumbnail', '') or ''

@app.route('/api/playlists/<int:playlist_id>/feeders', methods=['POST'])
def add_feeder(playlist_id):
    """
    Add a feeder playlist. Validates URL via yt-dlp and extracts metadata.

    Request body:
        url: YouTube or SoundCloud playlist URL
    """
    import subprocess

    data = request.get_json() or {}
    url = data.get('url', '').strip()
    if not url:
        return jsonify({'error': 'URL is required'}), 400

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        if not playlist_owned_by(conn, playlist_id, current_user()):
            return jsonify({'error': 'Playlist not found'}), 404

        # Detect source from URL
        source = None
        if 'youtube.com' in url or 'youtu.be' in url:
            source = 'youtube'
        elif 'soundcloud.com' in url:
            source = 'soundcloud'
        else:
            return jsonify({'error': 'URL must be a YouTube or SoundCloud playlist'}), 400

        # Check for duplicate feeder URL
        existing = cursor.execute(
            'SELECT id FROM feeder_playlists WHERE playlist_id = ? AND url = ?',
            (playlist_id, url)
        ).fetchone()
        if existing:
            return jsonify({'error': 'This playlist is already added as a feeder'}), 409

        # Validate URL and extract metadata via yt-dlp
        cmd = ['yt-dlp', '--dump-single-json', '--no-download', '--flat-playlist']
        cmd += yt_dlp_cookie_args(source)
        cmd.append(url)
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)

        if result.returncode != 0:
            return jsonify({'error': f'Could not access playlist: {result.stderr[:200]}'}), 400

        try:
            playlist_data = json.loads(result.stdout.strip())
        except json.JSONDecodeError:
            return jsonify({'error': 'Could not parse playlist data'}), 400

        name = playlist_data.get('title') or playlist_data.get('playlist_title') or 'Unknown Playlist'
        thumbnail = None
        thumbnails = playlist_data.get('thumbnails', [])
        if thumbnails:
            sorted_thumbs = sorted(thumbnails, key=lambda t: (t.get('width', 0) * t.get('height', 0)), reverse=True)
            thumbnail = sorted_thumbs[0].get('url', '')
        if not thumbnail:
            entries = playlist_data.get('entries', [])
            if entries and entries[0]:
                entry_thumbs = entries[0].get('thumbnails', [])
                if entry_thumbs:
                    thumbnail = entry_thumbs[-1].get('url', '')
        # SoundCloud sets carry no artwork anywhere in the yt-dlp dump (neither
        # playlist- nor entry-level), unlike YouTube. Fetch the set's *own* cover
        # via the SoundCloud API; only fall back to per-track art if it has none.
        if source == 'soundcloud':
            thumbnail = resolve_soundcloud_set_cover(url) or thumbnail
        elif not thumbnail:
            thumbnail = resolve_first_track_thumbnail(url, source)

        cursor.execute(
            'INSERT INTO feeder_playlists (playlist_id, url, name, thumbnail, source) VALUES (?, ?, ?, ?, ?)',
            (playlist_id, url, name, thumbnail, source)
        )
        feeder_id = cursor.lastrowid
        conn.commit()

        return jsonify({
            'feeder': {
                'id': feeder_id,
                'playlist_id': playlist_id,
                'url': url,
                'name': name,
                'thumbnail': thumbnail,
                'source': source
            }
        }), 201

    except subprocess.TimeoutExpired:
        return jsonify({'error': 'Playlist fetch timed out'}), 504
    except Exception as e:
        conn.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()

@app.route('/api/playlists/<int:playlist_id>/feeders/<int:feeder_id>', methods=['DELETE'])
def remove_feeder(playlist_id, feeder_id):
    """Remove a feeder playlist."""
    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        if not playlist_owned_by(conn, playlist_id, current_user()):
            return jsonify({'error': 'Playlist not found'}), 404

        feeder = cursor.execute(
            'SELECT id FROM feeder_playlists WHERE id = ? AND playlist_id = ?',
            (feeder_id, playlist_id)
        ).fetchone()
        if not feeder:
            return jsonify({'error': 'Feeder not found'}), 404

        cursor.execute('DELETE FROM feeder_playlists WHERE id = ?', (feeder_id,))
        conn.commit()
        return jsonify({'success': True})

    except Exception as e:
        conn.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()

@app.route('/api/playlists/<int:playlist_id>/sync', methods=['POST'])
def trigger_sync(playlist_id):
    """
    Trigger a sync for a playlist: fetch all feeder playlist songs,
    compare against DB, enqueue missing ones for download.
    """
    import subprocess

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        if not playlist_owned_by(conn, playlist_id, current_user()):
            return jsonify({'error': 'Playlist not found'}), 404

        feeders = cursor.execute(
            'SELECT * FROM feeder_playlists WHERE playlist_id = ?', (playlist_id,)
        ).fetchall()

        if not feeders:
            return jsonify({'error': 'No feeder playlists configured'}), 400

        # Clear previous sync items for this playlist
        cursor.execute('DELETE FROM sync_items WHERE playlist_id = ?', (playlist_id,))
        conn.commit()

        sync_items = []

        for feeder in feeders:
            try:
                cmd = ['yt-dlp', '--dump-single-json', '--no-download']
                cmd += yt_dlp_cookie_args(feeder['source'])
                cmd.append(feeder['url'])
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)

                # yt-dlp exits non-zero when individual tracks fail to resolve
                # (e.g. SoundCloud DRM-protected tracks), yet still dumps valid
                # playlist JSON for every track that DID resolve. Don't discard
                # the whole feeder over a few unavailable tracks — parse whatever
                # it produced, and only bail if there's no usable JSON at all.
                # (Note: --ignore-errors is deliberately NOT used; it nulls out
                # tracks that merely emit warnings, dropping usable entries.)
                stdout = result.stdout.strip()
                if not stdout:
                    print(f"[Sync] Failed to fetch feeder {feeder['url']}: {result.stderr[:300]}")
                    continue

                playlist_data = json.loads(stdout)
                entries = playlist_data.get('entries', [])

                for entry in entries:
                    if not entry:
                        continue

                    download_link = entry.get('webpage_url') or entry.get('url', '')
                    if not download_link:
                        continue

                    title = entry.get('title') or entry.get('fulltitle') or 'Unknown'
                    artist = (entry.get('uploader') or entry.get('artist') or
                              entry.get('creator') or entry.get('channel') or 'Unknown')
                    source = feeder['source']

                    cover = ''
                    entry_thumbs = entry.get('thumbnails', [])
                    if entry_thumbs:
                        sorted_t = sorted(entry_thumbs, key=lambda t: (t.get('width', 0) * t.get('height', 0)), reverse=True)
                        cover = sorted_t[0].get('url', '')

                    # Check if already in our songs database
                    existing_song = cursor.execute(
                        'SELECT id FROM songs WHERE download_link = ?', (download_link,)
                    ).fetchone()

                    if existing_song:
                        song_id = existing_song['id']
                        status = 'downloaded'

                        # Add to playlist if not already there
                        in_playlist = cursor.execute(
                            'SELECT id FROM playlist_songs WHERE playlist_id = ? AND song_id = ?',
                            (playlist_id, song_id)
                        ).fetchone()
                        if not in_playlist:
                            max_pos = cursor.execute(
                                'SELECT MAX(position) as mp FROM playlist_songs WHERE playlist_id = ?',
                                (playlist_id,)
                            ).fetchone()
                            next_pos = (max_pos['mp'] or 0) + 1
                            cursor.execute(
                                'INSERT OR IGNORE INTO playlist_songs (playlist_id, song_id, position) VALUES (?, ?, ?)',
                                (playlist_id, song_id, next_pos)
                            )
                    else:
                        song_id = None
                        status = 'pending'

                    cursor.execute(
                        '''INSERT INTO sync_items (playlist_id, download_link, title, artist, source, cover, status, song_id)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
                        (playlist_id, download_link, title, artist, source, cover, status, song_id)
                    )
                    sync_items.append({
                        'id': cursor.lastrowid,
                        'download_link': download_link,
                        'title': title,
                        'artist': artist,
                        'source': source,
                        'cover': cover,
                        'status': status,
                        'song_id': song_id
                    })

            except subprocess.TimeoutExpired:
                print(f"[Sync] Timeout fetching feeder {feeder['url']}")
                continue
            except json.JSONDecodeError:
                print(f"[Sync] JSON parse error for feeder {feeder['url']}")
                continue

        conn.commit()

        # Now enqueue pending items for download
        enqueued = 0
        for item in sync_items:
            if item['status'] == 'pending':
                song_data = {
                    'source': item['source'],
                    'download_link': item['download_link'],
                    'title': item['title'],
                    'artist': item['artist'],
                    'cover': item['cover']
                }
                manager.add_download(song_data)
                enqueued += 1

        return jsonify({
            'sync_items': sync_items,
            'total': len(sync_items),
            'already_downloaded': sum(1 for i in sync_items if i['status'] == 'downloaded'),
            'enqueued': enqueued
        })

    except Exception as e:
        conn.rollback()
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()

@app.route('/api/playlists/<int:playlist_id>/sync-status')
def get_sync_status(playlist_id):
    """Get current sync items for a playlist."""
    conn = get_db_connection()
    try:
        if not playlist_owned_by(conn, playlist_id, current_user()):
            return jsonify({'error': 'Playlist not found'}), 404

        items = conn.execute(
            'SELECT * FROM sync_items WHERE playlist_id = ? ORDER BY id',
            (playlist_id,)
        ).fetchall()

        return jsonify({
            'sync_items': [{
                'id': i['id'],
                'download_link': i['download_link'],
                'title': i['title'],
                'artist': i['artist'],
                'source': i['source'],
                'cover': i['cover'],
                'status': i['status'],
                'song_id': i['song_id']
            } for i in items]
        })
    finally:
        conn.close()

@app.route('/api/spotify/download', methods=['POST'])
def download_spotify():
    """
    Download a Spotify track given its URL using votify.

    Request body:
        url: Spotify track URL

    Returns:
        JSON response with success or error
    """
    import subprocess
    import shutil

    data = request.get_json()
    url = data.get('url')
    if not url:
        return jsonify({'error': 'Missing url parameter'}), 400

    try:
        # Create temp downloads directory
        downloads_dir = os.path.join(os.getcwd(), 'downloads')
        os.makedirs(downloads_dir, exist_ok=True)

        # Run votify command with cookies
        result = subprocess.run(['votify', '--cookies-path', '../cookies.txt', url], cwd=downloads_dir, capture_output=True, text=True)

        if result.returncode == 0:
            # Find downloaded audio files
            extensions = ('.mp3', '.m4a', '.webm', '.wav', '.flac', '.ogg')
            downloaded_files = [f for f in os.listdir(downloads_dir) if f.lower().endswith(extensions)]

            if downloaded_files:
                # Move files to audio directory
                for file in downloaded_files:
                    src_path = os.path.join(downloads_dir, file)
                    dest_path = os.path.join(AUDIO_DIR, file)
                    if os.path.exists(dest_path):
                        # Handle duplicates by adding number
                        base, ext = os.path.splitext(file)
                        counter = 1
                        while os.path.exists(os.path.join(AUDIO_DIR, f"{base}_{counter}{ext}")):
                            counter += 1
                        dest_path = os.path.join(AUDIO_DIR, f"{base}_{counter}{ext}")
                    shutil.move(src_path, dest_path)

                return jsonify({
                    'success': True,
                    'message': f'Downloaded {len(downloaded_files)} files',
                    'files': downloaded_files
                })
            else:
                return jsonify({'success': True, 'message': 'Download completed but no audio files found'})
        else:
            # Clean up any partial downloads
            for f in os.listdir(downloads_dir):
                try:
                    os.remove(os.path.join(downloads_dir, f))
                except:
                    pass
            return jsonify({'error': 'Download failed', 'details': result.stderr})
    except Exception as e:
        return jsonify({'error': str(e)})

@app.route('/api/search')
def search_songs():
    """
    Search for songs on YouTube and SoundCloud.

    Query parameters:
        query: Search string

    Returns:
        JSON response with combined search results from YouTube and SoundCloud
    """
    query = request.args.get('query', '').strip()
    if not query:
        return jsonify({'error': 'Missing query parameter'}), 400

    results = []

    try:
        # Search YouTube
        try:
            import subprocess
            import json
            # Use yt-dlp to search YouTube
            cmd = [
                'yt-dlp',
                '--dump-json',
                '--flat-playlist',
                f'ytsearch10:{query}'  # Search for 10 results from YouTube
            ]

            result = subprocess.run(cmd, capture_output=True, text=True)

            if result.returncode == 0:
                # Parse the JSON output (multiple JSON objects, one per line)
                videos = []
                for line in result.stdout.strip().split('\n'):
                    if line.strip():
                        try:
                            video_data = json.loads(line.strip())
                            videos.append(video_data)
                        except json.JSONDecodeError:
                            continue

                count = 0
                for video in videos:
                    if count >= 10:  # Limit to 10 results from YouTube
                        break

                    # Extract video information
                    video_id = video.get('id', '')
                    title = video.get('title', 'Unknown')
                    uploader = video.get('uploader', 'Unknown')
                    duration = video.get('duration', 0) * 1000 if video.get('duration') else 0  # Convert to ms
                    webpage_url = video.get('webpage_url', f'https://www.youtube.com/watch?v={video_id}')

                    # Get highest quality thumbnail
                    cover = ''
                    thumbnails = video.get('thumbnails', [])
                    if thumbnails:
                        # Sort by resolution (width * height) and pick the highest
                        sorted_thumbs = sorted(thumbnails, key=lambda t: (t.get('width', 0) * t.get('height', 0)), reverse=True)
                        cover = sorted_thumbs[0].get('url', '')

                    results.append({
                        'id': f"{video_id}_youtube",
                        'title': title,
                        'artist': uploader,
                        'duration': duration,
                        'url': webpage_url,
                        'cover': cover,
                        'source': 'youtube'
                    })
                    count += 1
        except Exception as e:
            print(f"YouTube search error: {e}")

        # Search SoundCloud
        try:
            from soundcloud import SoundCloud
            client = SoundCloud()
            soundcloud_results = client.search_tracks(query)

            count = 0
            for track in soundcloud_results:
                if count >= 10:  # Limit to 10 results from SoundCloud
                    break

                title = track.title
                artist = getattr(track.user, 'username', 'Unknown') if hasattr(track, 'user') and track.user else 'Unknown'
                duration = track.duration  # Already in ms
                url = track.permalink_url

                # Get highest quality artwork/thumbnail
                cover = ''
                if hasattr(track, 'artwork_url') and track.artwork_url:
                    # SoundCloud provides artwork_url, convert to high quality
                    cover = track.artwork_url.replace('-large', '-t500x500')
                elif hasattr(track, 'user') and track.user and hasattr(track.user, 'avatar_url') and track.user.avatar_url:
                    # Fallback to user avatar
                    cover = track.user.avatar_url.replace('-large', '-t500x500')

                results.append({
                    'id': str(track.id) + '_soundcloud',
                    'title': title,
                    'artist': artist,
                    'duration': duration,
                    'url': url,
                    'cover': cover,
                    'source': 'soundcloud'
                })
                count += 1
        except Exception as e:
            print(f"SoundCloud search error: {e}")

        return jsonify({'results': results})

    except Exception as e:
        print(f"General search error: {e}")
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/api/download', methods=['POST'])
def download_track():
    """
    Add a track to the centralized download queue.

    Request body:
        url: Track URL (Spotify, SoundCloud, or YouTube)
        source: 'spotify', 'soundcloud', or 'youtube'
        trackData (optional): { title, artist, cover, ... }

    Returns:
        JSON response with success or error
    """
    data = request.get_json()

    url = data.get('url')
    source = data.get('source', 'spotify').lower()
    track_data = data.get('trackData', {})

    if not url:
        return jsonify({'error': 'Missing url parameter'}), 400

    if source not in ['spotify', 'soundcloud', 'youtube']:
        return jsonify({'error': 'Invalid source. Must be spotify, soundcloud, or youtube'}), 400

    # Prepare song data for download manager
    song_data = {
        'source': source,
        'download_link': url,
        'title': track_data.get('title', 'Unknown'),
        'artist': track_data.get('artist', 'Unknown'),
        'cover': track_data.get('cover')
    }

    # Add to download queue
    result = manager.add_download(song_data)

    if result:
        return jsonify({
            'success': True,
            'message': 'Download queued successfully',
            'queue_sizes': manager.get_queue_sizes()
        })
    else:
        return jsonify({'error': 'Song already in queue or downloaded'}), 409

@app.route('/api/download/queue')
def get_queue_status():
    """Get current download queue sizes."""
    return jsonify({
        'queue_sizes': manager.get_queue_sizes(),
        'active': not manager.stop_event.is_set()
    })

@app.route('/api/download/status')
def get_download_status():
    """Full download manager snapshot for the /downloader dashboard."""
    return jsonify(manager.get_status())

def _song_row_to_client(item):
    """Serialize a songs-table row (joined as `s`) into the client song shape
    shared by the queue, history and playback-state responses."""
    return {
        'id': item['id'],
        'title': item['title'],
        'artist': item['artist'],
        'cover': item['cover'],
        'source': item['source'],
        'download_link': item['download_link'],
        'url': f'/audio/{os.path.basename(item["file_path"])}' if item['file_path'] else None,
        'start_time': item['start_time'],
        'end_time': item['end_time'],
    }

# Columns selected when joining a per-user playback table to `songs`.
_SONG_SELECT = 's.id, s.title, s.artist, s.cover, s.source, s.download_link, s.file_path, s.start_time, s.end_time'

@app.route('/api/queue/save', methods=['POST'])
def save_queue():
    """
    Save the current playback queue to the database.

    Request body:
        queue: Array of song objects with id, title, artist, etc.

    Returns:
        JSON response with success or error
    """
    data = request.get_json()
    queue = data.get('queue', [])

    if not isinstance(queue, list):
        return jsonify({'error': 'Queue must be an array'}), 400

    conn = get_db_connection()
    cursor = conn.cursor()

    user = current_user()
    try:
        # Clear this user's existing queue
        cursor.execute('DELETE FROM queue WHERE owner = ?', (user,))

        # Insert new queue items
        for position, song in enumerate(queue):
            if not isinstance(song, dict) or 'id' not in song:
                continue  # Skip invalid song objects

            # Find song_id from songs table (assuming id is the database id)
            song_id = song.get('id')
            if song_id and isinstance(song_id, int):
                cursor.execute('INSERT INTO queue (song_id, position, owner) VALUES (?, ?, ?)',
                               (song_id, position, user))

        conn.commit()
        return jsonify({'success': True, 'message': 'Queue saved successfully'})

    except Exception as e:
        conn.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()

@app.route('/api/queue/load')
def load_queue():
    """
    Load the playback queue from the database.

    Returns:
        JSON response with queue array
    """
    conn = get_db_connection()

    try:
        # Get queue with song details
        queue_items = conn.execute(f'''
            SELECT q.position, {_SONG_SELECT}
            FROM queue q
            JOIN songs s ON q.song_id = s.id
            WHERE q.owner = ?
            ORDER BY q.position
        ''', (current_user(),)).fetchall()

        queue = [_song_row_to_client(item) for item in queue_items]

        return jsonify({'queue': queue})

    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()

@app.route('/api/history', methods=['GET'])
def load_history():
    """Load the current user's recently-played history, most recent first."""
    conn = get_db_connection()
    try:
        rows = conn.execute(f'''
            SELECT h.position, {_SONG_SELECT}
            FROM play_history h
            JOIN songs s ON h.song_id = s.id
            WHERE h.owner = ?
            ORDER BY h.position
        ''', (current_user(),)).fetchall()
        return jsonify({'history': [_song_row_to_client(r) for r in rows]})
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()

@app.route('/api/history', methods=['POST'])
def save_history():
    """Replace the current user's history with the supplied list (most recent
    first). Capped at 100 entries to match the client."""
    data = request.get_json() or {}
    history = data.get('history', [])
    if not isinstance(history, list):
        return jsonify({'error': 'History must be an array'}), 400

    user = current_user()
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute('DELETE FROM play_history WHERE owner = ?', (user,))
        for position, song in enumerate(history[:100]):
            if not isinstance(song, dict):
                continue
            song_id = song.get('id')
            if isinstance(song_id, int):
                cursor.execute(
                    'INSERT INTO play_history (song_id, position, owner) VALUES (?, ?, ?)',
                    (song_id, position, user)
                )
        conn.commit()
        return jsonify({'success': True})
    except Exception as e:
        conn.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()

@app.route('/api/history', methods=['DELETE'])
def clear_history():
    """Clear the current user's recently-played history."""
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute('DELETE FROM play_history WHERE owner = ?', (current_user(),))
        conn.commit()
        return jsonify({'success': True})
    finally:
        conn.close()

# --- Listens & evergreens --------------------------------------------------
# A "listen" is a track the user played for more than LISTEN_THRESHOLD_SECONDS.
# The client accumulates real playback time (seeks and pauses don't inflate it)
# and posts once per play-through when the threshold is crossed.
LISTEN_THRESHOLD_SECONDS = 30

# Evergreens score only the most recent EVERGREEN_WINDOW listens: the newest one
# is worth EVERGREEN_WINDOW points, the one before it one point less, and so on
# down to 1. A song's score is the sum of the points of its listens in that
# window, so both "played a lot" and "played recently" push a track up.
EVERGREEN_WINDOW = 1000

# Human-readable append-only mirror of the listens table (JSON lines), handy for
# grepping playback history without opening the database.
LISTEN_LOG_PATH = os.path.join(app.root_path, 'listens.log')

def append_listen_log(entry):
    """Append one JSON line to the listen log. Never fails the request."""
    try:
        with open(LISTEN_LOG_PATH, 'a', encoding='utf-8') as f:
            f.write(json.dumps(entry) + '\n')
    except Exception as e:
        print(f"[Listens] WARNING: could not write {LISTEN_LOG_PATH}: {e}")

@app.route('/api/listens', methods=['POST'])
def log_listen():
    """
    Record a listen for the current user.

    Request body:
        song_id: int  - the song that was listened to
        seconds: float - how much of it was actually played

    Returns 200 {success, logged} — `logged` is False when the play was too
    short to count, which is not an error.
    """
    data = request.get_json() or {}
    song_id = data.get('song_id')
    seconds = data.get('seconds', 0)

    if not isinstance(song_id, int):
        return jsonify({'error': 'song_id must be an integer'}), 400
    try:
        seconds = float(seconds)
    except (TypeError, ValueError):
        return jsonify({'error': 'seconds must be a number'}), 400

    # The client already gates on this; re-check so a buggy or replayed client
    # can't stuff the log with skipped tracks.
    if seconds <= LISTEN_THRESHOLD_SECONDS:
        return jsonify({'success': True, 'logged': False,
                        'reason': f'under {LISTEN_THRESHOLD_SECONDS}s'})

    user = current_user()
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        song = conn.execute(
            'SELECT title, artist FROM songs WHERE id = ?', (song_id,)
        ).fetchone()
        if song is None:
            return jsonify({'error': 'Song not found'}), 404

        cursor.execute(
            'INSERT INTO listens (owner, song_id, seconds) VALUES (?, ?, ?)',
            (user, song_id, seconds)
        )
        conn.commit()
        listen_id = cursor.lastrowid
    except Exception as e:
        conn.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()

    append_listen_log({
        'id': listen_id,
        'ts': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'user': user,
        'song_id': song_id,
        'title': song['title'],
        'artist': song['artist'],
        'seconds': round(seconds, 1),
    })

    return jsonify({'success': True, 'logged': True, 'id': listen_id})

@app.route('/api/evergreens')
def get_evergreens():
    """
    Suggestions for the current user, ranked over their last EVERGREEN_WINDOW
    listens (see the scoring note on EVERGREEN_WINDOW).

    Query params:
        limit: how many tracks to return (default 100)

    Returns:
        JSON {evergreens: [song, ...]} where each song carries the usual client
        fields plus `score` and `listens` (its play count inside the window).
    """
    try:
        limit = int(request.args.get('limit', 100))
    except ValueError:
        limit = 100
    limit = max(1, min(limit, EVERGREEN_WINDOW))

    conn = get_db_connection()
    try:
        # Newest first: row ids are append-only, so id DESC is listen order.
        recent = conn.execute(
            'SELECT song_id FROM listens WHERE owner = ? ORDER BY id DESC LIMIT ?',
            (current_user(), EVERGREEN_WINDOW)
        ).fetchall()

        scores = {}
        counts = {}
        for index, row in enumerate(recent):
            song_id = row['song_id']
            scores[song_id] = scores.get(song_id, 0) + (EVERGREEN_WINDOW - index)
            counts[song_id] = counts.get(song_id, 0) + 1

        if not scores:
            return jsonify({'evergreens': []})

        ranked = sorted(scores, key=lambda sid: (-scores[sid], sid))

        # Songs can be deleted from the library after being listened to; missing rows
        # are skipped below rather than trimming the list early. Fetched in chunks so a
        # wide listen history stays under SQLite's bound-variable limit.
        by_id = {}
        for start in range(0, len(ranked), 500):
            chunk = ranked[start:start + 500]
            placeholders = ','.join('?' * len(chunk))
            rows = conn.execute(
                f'SELECT {_SONG_SELECT} FROM songs s WHERE s.id IN ({placeholders})',
                chunk
            ).fetchall()
            by_id.update({r['id']: r for r in rows})

        evergreens = []
        for song_id in ranked:
            row = by_id.get(song_id)
            if row is None:
                continue
            song = _song_row_to_client(row)
            song['score'] = scores[song_id]
            song['listens'] = counts[song_id]
            evergreens.append(song)
            if len(evergreens) >= limit:
                break

        return jsonify({'evergreens': evergreens})
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()

@app.route('/api/playback-state', methods=['GET'])
def get_playback_state():
    """Return the current user's resume point: the loaded song (or null) and the
    playback position in seconds."""
    conn = get_db_connection()
    try:
        row = conn.execute(f'''
            SELECT ps.position AS resume_position, {_SONG_SELECT}
            FROM playback_state ps
            JOIN songs s ON ps.song_id = s.id
            WHERE ps.owner = ?
        ''', (current_user(),)).fetchone()
        if not row:
            return jsonify({'song': None, 'position': 0})
        return jsonify({
            'song': _song_row_to_client(row),
            'position': row['resume_position'] or 0,
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()

@app.route('/api/playback-state', methods=['POST'])
def save_playback_state():
    """Upsert the current user's resume point. A null song_id clears it (e.g. the
    current track was removed)."""
    data = request.get_json() or {}
    song_id = data.get('song_id')
    position = data.get('position', 0)
    try:
        position = float(position)
    except (TypeError, ValueError):
        position = 0
    if song_id is not None and not isinstance(song_id, int):
        return jsonify({'error': 'song_id must be an integer or null'}), 400

    user = current_user()
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute('''
            INSERT INTO playback_state (owner, song_id, position, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(owner) DO UPDATE SET
                song_id = excluded.song_id,
                position = excluded.position,
                updated_at = CURRENT_TIMESTAMP
        ''', (user, song_id, position))
        conn.commit()
        return jsonify({'success': True})
    except Exception as e:
        conn.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()

@app.route('/api/play-feeders')
def get_play_feeders():
    """
    Get the current user's Play-tab feeder playlist ids.

    Returns only ids that still resolve to one of the user's playlists, so a
    deleted playlist silently drops out. The client maps these ids to full
    playlist data it already holds.
    """
    conn = get_db_connection()
    try:
        rows = conn.execute('''
            SELECT pf.playlist_id
            FROM play_feeders pf
            JOIN playlists p ON p.id = pf.playlist_id
            WHERE pf.owner = ? AND p.owner = ?
            ORDER BY pf.created_at
        ''', (current_user(), current_user())).fetchall()
        return jsonify({'feeders': [r['playlist_id'] for r in rows]})
    finally:
        conn.close()

@app.route('/api/play-feeders', methods=['POST'])
def add_play_feeder():
    """
    Designate one of the user's playlists as a Play-tab feeder.

    Request body:
        playlist_id: id of a playlist owned by the current user
    """
    data = request.get_json() or {}
    playlist_id = data.get('playlist_id')
    if not isinstance(playlist_id, int):
        return jsonify({'error': 'playlist_id is required'}), 400

    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        if not playlist_owned_by(conn, playlist_id, current_user()):
            return jsonify({'error': 'Playlist not found'}), 404
        cursor.execute(
            'INSERT OR IGNORE INTO play_feeders (owner, playlist_id) VALUES (?, ?)',
            (current_user(), playlist_id)
        )
        conn.commit()
        return jsonify({'success': True, 'playlist_id': playlist_id})
    finally:
        conn.close()

@app.route('/api/play-feeders/<int:playlist_id>', methods=['DELETE'])
def remove_play_feeder(playlist_id):
    """Remove a playlist from the current user's Play-tab feeders."""
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(
            'DELETE FROM play_feeders WHERE owner = ? AND playlist_id = ?',
            (current_user(), playlist_id)
        )
        conn.commit()
        return jsonify({'success': True})
    finally:
        conn.close()

# Flag to ensure manager starts only once
manager_started = False

@app.before_request
def start_download_manager():
    """Start the download manager on first request."""
    global manager_started
    if not manager_started:
        manager.start()
        fallback_manager.start()

        # Start event processing thread (drains both managers' event queues)
        def process_events_loop():
            import time
            while not manager.stop_event.is_set():
                try:
                    manager.process_events()
                    fallback_manager.process_events()
                    time.sleep(0.1)  # Process events every 100ms
                except Exception as e:
                    print(f"Error processing events: {e}")
                    break

        import threading
        event_thread = threading.Thread(target=process_events_loop, daemon=True, name="EventProcessor")
        event_thread.start()

        manager_started = True

import atexit
atexit.register(manager.stop)
atexit.register(fallback_manager.stop)

if __name__ == '__main__':
    host = os.environ.get('HOST', '0.0.0.0')
    port = int(os.environ.get('PORT', '8008'))

    # In production we serve with waitress (a real WSGI server) so there is no
    # Werkzeug "development server" warning. Set DEV=1 to use the Flask/SocketIO
    # dev server with auto-reload instead.
    if os.environ.get('DEV') == '1':
        socketio.run(app, debug=True, host=host, port=port)
    else:
        from waitress import serve
        print(f"SyncMusic4 running at http://{host}:{port}")
        serve(app, host=host, port=port, threads=8)
