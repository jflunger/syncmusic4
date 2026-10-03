/**
 * Discover tab - Browse, search and play songs from Spotify and SoundCloud.
 * Usage: <discover-tab></discover-tab>
 * Emits: 'enqueue-song' custom event with { detail: { song } }
 * API: showRelated(song) — open the Recommended subtab listing tracks related to a library song
 */

import appState from '../state/appState.js';
import { searchSongs, downloadTrack, logout, fetchSongRelated } from '../services/api.js';

const compactNumber = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/**
 * Milliseconds → "m:ss".
 * @param {number} ms
 * @returns {string}
 */
const formatDuration = (ms) => {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** Escape text for use inside HTML content or a double-quoted attribute. */
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

class DiscoverTab extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.songs = [];
    this.searchResults = [];
    this.searchTimeout = null;
    this.activeSubtab = 'search'; // 'recommended', 'search', or 'link'
    this.searchQuery = '';
    // Related-tracks lookup shown on the Recommended subtab:
    // { song, status: 'loading'|'ready'|'queued'|'fetching'|'error', results, error, queuePosition }
    this.related = null;
    // Selectable search sources, side by side and scrollable for future expansion
    this.sources = [
      { id: 'youtube', label: 'YouTube', color: '#ff0000', border: '#b30000' },
      { id: 'soundcloud', label: 'SoundCloud', color: '#ff5500', border: '#b33b00' },
    ];
    this.selectedSources = new Set(this.sources.map(s => s.id));
  }

  connectedCallback() {
    this.render();
    this.loadSongs();
    this.attachEvents();
  }

  /**
   * Load songs from state
   */
  loadSongs() {
    this.unsubscribeSongs = appState.subscribe((key, value) => {
      if (key === 'songs') {
        this.songs = value;
      }
      // A background related lookup finished for the song on screen: reload its stored results.
      if (key === 'relatedUpdate' && value && this.related && this.related.song.id === value.song_id) {
        this.loadRelated(this.related.song);
      }
    });
    this.songs = appState.get('songs');
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

      // Handle source pill toggling
      const pill = event.target.closest('.source-pill');
      if (pill) {
        this.toggleSource(pill.dataset.source);
        return;
      }

      // Handle link download
      const downloadBtn = event.target.closest('.download-btn');
      if (downloadBtn) {
        const urlInput = this.shadowRoot.querySelector('.url-input');
        const url = urlInput.value.trim();
        if (url) {
          this.downloadYouTube(url);
        }
        return;
      }

      // Handle logout
      if (event.target.closest('.logout-btn')) {
        this.handleLogout();
      }
    });

    // Handle search result download events
    this.shadowRoot.addEventListener('download-track', (event) => {
      this.downloadSearchResult(event.detail.track);
    });
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; height: 100%; }
        .content-area {
          width: 100%;
          box-sizing: border-box;
        }
        .subtabs {
          display: flex;
          margin: 0 0 10px 0;
          /* Top padding absorbs the notch/status-bar inset so the header background
             fills up to the screen top while the labels stay clear of the notch. */
          padding: calc(10px + env(safe-area-inset-top, 0px)) 10px 10px;
          position: sticky;
          top: 0;
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
        .subtabs > .subtab {
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
        .content {
          padding: 0 20px;
          box-sizing: border-box;
        }
        .search-section {
          margin-bottom: 20px;
        }
        /* Horizontally scrollable row of source pills, side by side. */
        .source-pills {
          display: flex;
          gap: 8px;
          margin-bottom: 12px;
          overflow-x: auto;
          -webkit-overflow-scrolling: touch;
          scrollbar-width: none;
          padding-bottom: 2px;
        }
        .source-pills::-webkit-scrollbar { display: none; }
        .source-pill {
          flex: 0 0 auto;
          padding: 3px 10px;
          border-radius: 999px;
          border: 1px solid #444;
          background: #2a2a2a;
          color: #aaa;
          font-size: 12px;
          font-weight: bold;
          cursor: pointer;
          white-space: nowrap;
          transition: background 0.2s, color 0.2s, border-color 0.2s;
          user-select: none;
        }
        /* When active, a pill carries its source's brand color with a slightly
           darker outline of the same hue (set inline via data colors). */
        .source-pill.active {
          background: var(--pill-color);
          border-color: var(--pill-border);
          color: #fff;
        }
        .search-input {
          -webkit-user-select: text;
          user-select: text;
          -webkit-touch-callout: default;
          width: 100%;
          padding: 12px;
          border: 1px solid #444;
          background: #2a2a2a;
          color: #fff;
          border-radius: 8px;
          font-size: 16px;
          margin-bottom: 8px;
          box-sizing: border-box;
        }
        .search-input:focus {
          outline: none;
          border-color: #1db954;
        }
        .search-results {
          display: flex;
          flex-direction: column;
          gap: 0;
          margin-top: 16px;
        }
        .recommended-section h3 {
          color: #fff;
          margin: 0 0 8px 0;
          font-size: 18px;
        }
        .related-header {
          color: #888;
          font-size: 13px;
          margin: 0 0 4px 0;
        }
        .related-header strong { color: #ddd; font-weight: 600; }
        .related-list {
          display: flex;
          flex-direction: column;
          margin-top: 12px;
        }
        .related-metrics {
          display: flex;
          flex-wrap: wrap;
          gap: 4px 10px;
          padding: 0 12px 10px 12px;
          color: #888;
          font-size: 12px;
          font-variant-numeric: tabular-nums;
        }
        .related-metrics .in-library { color: #1db954; font-weight: 600; }
        .coming-soon {
          color: #888;
          font-size: 14px;
          margin: 0;
        }
        .account-row {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 10px;
          margin-top: 28px;
        }
        .account-name {
          color: #888;
          font-size: 13px;
        }
        .logout-btn {
          padding: 10px 18px;
          border-radius: 10px;
          border: 1px solid #f44336;
          background: transparent;
          color: #f44336;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
        }
        .logout-btn:active { background: rgba(244, 67, 54, 0.15); }
        .download-section h3 {
          color: #fff;
          margin: 0 0 10px 0;
          font-size: 18px;
        }
        .url-input {
          -webkit-user-select: text;
          user-select: text;
          -webkit-touch-callout: default;
          width: 100%;
          padding: 12px;
          margin-bottom: 8px;
          border: 1px solid #444;
          background: #2a2a2a;
          color: #fff;
          border-radius: 8px;
          font-size: 16px;
          box-sizing: border-box;
        }
        .url-input:focus {
          outline: none;
          border-color: #1db954;
        }
        .download-btn {
          background: #1db954;
          color: #fff;
          border: none;
          padding: 12px 20px;
          border-radius: 8px;
          font-size: 16px;
          cursor: pointer;
        }
        @media (hover: hover) { .download-btn:hover { background: #1ed760; } }
        .message {
          padding: 10px;
          border-radius: 4px;
          margin-bottom: 10px;
          text-align: center;
          font-weight: bold;
        }
        .message.info { background: #444; color: #fff; }
        .message.success { background: #1db954; color: #fff; }
        .message.warning { background: #ff9800; color: #000; }
        .message.error { background: #f44336; color: #fff; }
        /* Spacer as tall as the bottom nav bar (70px) so the last item can be
           scrolled clear of the bar instead of hiding behind it. */
        .nav-spacer {
          height: calc(70px + env(safe-area-inset-bottom, 0px));
          flex: none;
        }
      </style>

      <div class="content-area">
        <div class="subtabs">
          <div class="subtab ${this.activeSubtab === 'recommended' ? 'active' : ''}" data-subtab="recommended">Recommended</div>
          <div class="subtab ${this.activeSubtab === 'search' ? 'active' : ''}" data-subtab="search">Search</div>
          <div class="subtab ${this.activeSubtab === 'link' ? 'active' : ''}" data-subtab="link">Link</div>
        </div>
        <div class="content"></div>
        <div class="nav-spacer"></div>
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

    if (this.activeSubtab === 'recommended') {
      this.renderRecommendedContent(contentEl);
    } else if (this.activeSubtab === 'search') {
      this.renderSearchContent(contentEl);
    } else if (this.activeSubtab === 'link') {
      this.renderLinkContent(contentEl);
    }
  }

  /**
   * Render recommended subtab content
   */
  renderRecommendedContent(container) {
    const user = appState.get('currentUser');
    container.innerHTML = `
      <div class="recommended-section">
        <h3>Recommended</h3>
        ${this.renderRelatedBody()}
        <div class="account-row">
          ${user ? `<span class="account-name">Signed in as ${user}</span>` : ''}
          <button class="logout-btn">Log out</button>
        </div>
      </div>
    `;
  }

  /**
   * Markup for the related-tracks block (or the placeholder when none was asked for).
   * @returns {string}
   */
  renderRelatedBody() {
    const r = this.related;
    if (!r) return '<p class="coming-soon">Open a track\'s edit menu and tap "Show related".</p>';

    const header = `<p class="related-header">Related to <strong>${esc(r.song.title)}</strong> — ${esc(r.song.artist)}</p>`;
    if (r.status === 'loading') return `${header}<p class="coming-soon">Loading related tracks…</p>`;
    const note = this.relatedStatusNote(r);
    if (!r.results.length) {
      return `${header}<p class="coming-soon">${note || 'No related tracks found.'}</p>`;
    }

    const items = r.results.map((t) => `
      <search-result-item
        title="${esc(t.title || 'Unknown')}"
        artist="${esc(t.artist || 'Unknown')}"
        source="${esc(t.source)}"
        cover="${esc(t.cover)}"
        url="${esc(t.url)}"
      ></search-result-item>
      <div class="related-metrics">${this.formatMetrics(t)}</div>`).join('');
    return `${header}${note ? `<p class="coming-soon">${note}</p>` : ''}<div class="related-list">${items}</div>`;
  }

  /**
   * Status line for a related lookup that is queued, running or failed (empty when ready).
   * Shown alone when nothing is stored yet, or above older stored results being refreshed.
   * @param {Object} r - this.related
   * @returns {string} HTML
   */
  relatedStatusNote(r) {
    const refreshing = r.results.length > 0;
    if (r.status === 'queued') {
      const pos = r.queuePosition > 1 ? ` (position ${r.queuePosition})` : '';
      return `${refreshing ? 'Refresh queued' : 'Queued for lookup'}${pos} — updates automatically.`;
    }
    if (r.status === 'fetching') return refreshing ? 'Refreshing related tracks…' : 'Fetching related tracks…';
    if (r.status === 'error') return `Couldn't load related tracks: ${esc(r.error || 'Unknown error')}`;
    return '';
  }

  /**
   * One-line metric chips for a related track.
   * @param {Object} track - Related result with `metrics` and `library_song_id`
   * @returns {string} HTML
   */
  formatMetrics(track) {
    const m = track.metrics || {};
    const chips = [];
    if (track.library_song_id) chips.push('<span class="in-library">✓ In library</span>');
    if (track.duration) chips.push(`⏱ ${formatDuration(track.duration)}`);
    if (m.plays != null) chips.push(`▶ ${compactNumber.format(m.plays)}`);
    if (m.likes != null) {
      const ratio = m.like_ratio != null ? ` (${(m.like_ratio * 100).toFixed(1)}%)` : '';
      chips.push(`♥ ${compactNumber.format(m.likes)}${ratio}`);
    }
    if (m.plays_per_day != null) chips.push(`${compactNumber.format(m.plays_per_day)}/day`);
    if (m.uploaded_at) chips.push(String(m.uploaded_at).slice(0, 4));
    if (m.genre && m.genre !== 'Music') chips.push(esc(m.genre));
    return chips.map((c) => `<span>${c}</span>`).join('');
  }

  /**
   * Show tracks related to a library song on the Recommended subtab.
   * @param {Object} song - Library song with numeric id
   */
  showRelated(song) {
    this.related = { song, status: 'loading', results: [], error: null, queuePosition: null };
    this.activeSubtab = 'recommended';
    this.render();
    this.loadRelated(song);
  }

  /**
   * Load a song's stored related tracks (the server queues a lookup if needed).
   * Keeps the previous results visible while reloading; stale responses
   * (a newer request started meanwhile) are dropped.
   * @param {Object} song - Library song with numeric id
   */
  async loadRelated(song) {
    const previous = this.related && this.related.song.id === song.id ? this.related.results : [];
    const request = { song, status: 'loading', results: previous, error: null, queuePosition: null };
    if (previous.length) request.status = this.related.status;
    this.related = request;

    try {
      const data = await fetchSongRelated(song.id);
      request.results = data.results || [];
      request.status = data.status || 'ready';
      request.error = data.error;
      request.queuePosition = data.queue_position;
    } catch (err) {
      request.status = 'error';
      request.error = err.message || 'Unknown error';
    }
    if (this.related === request && this.activeSubtab === 'recommended') this.render();
  }

  /**
   * Log out and return to the login screen.
   */
  async handleLogout() {
    try {
      await logout();
    } finally {
      location.reload();
    }
  }

  /**
   * Render search subtab content (search input + results)
   */
  renderSearchContent(container) {
    const pills = this.sources.map(s =>
      `<div class="source-pill ${this.selectedSources.has(s.id) ? 'active' : ''}"
        data-source="${s.id}"
        style="--pill-color: ${s.color}; --pill-border: ${s.border};">${s.label}</div>`
    ).join('');

    container.innerHTML = `
      <div class="search-section">
        <div class="source-pills">${pills}</div>
        <input type="text" class="search-input" placeholder="Search songs..." value="${this.searchQuery.replace(/"/g, '&quot;')}">
        <div class="search-results"></div>
      </div>
    `;

    const searchInput = container.querySelector('.search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.searchQuery = e.target.value;
        this.handleSearch(this.searchQuery.trim());
      });
    }

    this.renderSearchResults();
  }

  /**
   * Return to the default (Search) subtab — used when the tab button is re-tapped.
   */
  showDefaultSubtab() {
    if (this.activeSubtab === 'search') return;
    this.activeSubtab = 'search';
    this.render();
  }

  /**
   * Run a search from outside the tab (the Curate tab's "search online" hand-off).
   * Switches to the Search subtab, fills the box and fires the search.
   * @param {string} query - Search query
   */
  setSearchQuery(query) {
    this.searchQuery = query || '';
    this.activeSubtab = 'search';
    this.render();
    this.shadowRoot.querySelector('.search-input')?.focus();
    this.handleSearch(this.searchQuery.trim());
  }

  /**
   * Render link subtab content (YouTube URL input + button)
   */
  renderLinkContent(container) {
    container.innerHTML = `
      <div class="download-section">
        <h3>Download from link</h3>
        <input type="text" class="url-input" placeholder="Paste a YouTube or SoundCloud URL here...">
        <button class="download-btn">Download</button>
      </div>
    `;
  }

  /**
   * Download from YouTube URL
   * @param {string} url - YouTube URL
   */
  async downloadYouTube(url) {
    try {
      this.showMessage('Downloading...', 'info');
      // Use the general downloadTrack function for YouTube
      const result = await downloadTrack(url, 'youtube', {});
      if (result.success) {
        this.showMessage('Download queued successfully!', 'success');
        // Reload songs to include new downloads
        this.loadSongs();
      } else {
        this.showMessage('Download failed', 'error');
      }
    } catch (error) {
      this.showMessage(`Download failed: ${error.message}`, 'error');
    }
  }

  /**
   * Show status message
   * @param {string} message
   * @param {string} type - 'info', 'success', 'warning', 'error'
   */
  showMessage(message, type) {
    let messageEl = this.shadowRoot.querySelector('.message');
    if (!messageEl) {
      messageEl = document.createElement('div');
      messageEl.className = 'message';
      const contentEl = this.shadowRoot.querySelector('.content');
      contentEl.insertBefore(messageEl, contentEl.firstChild);
    }
    messageEl.textContent = message;
    messageEl.className = `message ${type}`;

    // Auto-hide success messages
    if (type === 'success') {
      setTimeout(() => {
        if (messageEl.parentNode) {
          messageEl.parentNode.removeChild(messageEl);
        }
      }, 5000);
    }
  }

  /**
   * Handle search input with debouncing
   * @param {string} query - Search query
   */
  handleSearch(query) {
    if (this.searchTimeout) {
      clearTimeout(this.searchTimeout);
    }

    if (!query) {
      this.searchResults = [];
      this.renderSearchResults();
      return;
    }

    this.searchTimeout = setTimeout(async () => {
      try {
        this.showMessage('Searching...', 'info');
        const results = await searchSongs(query);
        this.searchResults = results || [];
        this.renderSearchResults();
        this.clearMessage();
      } catch (error) {
        this.showMessage('Search failed', 'error');
        this.searchResults = [];
        this.renderSearchResults();
      }
    }, 500);
  }

  /**
   * Toggle a search source on/off and re-render the (already fetched) results.
   * @param {string} sourceId - Source identifier (e.g. 'youtube')
   */
  toggleSource(sourceId) {
    if (this.selectedSources.has(sourceId)) {
      this.selectedSources.delete(sourceId);
    } else {
      this.selectedSources.add(sourceId);
    }
    // Update only the toggled pill's active state to avoid losing input focus.
    const pillEl = this.shadowRoot.querySelector(`.source-pill[data-source="${sourceId}"]`);
    if (pillEl) pillEl.classList.toggle('active', this.selectedSources.has(sourceId));
    this.renderSearchResults();
  }

  /**
   * Interleave results: 1 SoundCloud, 1 YouTube, 1 SoundCloud, 1 YouTube...
   * @param {Array} results - Search results
   * @returns {Array} Interleaved results
   */
  interleaveResults(results) {
    const soundcloud = results.filter(r => (r.source || '').toLowerCase() === 'soundcloud');
    const youtube = results.filter(r => (r.source || '').toLowerCase() === 'youtube');
    const out = [];
    const max = Math.max(soundcloud.length, youtube.length);
    for (let i = 0; i < max; i++) {
      if (soundcloud[i]) out.push(soundcloud[i]);
      if (youtube[i]) out.push(youtube[i]);
    }
    return out;
  }

  /**
   * Render search results
   */
  renderSearchResults() {
    const resultsEl = this.shadowRoot.querySelector('.search-results');
    if (!resultsEl) return;

    const filtered = this.searchResults.filter(r =>
      this.selectedSources.has((r.source || '').toLowerCase())
    );

    if (filtered.length === 0) {
      resultsEl.innerHTML = '';
      return;
    }

    const interleaved = this.interleaveResults(filtered);
    resultsEl.innerHTML = interleaved.map(result =>
      `<search-result-item
        title="${result.title || 'Unknown'}"
        artist="${result.artist || 'Unknown'}"
        source="${result.source || 'unknown'}"
        cover="${result.cover || ''}"
        url="${result.url || ''}"
      ></search-result-item>`
    ).join('');
  }

  /**
   * Download a track from search results
   * @param {Object} track - Track object with title, artist, source, url, cover
   */
  async downloadSearchResult(track) {
    try {
      this.showMessage(`Downloading "${track.title}"...`, 'info');
      const result = await downloadTrack(track.url, track.source, track);
      if (result.success) {
        this.showMessage(`Downloaded "${track.title}"!`, 'success');
        // Reload songs to include new downloads
        this.loadSongs();
      } else {
        this.showMessage('Download completed but no files found', 'warning');
      }
    } catch (error) {
      this.showMessage(`Download failed: ${error.message}`, 'error');
    }
  }

  /**
   * Clear status message
   */
  clearMessage() {
    const messageEl = this.shadowRoot.querySelector('.message');
    if (messageEl) {
      messageEl.parentNode.removeChild(messageEl);
    }
  }

  disconnectedCallback() {
    if (this.unsubscribeSongs) {
      this.unsubscribeSongs();
    }
    if (this.searchTimeout) {
      clearTimeout(this.searchTimeout);
    }
  }
}

customElements.define('discover-tab', DiscoverTab);
