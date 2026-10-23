/**
 * App state management using Proxy-based reactivity.
 */

const initialState = {
    currentTab: 'discover',
    songs: [],
    currentSong: null,
    playlists: [],
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    volume: 1.0,
    downloadStatuses: {}, // Track download status by URL: 'queued' | 'downloading' | 'completed' | 'failed'
    syncStatuses: {}, // Track sync item statuses by playlist_id: { [playlistId]: [{download_link, status, song_id}] }
    queue: [], // Queue of next songs to play
    playFeeders: [], // Playlist ids to draw from at random when the queue is exhausted
    history: [], // History of previously played songs
    relatedUpdate: null, // Last 'related_updated' socket event: { song_id, status, count?, error? }
    discoverUpdate: null, // Last 'discover_updated' socket event for any user: { owner }
    workingPlaylist: null, // The currently selected working playlist (used by song-item membership UI)
    evergreens: [], // Top suggestions ranked from the user's last 1000 listens (Curate → Tracks)
    currentUser: null // Logged-in username, or null when not authenticated
 };

class AppState {
  /**
   * @param {Object} state - Initial state object
   */
  constructor(state) {
    this.listeners = new Set();
    this.state = new Proxy({ ...state }, {
      set: (target, property, value) => {
        target[property] = value;
        this.listeners.forEach(listener => listener(property, value));
        return true;
      }
    });
  }

  /**
   * Subscribe to state changes
   * @param {Function} listener - Called with (property, value) on change
   * @returns {Function} Unsubscribe function
   */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Get current state value
   * @param {string} key - State property
   * @returns {*} State value
   */
  get(key) {
    return this.state[key];
  }

  /**
   * Set state value
   * @param {string} key - State property
   * @param {*} value - New value
   */
  set(key, value) {
    this.state[key] = value;
  }

  /**
   * Update multiple properties
   * @param {Object} updates - Object with property updates
   */
  update(updates) {
    Object.assign(this.state, updates);
  }
}

const appState = new AppState(initialState);

// Initialize WebSocket connection when io is available
let socket = null;

function initializeWebSocket() {
  if (typeof io !== 'undefined' && !socket) {
    socket = io();

    // Handle download status events
    socket.on('download_queued', (data) => {
      const downloadStatuses = { ...appState.get('downloadStatuses') };
      downloadStatuses[data.url] = 'queued';
      appState.set('downloadStatuses', downloadStatuses);
    });

    socket.on('download_started', (data) => {
      const downloadStatuses = { ...appState.get('downloadStatuses') };
      downloadStatuses[data.url] = 'downloading';
      appState.set('downloadStatuses', downloadStatuses);
    });

    socket.on('download_completed', (data) => {
      const downloadStatuses = { ...appState.get('downloadStatuses') };
      downloadStatuses[data.url] = 'completed';
      appState.set('downloadStatuses', downloadStatuses);

      // Refresh songs list to include new download
      setTimeout(() => {
        import('../services/api.js').then(({ fetchSongs }) => {
          fetchSongs().then(songs => {
            if (songs) appState.set('songs', songs);
          });
        });
      }, 1000); // Small delay to allow file operations to complete
    });

    socket.on('song_redownloaded', (data) => {
      // The audio file was replaced in place; drop the device's stale copy (old and new name —
      // the new name can be the old one) and refresh songs so the new file URL is used.
      const old = appState.get('songs').find(s => s.id === data.song_id);
      import('../services/AudioCache.js').then(({ default: audioCache }) => {
        if (old?.url) audioCache.remove(old.url);
        if (data.url) audioCache.remove(data.url);
      });
      import('../services/api.js').then(({ fetchSongs }) => {
        fetchSongs().then(songs => {
          if (songs) appState.set('songs', songs);
        });
      });
    });

    socket.on('related_updated', (data) => {
      appState.set('relatedUpdate', data);
    });

    socket.on('discover_updated', (data) => {
      appState.set('discoverUpdate', data);
    });

    socket.on('download_failed', (data) => {
      const downloadStatuses = { ...appState.get('downloadStatuses') };
      downloadStatuses[data.url] = 'failed';
      appState.set('downloadStatuses', downloadStatuses);
    });

    socket.on('sync_item_updated', (data) => {
      const { playlist_id, download_link, status, song_id } = data;
      const syncStatuses = { ...appState.get('syncStatuses') };
      const items = syncStatuses[playlist_id] ? [...syncStatuses[playlist_id]] : [];

      const idx = items.findIndex(i => i.download_link === download_link);
      if (idx >= 0) {
        items[idx] = { ...items[idx], status, song_id };
      } else {
        items.push({ download_link, status, song_id });
      }
      syncStatuses[playlist_id] = items;
      appState.set('syncStatuses', syncStatuses);

      // Also refresh playlists when a sync download completes (new song added to playlist)
      if (status === 'downloaded') {
        setTimeout(() => {
          import('../services/api.js').then(({ fetchSongs, fetchPlaylists }) => {
            fetchSongs().then(songs => { if (songs) appState.set('songs', songs); });
            fetchPlaylists().then(playlists => { if (playlists) appState.set('playlists', playlists); });
          });
        }, 1000);
      }
    });
  }
}

// Try to initialize immediately, or wait for DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeWebSocket);
} else {
  initializeWebSocket();
}

// Also try periodically in case Socket.IO loads later
let initAttempts = 0;
const initInterval = setInterval(() => {
  if (typeof io !== 'undefined' && !socket) {
    initializeWebSocket();
    clearInterval(initInterval);
  }
  initAttempts++;
  if (initAttempts > 50) { // Stop after ~5 seconds
    clearInterval(initInterval);
  }
}, 100);

export { socket };
export default appState;
