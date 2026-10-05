# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SyncMusic4 is a self-hosted music streaming + library-sync web app. Users search Spotify/YouTube/SoundCloud, download tracks to a local library, organize them into playlists, and keep playlists in sync with imported "feeder" playlists. A Flask backend serves both a REST/WebSocket API and a no-build-tools vanilla-JS frontend.

## Running

```bash
pip install -r requirements.txt        # installs flask, spotipy, yt-dlp, soundcloud-v2, votify (from git)
python server/app.py                   # listens on $PORT (default 8008) — in prod vibe runs it, see below
```

The app is served at `/` from `server/static/`. There is no build step, no bundler, no test runner config — tests are standalone scripts:

```bash
python server/test_spotify.py          # exercises spotify_search.search_tracks
python server/test_soundcloud.py
python server/test_playlist.py
```

From `.clinerules`: **do not run ad-hoc/complex Python in the console to "test" code — it tends to freeze the IDE.** Running `python server/app.py` to launch the app is fine.

External CLI tools must be on PATH: `yt-dlp` (YouTube/SoundCloud audio) and `votify` (Spotify download, needs `cookies.txt` in the repo root). Spotify *search* credentials are hardcoded in `server/spotify_search.py`; `credentials.json` / `.cache` hold votify/Spotify auth state.

## Production: this machine

**This checkout is production.** `/root/syncmusic4` on the Hetzner box (<server-ip>)
is the live app behind nginx at https://sm4.adun.ai, and `server/music.db` here is
the live database. There is no separate deploy step: edits here go live on the next
restart. Treat the DB as production data — query it read-only (`sqlite3 -readonly`)
unless a write is intended.

The app is a **vibe** project (`VIBE_PROJECT=syncmusic4`). vibe runs `./run.sh` in
the tmux session `p-syncmusic4` with `PORT=8008` (the port nginx proxies to);
output goes to `/var/lib/vibe/logs/syncmusic4.log`. nginx config:
`deploy/nginx-sm4.conf`.

- Restart / status / logs: use the vibe MCP tools `project_restart`,
  `project_status`, `project_logs`. After a runtime change, restart and read the
  returned logs to confirm the app came back.
- Never start, kill or daemonize the app yourself (no `nohup`, `&`, `pkill`).
- Don't commit — vibe commits nightly.

`run.sh` execs `start.sh`, which is a **supervisor loop**, not a one-shot launcher:
`POST /api/admin/restart` (shared key in `admin_key.txt`) makes the app
`os._exit(42)` and the loop relaunches it; any other non-zero exit is treated as a
crash and restarted after 3s; exit 0 (or Ctrl-C) stops the loop.

## Backend architecture

`server/app.py` (~1400 lines) is the **only** server you run. It owns: static serving, all `/api/*` REST routes, audio streaming (`/audio/<file>`), Flask-SocketIO, SQLite schema + in-place migrations (`init_db()` plus `migrate_*` functions run at import), and it instantiates the single `DownloadManager`. Search (`/api/search`) is implemented **inline** here by shelling out to `yt-dlp` and calling the `soundcloud` library directly.

`server/download_manager.py` — `DownloadManager` runs one worker thread per platform (Spotify/YouTube/SoundCloud), each with its own `queue.Queue`, so platforms download in parallel but serially within a platform. Downloads go to `server/downloads/` (temp), get converted, then moved to `server/static/audio/` and inserted into the DB. Status changes are pushed to clients as WebSocket events via `_emit_event` → `process_events`.

**Standalone helper servers are NOT part of the running app.** `soundcloud_server.py` (port 5001), `youtube_server.py` (port 5002), and `spotify_downloader.py` are independent Flask apps / alternative implementations; the main app does not import or proxy to them. `spotify_downloader.py` is an explicit placeholder. Don't wire frontend calls to ports 5001/5002 expecting them to be up.

Data lives in `server/music.db` (SQLite). Core tables: `songs`, `playlists`, `playlist_songs` (M2M with position), `queue` (persisted playback queue), `feeder_playlists` (imported YT/SC playlist URLs attached to a playlist), `sync_items` (per-track download/sync progress driving the sync feature), `listens` (append-only log of plays over 30s, mirrored to `server/listens.log`, ranked into "evergreens" by `/api/evergreens`). Schema is created/altered at startup — to change it, add an idempotent `migrate_*` function rather than editing a `CREATE TABLE` in place.

## Frontend architecture

Lives in `server/static/`, loaded directly by the browser as ES modules — **no React/Vue, no Webpack/Vite, no JSX**. Adding a framework or build tool is explicitly forbidden by the project rules (`.cursor/rules`, `.kilocode/rules`, `.clinerules` — all identical).

**Bump the service-worker cache after every frontend change.** `server/static/sw.js` is cache-first, so a UI change (any JS/CSS/HTML under `static/`) stays invisible to clients until `CACHE_NAME` (`'syncmusic-vN'`) is incremented. Do it as part of the change itself, not as an afterthought — a hard refresh or server restart alone does not help.

- `static/js/components/` — native Web Components (Shadow DOM). `MusicApp.js` is the root; it owns the single `<audio>` element and mounts the three tabs once each (`DiscoverTab`, `CurateTab`, `PlayTab`), toggling visibility rather than re-creating them.
- `static/js/state/appState.js` — single Proxy-based reactive store (`appState`). Setting a property notifies subscribers, which re-render. **State is the source of truth, never the DOM.**
- `static/js/services/` — `api.js` (all `fetch` calls to `/api/*`) and `QueueManager.js` (play queue/history logic).

Conventions enforced by the repo rules: components `PascalCase`, custom elements `kebab-case`, functions `camelCase` and kept short; JSDoc on functions; component files carry a `Usage:` / `Emits:` comment. After adding a feature, update `docs/components.md` or `docs/api-events.md` with an example.

## Data flow (search → play)

1. Client `fetchSearch(query)` → `GET /api/search` → app.py runs yt-dlp + SoundCloud search, returns combined results tagged with `source` and a `download_link`.
2. Client enqueues a track → `POST /api/download` → `DownloadManager.add_download` routes it to the platform queue.
3. Worker downloads → file lands in `static/audio/`, row added to `songs`, WebSocket event emitted → client updates `downloadStatuses` in `appState`.
4. Playback streams from `/audio/<filename>`; queue/history persisted via `/api/queue/save` and `/api/queue/load`.
