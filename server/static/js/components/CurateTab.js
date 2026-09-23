/**
 * Curate tab - View and manage music library with tracks and playlists.
 * Usage: <curate-tab></curate-tab>
 * Emits: 'enqueue-song' custom event with { detail: { song } }
 *        'search-online' custom event with { detail: { query } } — hands the track
 *        search over to the Discover tab when the library has no match.
 */

import appState from '../state/appState.js';
import { fetchSongs, fetchPlaylists, fetchEvergreens } from '../services/api.js';
import queueManager from '../services/QueueManager.js';
import './PlaylistSettings.js';

// How many evergreens the Tracks subtab shows when nothing is searched.
const EVERGREEN_LIMIT = 100;

class CurateTab extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.songs = [];
    this.playlists = [];
    this.evergreens = []; // Top tracks from the user's listen history, shown when not searching
    this.evergreensPending = false; // A re-rank arrived while the user was reading the list
    this.activeSubtab = 'tracks'; // 'tracks', 'playlists', or 'working'
    this.searchQuery = '';      // lowercased, for matching
    this.searchQueryRaw = '';   // as typed, for display and the Discover hand-off
    this.workingPlaylist = null; // Current working playlist object
    this.isAddingToPlaylist = false; // Prevent multiple simultaneous add operations
  }

  connectedCallback() {
    this.render();
    this.loadSongs();
    this.loadPlaylists();
    this.loadEvergreens();
    this.attachEvents();
  }

  /**
   * Load songs from state
   */
  async loadSongs() {
    // First try to load from state
    this.unsubscribeSongs = appState.subscribe((key, value) => {
      if (key === 'songs') {
        this.songs = value;
        this.renderContent();
      }
    });
    // No queue subscription here: rebuilding the whole library list on every enqueue is
    // what caused the lag. Each <song-item> self-updates its queue indicator in place via
    // its own 'queue' subscription (syncQueueIndicator), so a full re-render isn't needed.
    this.songs = appState.get('songs');
    this.renderContent();
  }

  /**
   * Load playlists from state
   */
  async loadPlaylists() {
    this.unsubscribePlaylists = appState.subscribe((key, value) => {
      if (key === 'playlists') {
        this.playlists = value;
        // Keep working playlist in sync with latest data
        if (this.workingPlaylist) {
          const fresh = value.find(p => p.id === this.workingPlaylist.id);
          if (fresh) {
            this.workingPlaylist = fresh;
            appState.set('workingPlaylist', fresh);
          }
        }
        this.renderContent();
      }
    });
    this.playlists = appState.get('playlists');
    this.renderContent();
  }

  /**
   * Load the user's evergreens (top tracks from their last 1000 listens) and keep
   * them fresh as new listens are logged.
   */
  async loadEvergreens() {
    this.unsubscribeEvergreens = appState.subscribe((key, value) => {
      if (key !== 'evergreens') return;
      // The first ranking replaces the plain-library fallback, not a list the user is
      // reading, so there is nothing to yank and it paints immediately — that is the
      // one that matters, since it lands right after their first logged listen.
      const wasEmpty = this.evergreens.length === 0;
      this.evergreens = value || [];
      // Otherwise repaint only when the user isn't looking at this exact list:
      // re-ranking it mid-scroll would pull it out from under them.
      if (!this.isShowingEvergreens() || wasEmpty) this.renderContent();
      else this.evergreensPending = true;
    });

    // Flush a deferred re-rank when the user next arrives at this tab. Without this
    // there is no second chance: MusicApp mounts each tab once and only toggles
    // display, so nothing re-renders CurateTab on a tab switch, and an update parked
    // by the guard above stayed invisible for the rest of the session.
    this.unsubscribeTab = appState.subscribe((key, value) => {
      if (key !== 'currentTab' || value !== 'curate' || !this.evergreensPending) return;
      this.evergreensPending = false;
      this.renderContent();
    });
    this.evergreens = appState.get('evergreens') || [];
    this.renderContent();
    appState.set('evergreens', await fetchEvergreens(EVERGREEN_LIMIT));
  }

  /**
   * True when the evergreen list is the one currently on screen.
   * @returns {boolean}
   */
  isShowingEvergreens() {
    return appState.get('currentTab') === 'curate' &&
           this.activeSubtab === 'tracks' &&
           !this.searchQuery;
  }

  /**
   * Attach event listeners
   */
  attachEvents() {
    this.shadowRoot.addEventListener('click', (event) => {
      // Handle subtab switching
      const subtab = event.target.closest('.subtab');
      if (subtab) {
        this.activeSubtab = subtab.dataset.subtab;
        this.render();
        return;
      }

      // Hand the current query over to the Discover tab to search online
      if (event.target.closest('.search-online-btn')) {
        this.searchOnline();
        return;
      }

      // Handle song enqueue
      const songItem = event.target.closest('song-item');
      if (songItem) {
        if (songItem.isSwipe) {
          songItem.isSwipe = false;
          return;
        }
        if (songItem.isLongPress) {
          songItem.isLongPress = false;
          return;
        }
        const songData = JSON.parse(songItem.dataset.song || '{}');
        if (songData.id) {
          this.dispatchEvent(new CustomEvent('enqueue-song', {
            detail: { song: songData },
            bubbles: true
          }));
        }
      }

      // Handle playlist creation
      const createBtn = event.target.closest('.create-playlist-btn');
      if (createBtn) {
        this.createPlaylist();
      }

      // Handle playlist selection (set as working playlist)
      const playlistItem = event.target.closest('playlist-item');
      if (playlistItem && this.activeSubtab === 'playlists') {
        // A long-press (settings menu) or a swipe (add-as-feeder) already handled this
        // gesture; swallow the trailing tap so it doesn't also select the playlist.
        if (playlistItem.isLongPress) {
          playlistItem.isLongPress = false;
          return;
        }
        if (playlistItem.isSwipe) {
          playlistItem.isSwipe = false;
          return;
        }
        const playlistId = parseInt(playlistItem.getAttribute('playlist-id'), 10);
        const playlist = this.playlists.find(p => p.id === playlistId);
        if (playlist) {
          this.setWorkingPlaylist(playlist);
        }
      }
    });

    // Long-press a playlist on the Playlists subtab → open its settings menu.
    this.shadowRoot.addEventListener('playlist-settings-request', (event) => {
      const playlist = this.playlists.find(p => p.id === event.detail.playlistId);
      if (playlist) this.openPlaylistSettings(playlist);
    });

    // Membership add/remove (swipe on a track) is handled globally by MusicApp,
    // which updates appState; this tab re-renders from the 'playlists' subscription.

    // Handle search input. Delegated on the shadow root instead of bound to the
    // input element: renderTracksContent() rewrites .content on every keystroke,
    // so a listener attached directly to the input died with the first character.
    this.shadowRoot.addEventListener('input', (event) => {
      const input = event.target.closest && event.target.closest('.search-input');
      if (!input) return;
      this.searchQueryRaw = input.value.trim();
      this.searchQuery = this.searchQueryRaw.toLowerCase();
      this.renderContent();
    });
  }

  render() {
    const workingTitle = this.workingPlaylist ? this.workingPlaylist.name : '';

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; height: 100%; margin-top: 0; }
        /* Full-height non-scrolling column: the subtabs header is flex-none and the
           content-area below it owns the scroll. Keeping the header out of the scroller
           pins it for good — sticky always rides the overscroll/rubber-band, this can't. */
        .tab-root {
          display: flex;
          flex-direction: column;
          height: 100%;
        }
        .content-area {
          flex: 1 1 auto;
          min-height: 0;          /* let the flex child shrink so it actually scrolls */
          width: 100%;
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
          /* Keep the overscroll inside this scroller. Without this, an up-gesture that
             starts already at the top chains to the page and triggers pull-to-refresh,
             which freezes the scroll for a moment. With it contained, starting at the
             top behaves the same as arriving at the top from below: the list rubber-bands
             a bit to reveal the dead space above the search bar, then settles. */
          overscroll-behavior-y: contain;
        }
        .subtabs {
          flex: 0 0 auto;         /* fixed header; never scrolls */
          display: flex;
          margin: 0 0 10px 0;
          /* Top padding absorbs the notch/status-bar inset so the header background
             fills up to the screen top while the labels stay clear of the notch. */
          padding: calc(10px + env(safe-area-inset-top, 0px)) 10px 10px;
          position: relative;     /* anchor the ::after separator */
          background: #1a1a1a;
          z-index: 10;
        }
        /* Glowing gradient separator matching the bottom tab navigator's edge */
        .subtabs::after {
          content: '';
          position: absolute;
          left: 0;
          right: 0;
          bottom: 0;
          height: 2px;
          background: linear-gradient(90deg, #5ac8ff, #8a7bff, #5ac8ff);
          box-shadow: 0 0 6px rgba(138, 123, 255, 0.7),
                      0 0 3px rgba(90, 200, 255, 0.8);
          pointer-events: none;
        }
        .subtabs > .subtab,
        .subtabs > .working-subtab-wrapper {
          flex: 1 1 0;
          min-width: 0;
        }
        .subtab {
          font-size: 18px;
          font-weight: bold;
          cursor: pointer;
          color: #666;
          transition: color 0.2s;
          text-align: center;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .subtab.active {
          color: #fff;
        }
        .search-container {
          margin-bottom: 20px;
        }
        .search-input {
          -webkit-user-select: text;
          user-select: text;
          -webkit-touch-callout: default;
          width: 100%;
          box-sizing: border-box;
          padding: 10px;
          background: #2a2a2a;
          border: 1px solid #444;
          border-radius: 8px;
          color: #fff;
          font-size: 16px;
        }
        .search-input::placeholder {
          color: #aaa;
        }
        .stats { font-size: 14px; color: #aaa; margin-top: 8px; }
        /* Hand-off to the Discover tab, pinned under the last search result. The
           gradient edge echoes the tab navigator and the subtab separator. */
        .search-online-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          width: 100%;
          box-sizing: border-box;
          margin: 18px 0 6px;
          padding: 14px 16px;
          border: none;
          border-radius: 12px;
          background:
            linear-gradient(#1f1f24, #1f1f24) padding-box,
            linear-gradient(90deg, #5ac8ff, #8a7bff, #5ac8ff) border-box;
          border: 1px solid transparent;
          color: #dfe6ff;
          font-size: 15px;
          font-weight: 600;
          font-family: inherit;
          cursor: pointer;
          transition: box-shadow 0.2s ease, transform 0.1s ease, color 0.2s ease;
        }
        .search-online-btn svg {
          width: 18px;
          height: 18px;
          fill: currentColor;
          flex: none;
        }
        .search-online-btn span {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        @media (hover: hover) {
          .search-online-btn:hover {
            color: #fff;
            box-shadow: 0 0 10px rgba(138, 123, 255, 0.45);
          }
        }
        .search-online-btn:active { transform: scale(0.985); }
        .song-list { display: flex; flex-direction: column; gap: 0; margin-top: 20px; }
        .playlist-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
          margin-top: 20px;
        }
        /* Ghost "add playlist" card: dashed outline with a centered plus, sized
           to match a real playlist-item row so it reads as a placeholder slot. */
        .create-playlist-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 84px;
          box-sizing: border-box;
          padding: 14px 16px;
          border: 2px dashed rgba(255, 255, 255, 0.18);
          border-radius: 12px;
          background: transparent;
          color: rgba(255, 255, 255, 0.35);
          cursor: pointer;
          transition: all 0.2s ease;
        }
        @media (hover: hover) {
          .create-playlist-btn:hover {
            border-color: rgba(29, 185, 84, 0.5);
            color: #1db954;
            background: rgba(29, 185, 84, 0.06);
          }
        }
        .create-playlist-btn svg {
          width: 30px;
          height: 30px;
          fill: currentColor;
        }
        .working-title {
          font-size: 20px;
          font-weight: bold;
          color: #fff;
          text-align: center;
          margin-bottom: 20px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
        }
        .working-subtab-wrapper {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 4px;
        }
        /* Spacer as tall as the bottom nav bar (70px) so the last track can be
           scrolled clear of the bar instead of hiding behind it. */
        .nav-spacer {
          height: calc(70px + env(safe-area-inset-bottom, 0px));
          flex: none;
        }
      </style>

      <div class="tab-root">
        <div class="subtabs">
          <div class="subtab ${this.activeSubtab === 'tracks' ? 'active' : ''}" data-subtab="tracks">Tracks</div>
          <div class="subtab ${this.activeSubtab === 'playlists' ? 'active' : ''}" data-subtab="playlists">Playlists</div>
          <div class="working-subtab-wrapper">
            <div class="subtab ${this.activeSubtab === 'working' ? 'active' : ''}" data-subtab="working">${this.workingPlaylist ? this.workingPlaylist.name : ''}</div>
          </div>
        </div>
        <div class="content-area">
          <div class="content"></div>
          <div class="nav-spacer"></div>
        </div>
      </div>
    `;

    this.renderContent();
  }

  /**
   * Render content based on active subtab
   */
  renderContent() {
    const contentEl = this.shadowRoot.querySelector('.content');
    if (!contentEl) return;

    if (this.activeSubtab === 'tracks') {
      this.renderTracksContent(contentEl);
    } else if (this.activeSubtab === 'playlists') {
      this.renderPlaylistsContent(contentEl);
    } else if (this.activeSubtab === 'working') {
      this.renderWorkingContent(contentEl);
    }
  }

  /**
   * Render tracks subtab content: the user's evergreens by default, or library
   * search results once something is typed.
   */
  renderTracksContent(container) {
    // Build the chrome once per visit to the subtab. Re-creating it on every
    // keystroke would destroy the focused <input>, losing focus and caret mid-word.
    if (!container.querySelector('.search-input')) {
      container.innerHTML = `
        <div class="search-container">
          <input type="text" class="search-input" placeholder="Search tracks..."
                 value="${this.escapeHtml(this.searchQueryRaw)}">
        </div>
        <div class="stats"></div>
        <div class="song-list"></div>
      `;
    }

    if (this.searchQuery) this.renderTrackSearchResults(container);
    else this.renderEvergreenList(container);
  }

  /**
   * Default (unsearched) view: the top evergreens, ranked from the user's listens.
   * Until they have any, fall back to the plain library so the tab isn't empty.
   * @param {HTMLElement} container
   */
  renderEvergreenList(container) {
    const statsEl = container.querySelector('.stats');
    const listEl = container.querySelector('.song-list');

    if (this.evergreens.length === 0) {
      statsEl.textContent = this.songs.length
        ? `${this.songs.length} songs · play something to grow your evergreens`
        : '';
      listEl.innerHTML = this.songs.length
        ? this.songRowsHtml(this.songs)
        : '<p>No songs in library</p>';
      return;
    }

    statsEl.textContent = `Top ${this.evergreens.length} evergreens`;
    listEl.innerHTML = this.songRowsHtml(this.evergreens);
  }

  /**
   * Search view: every library track matching the query, followed by the
   * "search online" hand-off for tracks that aren't downloaded yet.
   * @param {HTMLElement} container
   */
  renderTrackSearchResults(container) {
    const filteredSongs = this.filterSongs();

    container.querySelector('.stats').textContent =
      `${filteredSongs.length} of ${this.songs.length} songs`;

    const listEl = container.querySelector('.song-list');
    listEl.innerHTML = (filteredSongs.length
      ? this.songRowsHtml(filteredSongs)
      : '<p>No tracks match your search</p>') + this.searchOnlineButtonHtml();
  }

  /**
   * Markup for a list of tracks.
   *
   * Each song-item reads title/artist/cover/source from its data-song JSON in render(),
   * so we don't set those as separate attributes — doing so used to re-render every row
   * four extra times (one per observed attribute), which stalled the Tracks subtab for
   * ~1s on a large library before it painted.
   * @param {Object[]} songs
   * @returns {string} HTML for the song list
   */
  songRowsHtml(songs) {
    return songs.map(song =>
      `<song-item
        data-song-id="${song.id}"
        data-song='${JSON.stringify(song).replace(/'/g, '&#39;')}'
      ></song-item>`
    ).join('');
  }

  /**
   * Markup for the button that carries the query over to the Discover tab.
   * @returns {string} HTML for the search-online button
   */
  searchOnlineButtonHtml() {
    return `
      <button class="search-online-btn" type="button">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14"/></svg>
        <span>Search online for "${this.escapeHtml(this.searchQueryRaw)}"</span>
      </button>
    `;
  }

  /**
   * Hand the current query to the Discover tab so the user can download a track
   * the library doesn't have yet.
   */
  searchOnline() {
    this.dispatchEvent(new CustomEvent('search-online', {
      detail: { query: this.searchQueryRaw },
      bubbles: true
    }));
  }

  /**
   * Escape text for safe interpolation into markup.
   * @param {string} text
   * @returns {string}
   */
  escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Filter the library by the current search query.
   * Every whitespace-separated term must appear in the track's "title artist"
   * text, so "daft one more" matches regardless of word order.
   * @returns {Object[]} Matching songs, or all songs when the query is empty.
   */
  filterSongs() {
    const terms = this.searchQuery.split(/\s+/).filter(Boolean);
    if (terms.length === 0) return this.songs;

    return this.songs.filter(song => {
      const haystack = `${song.title || ''} ${song.artist || ''}`.toLowerCase();
      return terms.every(term => haystack.includes(term));
    });
  }

  /**
   * Render playlists subtab content
   */
  renderPlaylistsContent(container) {
    container.innerHTML = `<div class="playlist-list"></div>`;

    const listEl = container.querySelector('.playlist-list');

    const playlistsHtml = this.playlists.map(playlist =>
      `<playlist-item
        playlist-id="${playlist.id}"
        name="${(playlist.name || '').replace(/"/g, '&quot;')}"
        songs-count="${playlist.songs ? playlist.songs.length : 0}"
        icon="${(playlist.icon || '').replace(/"/g, '&quot;')}"
        swipe-left="add as feeder"
      ></playlist-item>`
    ).join('');

    // A dashed, ghost "playlist" card pinned to the bottom acts as the create button.
    const createHtml = `
      <div class="create-playlist-btn" role="button" tabindex="0" aria-label="Create playlist" title="Create playlist">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 11V5h2v6h6v2h-6v6h-2v-6H5v-2z"/></svg>
      </div>`;

    listEl.innerHTML = playlistsHtml + createHtml;
  }

  /**
   * Render working playlist subtab content
   */
  renderWorkingContent(container) {
    const title = this.workingPlaylist ? this.workingPlaylist.name : '';
    const songs = this.workingPlaylist ? this.workingPlaylist.songs : [];

    container.innerHTML = `
      <div class="working-title"><span>${title}</span></div>
      <div class="song-list"></div>
    `;

    const listEl = container.querySelector('.song-list');
    if (songs.length === 0) {
      listEl.innerHTML = '<p>No songs in working playlist</p>';
      return;
    }

    // song-item renders from its data-song JSON, so skip the redundant per-attribute
    // pass that would re-render every row four extra times (see renderTracksContent).
    listEl.innerHTML = songs.map(song =>
      `<song-item
        data-song-id="${song.id}"
        data-song='${JSON.stringify(song).replace(/'/g, '&#39;')}'
      ></song-item>`
    ).join('');
  }

  /**
   * Set a playlist as the working playlist and switch to working tab
   */
  setWorkingPlaylist(playlist) {
    this.workingPlaylist = playlist;
    this.activeSubtab = 'working';
    this.publishWorkingPlaylist();
    this.render();
  }

  /**
   * Publish the working playlist to global state so song-item membership UI
   * (the rotated playlist triangle + add/remove swipe) works everywhere.
   */
  publishWorkingPlaylist() {
    appState.set('workingPlaylist', this.workingPlaylist ? { ...this.workingPlaylist } : null);
  }

  /**
   * Open the playlist settings overlay.
   * @param {Object} [playlist=this.workingPlaylist] - Playlist to edit. Defaults
   *   to the working playlist; a long-press on the Playlists subtab passes its own.
   */
  openPlaylistSettings(playlist = this.workingPlaylist) {
    if (!playlist) return;
    const targetId = playlist.id;

    const settings = document.createElement('playlist-settings');
    settings.setPlaylist(playlist);

    settings.addEventListener('playlist-updated', (e) => {
      const updated = e.detail.playlist;
      // Keep the working playlist in sync only if it's the one being edited.
      if (this.workingPlaylist && this.workingPlaylist.id === targetId) {
        const fresh = this.playlists.find(p => p.id === targetId);
        const base = fresh || this.workingPlaylist;
        this.workingPlaylist = { ...base, name: updated.name, description: updated.description, icon: updated.icon };
        this.publishWorkingPlaylist();
      }
      this.render();
    });

    settings.addEventListener('playlist-deleted', () => {
      if (this.workingPlaylist && this.workingPlaylist.id === targetId) {
        this.workingPlaylist = null;
        this.activeSubtab = 'playlists';
        this.publishWorkingPlaylist();
      }
      this.render();
    });

    settings.addEventListener('close', () => {
      // Refresh the working playlist from latest state in case sync added songs
      if (this.workingPlaylist) {
        const fresh = this.playlists.find(p => p.id === this.workingPlaylist.id);
        if (fresh) this.workingPlaylist = fresh;
        this.publishWorkingPlaylist();
        this.renderContent();
      }
    });

    // Mount in music-app shadow root so overlay respects app boundaries (375×667)
    const app = this.closest('music-app');
    (app?.shadowRoot || this.shadowRoot).appendChild(settings);
  }

  /**
   * Create a new playlist
   */
  async createPlaylist() {
    const name = prompt('Enter playlist name:');
    if (!name || !name.trim()) return;

    try {
      const { createPlaylist } = await import('../services/api.js');
      const newPlaylist = await createPlaylist(name.trim());
      this.playlists.push(newPlaylist);
      appState.set('playlists', [...this.playlists]);
      this.renderContent();
    } catch (error) {
      console.error('Error creating playlist:', error);
      alert('Failed to create playlist');
    }
  }

  /**
   * Check if a song is in the working playlist
   * @param {Object} song - Song object to check
   * @returns {boolean} True if song is in working playlist
   */
  isSongInWorkingPlaylist(song) {
    if (!this.workingPlaylist || !this.workingPlaylist.songs) return false;
    return this.workingPlaylist.songs.some(playlistSong =>
      playlistSong.id === song.id
    );
  }

  disconnectedCallback() {
    if (this.unsubscribeSongs) {
      this.unsubscribeSongs();
    }
    if (this.unsubscribePlaylists) {
      this.unsubscribePlaylists();
    }
    if (this.unsubscribeQueue) {
      this.unsubscribeQueue();
    }
    if (this.unsubscribeEvergreens) {
      this.unsubscribeEvergreens();
    }
    if (this.unsubscribeTab) {
      this.unsubscribeTab();
    }
  }
}

customElements.define('curate-tab', CurateTab);
