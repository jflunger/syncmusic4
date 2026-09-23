#!/usr/bin/env python3
"""
Re-download SoundCloud "snippet" tracks already in the library.

Background
----------
SoundCloud Go+/preview-only tracks could previously only be fetched by yt-dlp as
a ~30s preview, which exited 0 and got stored as if it were the full track. Those
truncated files are still sitting in the library. This script finds them and
forces a re-download through the DownCloudMe fallback (downcloud_manager), which
can fetch the full track. Each fixed track keeps its existing song id (so
playlists, the play queue and sync_items all stay intact) — only the audio file
is swapped.

Detection
---------
A song is a candidate if its source is 'soundcloud' and the real duration of its
audio file (via ffprobe) is under the threshold (default 31s — a Go+ preview is
~30s). Genuinely short tracks under 31s will also match; review the dry-run list
before applying, or pass --threshold to tighten it.

Usage
-----
    # Dry run — list affected tracks, change nothing (default):
    python migration_scripts/redownload_soundcloud_snippets.py

    # Actually re-download the affected tracks through the fallback:
    python migration_scripts/redownload_soundcloud_snippets.py --apply

    # Useful flags:
    #   --threshold 31     seconds; files shorter than this are candidates
    #   --limit N          only process the first N candidates
    #   --timeout 1800     overall seconds to wait for re-downloads (with --apply)
    #   --db / --audio     override the music.db / static/audio locations

Run this on the server (it needs network access for downcloudme.com). It is
safest to run while the app is stopped to avoid two processes writing music.db
at once, though SQLite's locking will tolerate brief overlap.
"""

import argparse
import os
import shutil
import subprocess
import sys
import time

# Locate the project's server/ dir (sibling of this migration_scripts/ folder)
# and import the fallback machinery from there.
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER_DIR = os.path.join(REPO_ROOT, 'server')
sys.path.insert(0, SERVER_DIR)

import sqlite3  # noqa: E402  (after sys.path tweak, for symmetry with below)
from download_manager import SNIPPET_MAX_SECONDS  # noqa: E402
from downcloud_manager import DownCloudManager, PLATFORM  # noqa: E402

DEFAULT_DB = os.path.join(SERVER_DIR, 'music.db')
DEFAULT_AUDIO = os.path.join(SERVER_DIR, 'static', 'audio')


def probe_duration(path):
    """
    Return the real audio duration (seconds) of a file via ffprobe, or None if
    the file is missing or ffprobe is unavailable/fails.
    """
    if not path or not os.path.isfile(path):
        return None
    if not shutil.which('ffprobe'):
        print("ERROR: ffprobe not found on PATH — cannot measure durations.")
        sys.exit(2)
    try:
        result = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=noprint_wrappers=1:nokey=1', path],
            capture_output=True, text=True
        )
        return float(result.stdout.strip())
    except (ValueError, OSError):
        return None


def resolve_file(file_path, audio_dir):
    """
    Resolve a song's stored file path to something that exists on this machine.
    Falls back to <audio_dir>/<basename> if the stored absolute path moved
    (e.g. the repo was relocated since download time).
    """
    if file_path and os.path.isfile(file_path):
        return file_path
    if file_path:
        candidate = os.path.join(audio_dir, os.path.basename(file_path))
        if os.path.isfile(candidate):
            return candidate
    return None


def find_candidates(db_path, audio_dir, threshold, limit):
    """
    Return a list of dicts for SoundCloud songs whose audio file is shorter than
    `threshold` seconds. Also reports songs whose file is missing entirely.
    """
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, title, artist, cover, source, download_link, file_path "
        "FROM songs WHERE source = 'soundcloud' ORDER BY id"
    ).fetchall()
    conn.close()

    candidates, missing = [], []
    for row in rows:
        resolved = resolve_file(row['file_path'], audio_dir)
        if resolved is None:
            missing.append(dict(row))
            continue
        duration = probe_duration(resolved)
        if duration is not None and duration < threshold:
            candidates.append({**dict(row), 'duration': duration})

    if missing:
        print(f"\nNote: {len(missing)} SoundCloud song(s) have a missing audio "
              f"file (not touched):")
        for m in missing:
            print(f"  id={m['id']:<6} {m['title']} — {m['artist']}  ({m['file_path']})")

    if limit:
        candidates = candidates[:limit]
    return candidates


def enqueue_redownload(dc, song):
    """
    Queue a re-download of an existing song row onto the fallback manager.

    Bypasses dc.add_download() (which would reject the track as a duplicate,
    since the row already exists) and puts the job straight on the worker queue
    with `redownload_song_id` set, so the fetched file replaces the existing
    row's audio in place rather than inserting a new song.
    """
    dc.queues[PLATFORM].put({
        'source': PLATFORM,
        'download_link': song['download_link'],
        'title': song['title'],
        'artist': song['artist'],
        'cover': song['cover'],
        'redownload_song_id': song['id'],
    })


def apply_redownloads(candidates, db_path, audio_dir, timeout):
    """
    Re-download every candidate through the DownCloudMe fallback, then report
    which ones are now full-length. Returns the number of tracks fixed.
    """
    downloads_dir = os.path.join(SERVER_DIR, 'downloads', 'migration_downcloud')
    dc = DownCloudManager(db_path=db_path, audio_path=audio_dir,
                          downloads_path=downloads_dir)
    dc.start()

    for song in candidates:
        enqueue_redownload(dc, song)
    print(f"\nQueued {len(candidates)} re-download(s) through the DownCloudMe "
          f"fallback. Waiting up to {timeout}s...")

    target = len(candidates)
    deadline = time.time() + timeout
    while time.time() < deadline:
        dc.process_events()  # no socketio here, so this just drains the queue
        done = dc.stats['completed'] + dc.stats['failed']
        if done >= target:
            break
        time.sleep(1)
    dc.process_events()
    # Halt workers without join() (avoids blocking on anything still unprocessed
    # after a timeout); the daemon threads die with the process.
    dc.stop_event.set()

    # Report outcome by re-measuring each track's file in the DB.
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    fixed = 0
    print("\nResults:")
    for song in candidates:
        row = conn.execute("SELECT file_path FROM songs WHERE id = ?",
                           (song['id'],)).fetchone()
        new_dur = probe_duration(resolve_file(row['file_path'], audio_dir)) if row else None
        if new_dur is not None and new_dur >= SNIPPET_MAX_SECONDS:
            fixed += 1
            status = f"FIXED  ({song['duration']:.0f}s -> {new_dur:.0f}s)"
        elif new_dur is not None:
            status = f"still short ({new_dur:.0f}s) — fallback could not get full track"
        else:
            status = "unchanged / file missing — re-download failed"
        print(f"  id={song['id']:<6} [{status}]  {song['title']} — {song['artist']}")
    conn.close()

    print(f"\nDone. {fixed}/{len(candidates)} track(s) replaced with the full version.")
    print(f"Fallback stats: {dc.stats}")
    return fixed


def main():
    parser = argparse.ArgumentParser(
        description="Re-download truncated SoundCloud snippet tracks via the "
                    "DownCloudMe fallback.")
    parser.add_argument('--apply', action='store_true',
                        help="Perform the re-downloads (default is a dry run).")
    parser.add_argument('--threshold', type=float, default=SNIPPET_MAX_SECONDS,
                        help=f"Max duration (s) to treat as a snippet "
                             f"(default {SNIPPET_MAX_SECONDS}).")
    parser.add_argument('--limit', type=int, default=0,
                        help="Only process the first N candidates.")
    parser.add_argument('--timeout', type=int, default=1800,
                        help="Overall seconds to wait for re-downloads (--apply).")
    parser.add_argument('--db', default=DEFAULT_DB, help="Path to music.db.")
    parser.add_argument('--audio', default=DEFAULT_AUDIO,
                        help="Path to the static/audio library dir.")
    args = parser.parse_args()

    if not os.path.isfile(args.db):
        print(f"ERROR: database not found: {args.db}")
        sys.exit(1)
    if not os.path.isdir(args.audio):
        print(f"ERROR: audio dir not found: {args.audio}")
        sys.exit(1)

    print(f"DB:        {args.db}")
    print(f"Audio dir: {args.audio}")
    print(f"Threshold: < {args.threshold}s")

    candidates = find_candidates(args.db, args.audio, args.threshold, args.limit)
    if not candidates:
        print("\nNo snippet tracks found. Nothing to do.")
        return

    print(f"\nFound {len(candidates)} snippet track(s):")
    for song in candidates:
        print(f"  id={song['id']:<6} {song['duration']:>5.0f}s  "
              f"{song['title']} — {song['artist']}")

    if not args.apply:
        print("\nDry run only. Re-run with --apply to re-download these through "
              "the DownCloudMe fallback.")
        return

    apply_redownloads(candidates, args.db, args.audio, args.timeout)


if __name__ == '__main__':
    main()
