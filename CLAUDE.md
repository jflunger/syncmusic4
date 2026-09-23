# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SyncMusic4 is a self-hosted music streaming + library-sync web app. Users search Spotify/YouTube/SoundCloud, download tracks to a local library, organize them into playlists, and keep playlists in sync with imported "feeder" playlists. A Flask backend serves both a REST/WebSocket API and a no-build-tools vanilla-JS frontend.

## Running

```bash
pip install -r requirements.txt        # installs flask, spotipy, yt-dlp, soundcloud-v2, votify (from git)
python server/app.py                   # main server on http://0.0.0.0:5000
```

The app is served at `/` from `server/static/`. There is no build step, no bundler, no test runner config — tests are standalone scripts:

```bash
python server/test_spotify.py          # exercises spotify_search.search_tracks
python server/test_soundcloud.py
python server/test_playlist.py
```

From `.clinerules`: **do not run ad-hoc/complex Python in the console to "test" code — it tends to freeze the IDE.** Running `python server/app.py` to launch the app is fine.

External CLI tools must be on PATH: `yt-dlp` (YouTube/SoundCloud audio) and `votify` (Spotify download, needs `cookies.txt` in the repo root). Spotify *search* credentials are hardcoded in `server/spotify_search.py`; `credentials.json` / `.cache` hold votify/Spotify auth state.

## Deploying and restarting

The app runs on a Hetzner box (`root@<server-ip>`, `~/syncmusic4`) behind nginx
at https://sm4.adun.ai, served by waitress on port 8008. `./deploy.sh` drives it all:

```bash
./deploy.sh up          # deploy + restart — the usual one
./deploy.sh restart     # restart only
./deploy.sh status      # tmux session, port, pid, health
./deploy.sh logs -100   # tail the tmux pane
```

`start.sh` is a **supervisor loop**, not a one-shot launcher — it is what the tmux
window `main:syncmusic4` runs. `POST /api/admin/restart` (shared key in
`admin_key.txt`, not a login session) makes the app `os._exit(42)`; the loop reads
42 as "relaunch" and brings it back. Any other non-zero code is treated as a crash
and also restarts, after a 3s pause. Only Ctrl-C in the tmux window (or exit 0)
breaks the loop — that is a real stop.

So: **never restart by killing the process.** `pkill -f 'server/app.py'` over ssh
matches the SSH command's own argv and kills the session; and a kill leaves the
loop to respawn it anyway. Use `./deploy.sh restart`.

## Backend architecture

`server/app.py` (~1400 lines) is the **only** server you run. It owns: static serving, all `/api/*` REST routes, audio streaming (`/audio/<file>`), Flask-SocketIO, SQLite schema + in-place migrations (`init_db()` plus `migrate_*` functions run at import), and it instantiates the single `DownloadManager`. Search (`/api/search`) is implemented **inline** here by shelling out to `yt-dlp` and calling the `soundcloud` library directly.

`server/download_manager.py` — `DownloadManager` runs one worker thread per platform (Spotify/YouTube/SoundCloud), each with its own `queue.Queue`, so platforms download in parallel but serially within a platform. Downloads go to `server/downloads/` (temp), get converted, then moved to `server/static/audio/` and inserted into the DB. Status changes are pushed to clients as WebSocket events via `_emit_event` → `process_events`.

**Standalone helper servers are NOT part of the running app.** `soundcloud_server.py` (port 5001), `youtube_server.py` (port 5002), and `spotify_downloader.py` are independent Flask apps / alternative implementations; the main app does not import or proxy to them. `spotify_downloader.py` is an explicit placeholder. Don't wire frontend calls to ports 5001/5002 expecting them to be up.

Data lives in `server/music.db` (SQLite). Core tables: `songs`, `playlists`, `playlist_songs` (M2M with position), `queue` (persisted playback queue), `feeder_playlists` (imported YT/SC playlist URLs attached to a playlist), `sync_items` (per-track download/sync progress driving the sync feature), `listens` (append-only log of plays over 30s, mirrored to `server/listens.log`, ranked into "evergreens" by `/api/evergreens`). Schema is created/altered at startup — to change it, add an idempotent `migrate_*` function rather than editing a `CREATE TABLE` in place.

## Frontend architecture

Lives in `server/static/`, loaded directly by the browser as ES modules — **no React/Vue, no Webpack/Vite, no JSX**. Adding a framework or build tool is explicitly forbidden by the project rules (`.cursor/rules`, `.kilocode/rules`, `.clinerules` — all identical).

- `static/js/components/` — native Web Components (Shadow DOM). `MusicApp.js` is the root; it owns the single `<audio>` element and mounts the three tabs once each (`DiscoverTab`, `CurateTab`, `PlayTab`), toggling visibility rather than re-creating them.
- `static/js/state/appState.js` — single Proxy-based reactive store (`appState`). Setting a property notifies subscribers, which re-render. **State is the source of truth, never the DOM.**
- `static/js/services/` — `api.js` (all `fetch` calls to `/api/*`) and `QueueManager.js` (play queue/history logic).

Conventions enforced by the repo rules: components `PascalCase`, custom elements `kebab-case`, functions `camelCase` and kept short; JSDoc on functions; component files carry a `Usage:` / `Emits:` comment. After adding a feature, update `docs/components.md` or `docs/api-events.md` with an example.

## Data flow (search → play)

1. Client `fetchSearch(query)` → `GET /api/search` → app.py runs yt-dlp + SoundCloud search, returns combined results tagged with `source` and a `download_link`.
2. Client enqueues a track → `POST /api/download` → `DownloadManager.add_download` routes it to the platform queue.
3. Worker downloads → file lands in `static/audio/`, row added to `songs`, WebSocket event emitted → client updates `downloadStatuses` in `appState`.
4. Playback streams from `/audio/<filename>`; queue/history persisted via `/api/queue/save` and `/api/queue/load`.
