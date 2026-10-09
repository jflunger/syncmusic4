/**
 * Queue Manager service - Manages the queue of next songs to play and history of played songs.
 * Client-side service that handles enqueueing, dequeuing, and saving state to server.
 */

import appState, { socket } from '../state/appState.js';
import { saveQueue, loadQueue, saveHistory, loadHistory, clearHistory as clearHistoryApi } from './api.js';

class QueueManager {
  /**
   * @param {Object} appState - The app state instance
   */
  constructor(appState) {
    this.appState = appState;
    this.queue = [];
    this.history = []; // Previously played songs, max 100
    this._saveTimer = null; // Trailing-debounce handle for queue saves
    this.loadState();
    // Pending tracks (enqueued from search before they're downloaded) turn into the real
    // library song once the download lands — the songs refresh after 'download_completed'
    // is what makes that visible — and are dropped if their download fails.
    appState.subscribe((key, value) => {
      if (key === 'songs') this.resolvePending(value);
      if (key === 'downloadStatuses') this.dropFailedPending(value);
    });
    // A burst of enqueues should collapse into one save; flush any pending save if the
    // page is being unloaded so the last change isn't lost inside the debounce window.
    window.addEventListener('beforeunload', () => this.flushSave());
  }

  /**
   * Load queue state from server
   */
  async loadState() {
    try {
      this.queue = await loadQueue();
      this.appState.set('queue', [...this.queue]);
      this.resolvePending(this.appState.get('songs'));
    } catch (error) {
      console.error('Failed to load queue:', error);
      this.queue = [];
      this.appState.set('queue', []);
    }
    try {
      this.history = await loadHistory();
      this.appState.set('history', [...this.history]);
    } catch (error) {
      console.error('Failed to load history:', error);
      this.history = [];
      this.appState.set('history', []);
    }
  }

  /**
   * Save current queue state to server
   */
  async saveState() {
    try {
      await saveQueue(this.queue);
    } catch (error) {
      console.error('Failed to save queue:', error);
    }
  }

  /**
   * Queue a save on a trailing debounce. Rapid mutations (e.g. enqueuing several tracks
   * in a row) collapse into a single full-queue POST instead of one per change.
   */
  scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveState();
    }, 400);
  }

  /**
   * Save immediately if a debounced save is pending (e.g. on page unload).
   */
  flushSave() {
    if (!this._saveTimer) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    this.saveState();
  }

  /**
   * Add a song to the queue
   * @param {Object} song - Song object to enqueue
   */
  enqueue(song) {
    this.queue.push(song);
    this._commit();
  }

  /**
   * Add a song to the FRONT of the queue (next up). Used when stepping to the previous track so
   * the song you're leaving is replayed first when you go forward again — making back/forward
   * feel like one continuous list. Any existing copy is removed first so it isn't duplicated.
   * @param {Object} song - Song object to put at the head of the queue
   */
  prepend(song) {
    if (!song || song.id == null) return;
    this.queue = this.queue.filter(s => String(s.id) !== String(song.id));
    this.queue.unshift(song);
    this._commit();
  }

  /**
   * Remove and return the next song from the queue
   * @returns {Object|null} Next song or null if empty
   */
  dequeue() {
    if (this.queue.length === 0) return null;
    const song = this.queue.shift();
    this._commit();
    return song;
  }

  /**
   * Get the next song without removing it
   * @returns {Object|null} Next song or null if empty
   */
  peek() {
    return this.queue.length > 0 ? this.queue[0] : null;
  }

  /**
   * Clear the entire queue
   */
  clear() {
    this.queue = [];
    this._commit();
  }

  /**
   * Move a song to first position in the queue by index
   * @param {number} index - Current index of the song
   */
  moveToFirst(index) {
    if (index > 0 && index < this.queue.length) {
      const [song] = this.queue.splice(index, 1);
      this.queue.unshift(song);
      this._commit();
    }
  }

  /**
   * Find index of a song in the queue by id
   * @param {string|number} songId - Song id to find
   * @returns {number} Index or -1 if not found
   */
  indexOf(songId) {
    return this.queue.findIndex(s => String(s.id) === String(songId));
  }

  /**
   * Remove a specific song from the queue by index
   * @param {number} index - Index to remove
   */
  remove(index) {
    if (index >= 0 && index < this.queue.length) {
      this.queue.splice(index, 1);
      this._commit();
    }
  }

  /**
   * Remove a song from the queue by id. Resolving against the live queue (rather than a
   * numeric index captured elsewhere) keeps removal tied to the track's actual position.
   * @param {string|number} songId - Song id to remove
   * @returns {boolean} true if a song was removed
   */
  removeById(songId) {
    const index = this.indexOf(songId);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    this._commit();
    return true;
  }

  /**
   * Patch a queued song in place by id (e.g. after editing its metadata) and propagate.
   * @param {string|number} songId - Song id to update
   * @param {Object} patch - Fields to merge into the queued entry
   * @returns {boolean} true if a song was updated
   */
  updateSong(songId, patch) {
    const index = this.indexOf(songId);
    if (index < 0) return false;
    this.queue[index] = { ...this.queue[index], ...patch };
    this._commit();
    return true;
  }

  /**
   * Swap every pending entry whose download has landed for its library song, in place. If
   * that song is already queued elsewhere the pending copy is just dropped.
   * @param {Array<Object>} songs - The library (appState 'songs')
   */
  resolvePending(songs) {
    if (!this.queue.some(s => s.pending) || !songs?.length) return;
    const byLink = new Map(songs.filter(s => s.download_link && s.url).map(s => [s.download_link, s]));
    let changed = false;
    const ids = new Set(this.queue.filter(s => !s.pending).map(s => String(s.id)));
    this.queue = this.queue.flatMap((entry) => {
      const song = entry.pending && byLink.get(entry.download_link);
      if (!song) return [entry];
      changed = true;
      if (ids.has(String(song.id))) return [];
      ids.add(String(song.id));
      return [song];
    });
    if (changed) this._commit();
  }

  /**
   * Remove pending entries whose download failed — they can never become playable.
   * @param {Object} statuses - appState 'downloadStatuses' (download_link → status)
   */
  dropFailedPending(statuses) {
    const keep = this.queue.filter(s => !(s.pending && statuses?.[s.download_link] === 'failed'));
    if (keep.length === this.queue.length) return;
    this.queue = keep;
    this._commit();
  }

  /**
   * Push the current queue everywhere it needs to go: the reactive store (drives every
   * song-item indicator + the Play tab list), the server, and other clients via socket.
   */
  _commit() {
    this.appState.set('queue', [...this.queue]);
    this.scheduleSave();
    this.emitQueueUpdated();
  }

  /**
   * Push the current history everywhere it needs to go: the reactive store and the server.
   */
  _commitHistory() {
    this.appState.set('history', [...this.history]);
    saveHistory(this.history).catch(err => console.error('Failed to save history:', err));
  }

  /**
   * Add a song to the history (previously played songs)
   * @param {Object} song - Song object to add to history
   */
  addToHistory(song) {
    // Remove if already in history to avoid duplicates
    this.history = this.history.filter(s => s.id !== song.id);
    // Add to beginning of history
    this.history.unshift(song);
    // Keep only last 100 songs
    if (this.history.length > 100) {
      this.history = this.history.slice(0, 100);
    }
    this._commitHistory();
  }

  /**
   * Remove a song from history by id and persist (used when stepping back to it).
   * @param {string|number} songId
   */
  dropFromHistory(songId) {
    this.history = this.history.filter(s => String(s.id) !== String(songId));
    this._commitHistory();
  }

  /**
   * Get the previously played song
   * @returns {Object|null} Previous song or null if no history
   */
  getPrevious() {
    return this.history.length > 0 ? this.history[0] : null;
  }

  /**
   * Clear the history locally and on the server.
   */
  clearHistory() {
    this.history = [];
    this.appState.set('history', []);
    clearHistoryApi().catch(err => console.error('Failed to clear history:', err));
  }

  /**
   * Get history array
   * @returns {Array} History of played songs
   */
  getHistory() {
    return [...this.history];
  }

  /**
   * Emit queue updated event via WebSocket
   */
  emitQueueUpdated() {
    if (socket) {
      socket.emit('queue_updated', { queue: this.queue });
    }
  }
}

/**
 * Queue entry for a search result that isn't downloaded yet. The player skips it until the
 * download finishes and resolvePending swaps in the real song. The id is derived from the
 * link (same shape the server returns from /api/queue/load) so repeat taps find it.
 * @param {Object} track - Search result: { title, artist, source, url, cover }
 * @returns {Object} Pending song
 */
export function pendingSong(track) {
  return {
    id: `pending:${track.url}`,
    pending: true,
    title: track.title,
    artist: track.artist,
    cover: track.cover || null,
    source: track.source,
    download_link: track.url,
    url: null,
  };
}

// Create singleton instance
const queueManager = new QueueManager(appState);

export default queueManager;