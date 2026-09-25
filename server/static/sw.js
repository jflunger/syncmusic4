/**
 * Service Worker for SyncMusic4 PWA.
 */

// Bump this on EVERY change to index.html / styles.css / manifest.json or any cached
// asset. The fetch handler is cache-first, so clients keep serving the old copy until
// CACHE_NAME changes — forgetting this is how the iOS PWA fullscreen fix keeps "regressing"
// even when the source files are correct. See docs/ios-pwa-fullscreen.md.
const CACHE_NAME = 'syncmusic-v15';
const CACHE_FILES = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/state/appState.js',
  '/js/services/api.js',
  '/js/components/MusicApp.js',
  '/js/components/DiscoverTab.js',
  '/js/components/PlayTab.js',
  '/js/components/CurateTab.js',
  '/js/components/SongItem.js',
  '/js/components/TrackEditor.js',
  '/js/components/PlaylistItem.js',
  '/manifest.json'
];

self.addEventListener('install', event => {
  console.log('SW installing');
  // Don't sit in the "waiting" state until every tab/PWA instance is closed. On a phone the
  // PWA is never really closed, so a bumped CACHE_NAME alone can take days to take effect and
  // the fix looks like it was never deployed. Take over as soon as the new files are cached.
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(CACHE_FILES);
    })
  );
});

self.addEventListener('activate', event => {
  console.log('SW activating');
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())  // serve the already-open page too, not just the next load
  );
});

// Requests the worker must NOT touch. Anything matched here is left to the browser entirely —
// we don't even call respondWith.
//
// /audio/ is the important one: those are ranged media requests driving <audio>. Proxying them
// through the worker gains nothing (they're never cached) and costs a lot — the worker has to be
// woken for every range the player asks for, and on iOS a backgrounded page's worker may not be
// spun up in time, so the track that was supposed to start next simply never loads. Media goes
// straight to the network.
//
// /api/ and /socket.io/ are live data; a cache-first worker must never sit in front of them.
const BYPASS = /^\/(audio|api|socket\.io)\//;

self.addEventListener('fetch', event => {
  if (!event.request.url.startsWith(self.location.origin)) return; // CDN etc. — pass through
  if (event.request.method !== 'GET') return;
  if (event.request.headers.has('range')) return;                  // media/byte-range requests
  if (BYPASS.test(new URL(event.request.url).pathname)) return;

  event.respondWith(
    caches.match(event.request).then(response => response || fetch(event.request))
  );
});