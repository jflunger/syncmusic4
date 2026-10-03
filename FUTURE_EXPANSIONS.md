# Possible Future Expansions

## Offline mode (PWA)

The PWA could play music fully offline. First, fix `sw.js` so it caches the whole app shell; today it lists only 9 of the 17 JS modules, so the app can't even boot offline. Second, keep a snapshot of the library and playlists, either as a network-first fallback for `GET /api/*` or in IndexedDB. Third, add opt-in "available offline" playlists: tracks and cover art are stored as blobs and played through `URL.createObjectURL`, which keeps the service worker out of the `<audio>` range-request path (the iOS issue described in `sw.js`). Offline writes, mainly listens and queue saves, would go into an outbox and replay when the network returns. Search, downloads and feeder sync stay online-only. Storage is the main constraint: the full library is about 1.3 GB and iOS can evict it, so cache per playlist and call `navigator.storage.persist()`.

## Fishing discovery (the worst track discovery mechanism ever)

A minigame for finding new music. The cover art of recommended tracks swims as fish left and right across a pond, at different depths and speeds. The user casts and steers a fishing rod whose bobber and line follow physics: gravity, line tension, a bit of drag, and some sway. The first cover the bobber touches is caught, and that track plays right away, whether the user wanted it or not. Recommendations could come from `server/related_tracks.py`, seeded by the current track or by evergreens. Draw it on a `<canvas>` inside a Web Component, without a game engine, to keep to the no-framework rule.
