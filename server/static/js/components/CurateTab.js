/**
 * Curate tab - View and manage music library with tracks and playlists.
 * Usage: <curate-tab></curate-tab>
 * Emits: 'enqueue-song' custom event with { detail: { song } }
 *        'search-online' custom event with { detail: { query } } — hands the track
 *        search over to the Discover tab when the library has no match.
 */

import appState from '../state/appState.js';
import { fetchSongs, fetchPlaylists, fetchEvergreens, fetchRecentAdditions } from '../services/api.js';
import queueManager from '../services/QueueManager.js';
import './PlaylistSettings.js';

// How many tiles "the grid" above the evergreens shows (a 5x5 square).
const GRID_SIZE = 25;
// Long-press on a grid tile removes it from the queue; same timing/slop as <song-item>.
const GRID_LONG_PRESS_MS = 500;
const GRID_LONG_PRESS_SLOP = 15;
// Recent additions at the top of the Tracks subtab: rows shown folded / unfolded.
const RECENT_COLLAPSED = 5;
const RECENT_LIMIT = 20;

class CurateTab extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.songs = [];
    this.playlists = [];
    this.evergreens = []; // Top tracks from the user's listen history, shown when not searching
    this.evergreensPending = false; // A re-rank arrived while the user was reading the list
    this.recentAdditions = []; // Newest liked / search-downloaded tracks, newest first
    this.recentExpanded = false; // Recent additions unfolded past RECENT_COLLAPSED
    this.gridSongs = []; // Random sample of library tracks shown as cover tiles; kept until redrawn
    this.gridPress = null; // In-flight long-press on a grid tile: { tile, x, y, timer, fired }
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
    this.loadRecentAdditions();
    this.attachEvents();
    this.attachGridPress();
    // Grid tiles carry the same queue/now-playing badge as track rows; patch them in
    // place so a queue change doesn't rebuild (and re-load) all 25 covers.
    this.unsubscribeQueue = appState.subscribe((key) => {
      if (key === 'queue' || key === 'currentSong') this.syncGridIndicators();
    });
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
        // The library is refetched whenever a download lands or a like is added,
        // which is exactly when the recent additions can change.
        this.loadRecentAdditions();
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
    appState.set('evergreens', await fetchEvergreens());
  }

  /**
   * Fetch the user's recent additions (Discover likes and search/link downloads)
   * and repaint that section if it is on screen.
   */
  async loadRecentAdditions() {
    this.recentAdditions = await fetchRecentAdditions(RECENT_LIMIT);
    const recentEl = this.shadowRoot.querySelector('.recent-section');
    if (recentEl && !this.searchQuery) this.renderRecentAdditions(recentEl);
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

      // Fold / unfold the recent additions
      if (event.target.closest('.recent-toggle')) {
        this.recentExpanded = !this.recentExpanded;
        this.renderRecentAdditions(this.shadowRoot.querySelector('.recent-section'));
        return;
      }

      // The grid: redraw the sample, or enqueue a tapped tile like any other track
      if (event.target.closest('.grid-redraw')) {
        this.drawGrid();
        this.renderContent();
        return;
      }
      const tile = event.target.closest('.grid-tile');
      if (tile) {
        // A long-press already handled this gesture; swallow its trailing click.
        if (tile.dataset.pressed) {
          delete tile.dataset.pressed;
          return;
        }
        const song = this.gridSongs.find(s => String(s.id) === tile.dataset.songId);
        if (!song) return;
        // Like tapping a track row's spinning disc: the playing tile toggles play/pause.
        const current = appState.get('currentSong');
        if (current && String(current.id) === String(song.id)) {
          this.dispatchEvent(new CustomEvent('toggle-play-pause', { bubbles: true, composed: true }));
          return;
        }
        this.dispatchEvent(new CustomEvent('enqueue-song', { detail: { song }, bubbles: true }));
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
        .grid-section, .recent-section { margin-bottom: 20px; }
        .grid-section[hidden], .recent-section[hidden] { display: none; }
        .grid-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 8px;
          font-size: 14px;
          color: #aaa;
        }
        .grid-redraw, .recent-toggle {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 4px 10px;
          background: #2a2a2a;
          border: 1px solid #444;
          border-radius: 8px;
          color: #ddd;
          font-size: 13px;
          font-family: inherit;
          cursor: pointer;
        }
        .grid-redraw svg { width: 14px; height: 14px; fill: currentColor; }
        .grid-redraw:active, .recent-toggle:active { transform: scale(0.95); }
        .grid {
          display: grid;
          grid-template-columns: repeat(5, 1fr);
          gap: 4px;
        }
        .grid-tile {
          position: relative;
          aspect-ratio: 1;
          padding: 0;
          border: none;
          border-radius: 4px;
          overflow: hidden;
          background: #2a2a2a;
          cursor: pointer;
          -webkit-touch-callout: none;
          -webkit-user-select: none;
          user-select: none;
        }
        .grid-tile img { width: 100%; height: 100%; object-fit: cover; display: block; pointer-events: none; }
        /* Queue badge: the track row's wedge, as a centred circle in the same colours. */
        .grid-badge {
          position: absolute;
          top: 50%;
          left: 50%;
          width: 28px;
          height: 28px;
          transform: translate(-50%, -50%);
          border-radius: 50%;
          display: none;
          align-items: center;
          justify-content: center;
          font-size: 13px;
          font-weight: 700;
          color: #fff;
          pointer-events: none;
        }
        .grid-badge.playing { display: flex; background: #1db954; }
        .grid-badge.queued { display: flex; background: #282828; }
        .grid-tile:active { transform: scale(0.95); }
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
        .recent-list { display: flex; flex-direction: column; gap: 0; }
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
        <div class="recent-section"></div>
        <div class="grid-section"></div>
        <div class="stats"></div>
        <div class="song-list"></div>
      `;
    }

    const recentEl = container.querySelector('.recent-section');
    const gridEl = container.querySelector('.grid-section');
    recentEl.hidden = !!this.searchQuery;
    gridEl.hidden = !!this.searchQuery;
    if (this.searchQuery) {
      this.renderTrackSearchResults(container);
    } else {
      this.renderRecentAdditions(recentEl);
      this.renderGrid(gridEl);
      this.renderEvergreenList(container);
    }
  }

  /**
   * Recent additions: the newest tracks the user liked in Discover or downloaded
   * from search / a link, newest first. Folded to RECENT_COLLAPSED rows by default.
   * @param {HTMLElement} recentEl - The .recent-section container
   */
  renderRecentAdditions(recentEl) {
    if (!recentEl) return;
    if (this.recentAdditions.length === 0) {
      recentEl.innerHTML = '';
      delete recentEl.dataset.key;
      return;
    }

    const shown = this.recentExpanded
      ? this.recentAdditions
      : this.recentAdditions.slice(0, RECENT_COLLAPSED);
    // Re-renders are frequent (every library update); only rebuild when the rows
    // actually changed so the covers don't flash.
    const key = `${this.recentExpanded}:${this.recentAdditions.map(song => song.id).join(',')}`;
    if (recentEl.dataset.key === key) return;
    recentEl.dataset.key = key;

    const canToggle = this.recentAdditions.length > RECENT_COLLAPSED;
    recentEl.innerHTML = `
      <div class="grid-header">
        <span>Recent additions</span>
        ${canToggle ? `<button class="recent-toggle" type="button">
          ${this.recentExpanded ? 'Show less' : 'Show more'}
        </button>` : ''}
      </div>
      <div class="recent-list">${this.songRowsHtml(shown)}</div>
    `;
  }

  /**
   * Pick a fresh random sample of GRID_SIZE playable library tracks. Tracks with
   * cover art come first, since the grid shows nothing but covers; coverless ones
   * only fill in when the library is short on art.
   */
  drawGrid() {
    const playable = (this.songs || []).filter(song => song.url);
    const shuffled = this.shuffle(playable);
    const withCover = shuffled.filter(song => song.cover);
    const withoutCover = shuffled.filter(song => !song.cover);
    this.gridSongs = withCover.concat(withoutCover).slice(0, GRID_SIZE);
  }

  /**
   * Fisher-Yates shuffle into a new array.
   * @param {Array} items
   * @returns {Array} The items in random order
   */
  shuffle(items) {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /**
   * The grid: a 5x5 tiling of cover art; taps follow the usual enqueue → front → play cycle. The sample is drawn once the
   * library arrives and stays put across re-renders until the redraw button is hit.
   * @param {HTMLElement} gridEl - The .grid-section container
   */
  renderGrid(gridEl) {
    if (this.gridSongs.length === 0) this.drawGrid();
    if (this.gridSongs.length === 0) {
      gridEl.innerHTML = '';
      return;
    }

    // Library/playlist updates re-render the tab often; only rebuild the tiles when the
    // sample actually changed, so the covers don't flash.
    const key = this.gridSongs.map(song => song.id).join(',');
    if (gridEl.dataset.key === key) return;
    gridEl.dataset.key = key;

    const tiles = this.gridSongs.map(song => `
      <button class="grid-tile" type="button" data-song-id="${song.id}"
              aria-label="${this.escapeHtml(`${song.title || ''} – ${song.artist || ''}`)}">
        ${song.cover ? `<img src="${this.escapeHtml(song.cover)}" alt="" loading="lazy" draggable="false">` : ''}
        <span class="grid-badge"></span>
      </button>`).join('');

    gridEl.innerHTML = `
      <div class="grid-header">
        <span>The grid</span>
        <button class="grid-redraw" type="button" aria-label="Redraw the grid">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
          Redraw
        </button>
      </div>
      <div class="grid">${tiles}</div>
    `;
    this.syncGridIndicators();
  }

  /**
   * Update every grid tile's centre badge from the queue and current song — the same
   * states as a track row's wedge: green play icon for the current track, grey queue
   * position for a queued one, hidden otherwise.
   */
  syncGridIndicators() {
    const tiles = this.shadowRoot.querySelectorAll('.grid-tile');
    if (!tiles.length) return;
    const queue = appState.get('queue') || [];
    const current = appState.get('currentSong');

    tiles.forEach(tile => {
      const id = tile.dataset.songId;
      const badge = tile.querySelector('.grid-badge');
      const qIndex = queue.findIndex(s => String(s.id) === id);
      if (current && String(current.id) === id) {
        badge.className = 'grid-badge playing';
        badge.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="#fff"><path d="M8 5v14l11-7z"/></svg>';
      } else if (qIndex >= 0) {
        badge.className = 'grid-badge queued';
        badge.textContent = String(qIndex + 1);
      } else {
        badge.className = 'grid-badge';
        badge.textContent = '';
      }
    });
  }

  /**
   * Long-press a grid tile → remove its track from the queue (the grid has no wedge to
   * tap, so the hold does that job). Pointer events cover touch and mouse alike; a move
   * past the slop or a pointercancel (the browser taking over to scroll) aborts it.
   */
  attachGridPress() {
    const cancel = () => {
      if (this.gridPress) clearTimeout(this.gridPress.timer);
      this.gridPress = null;
    };

    this.shadowRoot.addEventListener('pointerdown', (event) => {
      const tile = event.target.closest('.grid-tile');
      if (!tile) return;
      cancel();
      delete tile.dataset.pressed;
      this.gridPress = {
        tile,
        x: event.clientX,
        y: event.clientY,
        timer: setTimeout(() => this.onGridLongPress(tile), GRID_LONG_PRESS_MS)
      };
    });
    this.shadowRoot.addEventListener('pointermove', (event) => {
      const press = this.gridPress;
      if (!press) return;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > GRID_LONG_PRESS_SLOP) cancel();
    });
    this.shadowRoot.addEventListener('pointerup', cancel);
    this.shadowRoot.addEventListener('pointercancel', cancel);
    // Keep the OS image/long-press menu from popping up over the grid.
    this.shadowRoot.addEventListener('contextmenu', (event) => {
      if (event.target.closest('.grid-tile')) event.preventDefault();
    });
  }

  /**
   * A tile was held long enough: drop its track from the queue if it's queued.
   * @param {HTMLElement} tile
   */
  onGridLongPress(tile) {
    this.gridPress = null;
    tile.dataset.pressed = '1'; // swallow the click that follows the release
    const songId = tile.dataset.songId;
    const index = (appState.get('queue') || []).findIndex(s => String(s.id) === songId);
    if (index < 0) return;
    this.dispatchEvent(new CustomEvent('remove-from-queue', {
      detail: { songId, index }, bubbles: true, composed: true
    }));
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
   * Return to the default view — the Tracks subtab with no search, so the
   * evergreens show. Used when the tab button is re-tapped.
   */
  showDefaultSubtab() {
    if (this.activeSubtab === 'tracks' && !this.searchQueryRaw) return;
    this.searchQueryRaw = '';
    this.searchQuery = '';
    const input = this.shadowRoot.querySelector('.search-input');
    if (input) {
      input.value = '';
      input.blur();
    }
    this.activeSubtab = 'tracks';
    this.render();
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
