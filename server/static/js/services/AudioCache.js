/**
 * AudioCache - keeps downloaded library audio on the device so a track that has been played (or
 * pre-buffered) once starts instantly afterwards, with no network at all.
 *
 * Files live in Cache Storage (`syncmusic-audio-v1`, which the service worker leaves alone on
 * CACHE_NAME bumps) and are handed to <audio> as blob: URLs. The service worker deliberately does
 * NOT serve /audio/ (see BYPASS in sw.js — a backgrounded iOS page can't rely on its worker for
 * ranged media), and a blob: URL needs no worker and no network: the element reads it locally.
 *
 * Audio URLs are immutable per file name, except a re-download can rewrite the same name — the
 * `song_redownloaded` socket event calls remove() for that.
 *
 * Space: ~4.5MB per track (library average), so MAX_BYTES holds ~1100 tracks. Usage is also capped
 * at a share of the origin's quota; the least recently played files are dropped first.
 *
 * Usage:
 *   import audioCache from './services/AudioCache.js';
 *   await audioCache.init();
 *   audioCache.has('/audio/x.mp3');             // sync: is it on the device?
 *   const src = await audioCache.objectUrl(url); // blob: URL, or null when not cached
 *   await audioCache.store(url);                // download into the cache (deduped, serial)
 */

const CACHE = 'syncmusic-audio-v1';
const META_KEY = 'audioCacheMeta';          // localStorage: { [url]: { size, used } }
const MAX_BYTES = 5 * 1024 ** 3;            // hard cap regardless of quota
const QUOTA_SHARE = 0.8;                    // never fill more than this share of the quota

class AudioCache {
  constructor() {
    this._meta = {};
    this._inflight = new Map();   // url -> Promise<boolean>
    this._chain = Promise.resolve(); // downloads run one at a time to spare the server
    this._ready = null;
  }

  /**
   * Load the index of cached files and ask for persistent storage (so the browser doesn't
   * evict the library under pressure). Safe to call repeatedly.
   * @returns {Promise<void>}
   */
  init() {
    if (!this._ready) this._ready = this._load();
    return this._ready;
  }

  /** @private */
  async _load() {
    if (!('caches' in self)) return;
    try { this._meta = JSON.parse(localStorage.getItem(META_KEY) || '{}'); } catch { this._meta = {}; }
    try {
      // Reconcile with what the cache really holds (the browser may have evicted it, or a write
      // landed without its metadata).
      const cache = await caches.open(CACHE);
      const keys = new Set((await cache.keys()).map((r) => new URL(r.url).pathname));
      for (const url of Object.keys(this._meta)) if (!keys.has(url)) delete this._meta[url];
      for (const url of keys) if (!this._meta[url]) this._meta[url] = { size: 0, used: 0 };
      this._save();
    } catch (err) {
      console.warn('AudioCache init failed', err);
    }
    navigator.storage?.persist?.().catch(() => {});
  }

  /** @private */
  _save() {
    try { localStorage.setItem(META_KEY, JSON.stringify(this._meta)); } catch (_) {}
  }

  /**
   * Is this audio URL stored on the device?
   * @param {string} url - e.g. /audio/x.mp3
   * @returns {boolean}
   */
  has(url) {
    return !!(url && this._meta[url]);
  }

  /**
   * A blob: URL for a cached file (caller should revoke it when done), or null if not cached.
   * @param {string} url
   * @returns {Promise<string|null>}
   */
  async objectUrl(url) {
    if (!this.has(url)) return null;
    try {
      const res = await (await caches.open(CACHE)).match(url);
      if (!res) { this._forget(url); return null; }
      const blob = await res.blob();
      this._meta[url].used = Date.now();
      this._save();
      return URL.createObjectURL(blob);
    } catch (err) {
      console.warn('AudioCache read failed', url, err);
      return null;
    }
  }

  /**
   * Download a file into the cache. Concurrent calls for the same URL share one download, and
   * downloads queue behind each other.
   * @param {string} url
   * @returns {Promise<boolean>} true once the file is cached
   */
  store(url) {
    if (!url || !('caches' in self)) return Promise.resolve(false);
    if (this.has(url)) return Promise.resolve(true);
    if (this._inflight.has(url)) return this._inflight.get(url);
    const job = this._chain.then(() => this._download(url));
    this._chain = job.catch(() => {});
    this._inflight.set(url, job);
    job.finally(() => this._inflight.delete(url));
    return job;
  }

  /** @private */
  async _download(url) {
    await this.init();
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok || res.status !== 200) return false;
      // Read the whole body first: the real byte count keeps the LRU accounting honest even when
      // a proxy drops Content-Length, and a cut-off download never lands in the cache.
      const blob = await res.blob();
      const size = blob.size;
      await this._makeRoom(size);
      const cache = await caches.open(CACHE);
      try {
        await cache.put(url, new Response(blob, { headers: { 'Content-Type': blob.type || 'audio/mpeg' } }));
      } catch (err) {
        // iOS rejects put() on a full origin instead of evicting: drop the oldest and give up on
        // this one rather than looping.
        console.warn('AudioCache put failed', url, err);
        await this._evictOldest(Math.max(size, 50 * 1024 ** 2));
        return false;
      }
      this._meta[url] = { size, used: Date.now() };
      this._save();
      return true;
    } catch (err) {
      console.warn('AudioCache download failed', url, err);
      return false;
    }
  }

  /**
   * Evict least recently used files until `incoming` more bytes fit under both caps.
   * @private
   * @param {number} incoming
   */
  async _makeRoom(incoming) {
    let limit = MAX_BYTES;
    try {
      const { quota, usage } = await navigator.storage.estimate();
      // Room = our own bytes + whatever the origin has left, within the quota share.
      if (quota) limit = Math.min(limit, this._total() + quota * QUOTA_SHARE - usage);
    } catch (_) {}
    const over = this._total() + incoming - limit;
    if (over > 0) await this._evictOldest(over);
  }

  /** @private */
  _total() {
    return Object.values(this._meta).reduce((n, m) => n + (m.size || 0), 0);
  }

  /**
   * @private
   * @param {number} bytes - free at least this much
   */
  async _evictOldest(bytes) {
    const cache = await caches.open(CACHE);
    const oldest = Object.entries(this._meta).sort((a, b) => a[1].used - b[1].used);
    let freed = 0;
    for (const [url, m] of oldest) {
      if (freed >= bytes) break;
      await cache.delete(url);
      delete this._meta[url];
      freed += m.size || 0;
    }
    this._save();
  }

  /**
   * Drop a file (its content changed on the server, e.g. a re-download in place).
   * @param {string} url
   */
  async remove(url) {
    this._forget(url);
    try { await (await caches.open(CACHE)).delete(url); } catch (_) {}
  }

  /** @private */
  _forget(url) {
    delete this._meta[url];
    this._save();
  }

  /**
   * Bytes and file count currently cached on the device.
   * @returns {{bytes: number, files: number}}
   */
  stats() {
    return { bytes: this._total(), files: Object.keys(this._meta).length };
  }
}

const audioCache = new AudioCache();
export default audioCache;
