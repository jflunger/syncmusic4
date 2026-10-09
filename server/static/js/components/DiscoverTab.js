/**
 * Discover tab - Browse, search and play songs from Spotify and SoundCloud.
 * The Recommended subtab shows one discover candidate at a time (a pre-downloaded track related
 * to a random feeder "seed" song) with a preview player and Like / Dislike / Redraw buttons.
 * Like asks which playlist to add the track to (the Play-tab feeders, "Other" for the rest, or
 * none), then keeps the liked track on screen and playing: Like turns into Next, which is what
 * moves on to the following candidate.
 * Usage: <discover-tab></discover-tab>
 * Emits: 'enqueue-song' custom event with { detail: { song } } — also for a tapped search/related
 *        result, which is a pending (not yet downloaded) song until its download lands
 * API: showRelated(song) — open the Recommended subtab listing tracks related to a library song
 */

import appState from '../state/appState.js';
import { icon } from '../icons.js';
import playback from '../services/PlaybackController.js';
import { pendingSong } from '../services/QueueManager.js';
import {
  searchSongs, downloadTrack, logout, fetchSongRelated,
  fetchDiscover, rateDiscover, redrawDiscover, fetchSongs, fetchPlaylists, addSongToPlaylist
} from '../services/api.js';

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

/**
 * <search-result-item> markup for an online track (search hit or related track).
 * @param {Object} t - Result with title/artist/source/cover/url and optional duration, metrics, library_song_id
 * @returns {string} HTML
 */
const resultItemHtml = (t) => `
  <search-result-item
    title="${esc(t.title || 'Unknown')}"
    artist="${esc(t.artist || 'Unknown')}"
    source="${esc(t.source || 'unknown')}"
    cover="${esc(t.cover || '')}"
    url="${esc(t.url || '')}"
    data-track="${esc(JSON.stringify({ duration: t.duration, metrics: t.metrics, library_song_id: t.library_song_id }))}"
  ></search-result-item>`;

const SEARCH_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

/** Placeholder rows shown while a search runs. */
const SKELETON_ROWS = Array.from({ length: 6 }, (_, i) => `
  <div class="skeleton-row" style="--i:${i}">
    <div class="sk sk-cover"></div>
    <div class="sk-lines"><div class="sk sk-title"></div><div class="sk sk-artist"></div><div class="sk sk-meta"></div></div>
    <div class="sk sk-btn"></div>
  </div>`).join('');

class DiscoverTab extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.songs = [];
    this.searchResults = [];
    this.searching = false;       // a search request is in flight
    this.searchSeq = 0;           // bumps per search so a stale response is dropped
    this.searchedQuery = null;    // query the current results belong to (null = none run yet)
    this.activeSubtab = 'recommended'; // 'recommended', 'search', or 'link'
    this.searchQuery = '';
    // Related-tracks lookup shown on the Recommended subtab:
    // { song, status: 'loading'|'ready'|'queued'|'fetching'|'error', results, error, queuePosition }
    this.related = null;
    // Discover candidate from GET /api/discover (null until the Recommended subtab is first shown)
    this.discover = null;
    this.discoverBusy = false;    // a rate/redraw request is in flight
    this.discoverError = null;    // last request error, shown on the card
    this.discoverNotice = null;   // short confirmation, e.g. after a like
    // Like flow: the playlist picker ({ showOther }) while open, then the liked candidate stays
    // shown (this.discover) and playing until Next; server states arriving meanwhile wait in
    // pendingDiscover.
    this.likePicker = null;
    this.liked = false;
    this.pendingDiscover = null;
    // Set by Next and Dislike: play the following candidate as soon as it is ready.
    this.autoplayNext = false;
    // Preview player for the candidate. PlaybackController owns the element (so the OS media
    // controls show the candidate while it plays); this tab only drives it and mirrors its state.
    this.preview = playback.previewEl;
    this.preview.addEventListener('timeupdate', () => this.updatePreviewProgress());
    this.preview.addEventListener('play', () => this.updatePreviewButton());
    this.preview.addEventListener('pause', () => this.updatePreviewButton());
    this.preview.addEventListener('ended', () => {
      this.updatePreviewButton();
      // A liked track that plays out moves on by itself; an unrated one waits for a rating.
      if (this.liked) this.showNextCandidate();
    });
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
    this.loadDiscover();
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
      // Our candidate changed server-side (download finished, seed lookup done, another device rated).
      if (key === 'discoverUpdate' && value && this.discover && value.owner === appState.get('currentUser')) {
        this.loadDiscover();
      }
      if (key === 'downloadStatuses' && this.discover?.status === 'downloading' && this.activeSubtab === 'recommended') {
        this.renderContent();
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
        if (this.activeSubtab === 'recommended' && !this.discover) this.loadDiscover();
        return;
      }

      // Discover candidate controls
      if (event.target.closest('.preview-play')) {
        this.togglePreview();
        return;
      }
      const progress = event.target.closest('.preview-progress');
      if (progress) {
        this.seekPreview(event, progress);
        return;
      }
      if (event.target.classList.contains('like-backdrop')) {
        this.likeCandidate(null);   // tapping outside the picker = no playlist
        return;
      }
      const pick = event.target.closest('.pick-btn');
      if (pick) {
        if (pick.dataset.pick === 'other') {
          this.likePicker = { showOther: true };
          this.renderContent();
        } else {
          this.likeCandidate(pick.dataset.pick === 'none' ? null : Number(pick.dataset.pick));
        }
        return;
      }
      if (event.target.closest('.next-btn')) {
        this.showNextCandidate();
        return;
      }
      const rateBtn = event.target.closest('.rate-btn');
      if (rateBtn) {
        if (rateBtn.dataset.rating === 'like') this.openLikePicker();
        else this.rateCandidate(rateBtn.dataset.rating);
        return;
      }
      if (event.target.closest('.redraw-btn')) {
        this.redrawCandidate();
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

    // Tapping a search/related row enqueues it (pending until downloaded)
    this.shadowRoot.addEventListener('enqueue-track', (event) => {
      this.enqueueSearchResult(event.detail.track, event.detail.librarySongId);
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
        /* Search bar: the 1.5px "border" is the form's background showing around the
           input, so while searching it can become the app's blue/violet gradient and flow. */
        .search-form {
          position: relative;
          margin: 4px 0 12px;
          padding: 1.5px;
          border-radius: 14px;
          background: #3a3a3a;
          transition: background 0.2s, box-shadow 0.3s;
        }
        .search-form:focus-within { background: #1db954; }
        .search-form.searching {
          background: linear-gradient(90deg, #5ac8ff, #8a7bff, #ff6b35, #8a7bff, #5ac8ff) 0 0 / 300% 100%;
          box-shadow: 0 0 14px rgba(138, 123, 255, 0.45);
          animation: search-flow 1.6s linear infinite;
        }
        @keyframes search-flow { to { background-position: 150% 0; } }
        .search-glyph {
          position: absolute;
          left: 14px;
          top: 50%;
          width: 18px;
          height: 18px;
          margin-top: -9px;
          color: #888;
          pointer-events: none;
          display: grid;
          place-items: center;
        }
        .search-glyph svg { display: block; }
        /* While searching the magnifier becomes a spinning ring */
        .search-form.searching .search-glyph svg { display: none; }
        .search-form.searching .search-glyph::after {
          content: '';
          width: 14px;
          height: 14px;
          border-radius: 50%;
          border: 2px solid rgba(138, 123, 255, 0.25);
          border-top-color: #8a7bff;
          animation: search-spin 0.7s linear infinite;
        }
        @keyframes search-spin { to { transform: rotate(360deg); } }
        .search-input {
          -webkit-user-select: text;
          user-select: text;
          -webkit-touch-callout: default;
          -webkit-appearance: none;
          appearance: none;
          display: block;
          width: 100%;
          padding: 12px 14px 12px 42px;
          border: none;
          border-radius: 12.5px;
          background: #161616;
          color: #fff;
          font-size: 16px;
          box-sizing: border-box;
        }
        .search-input:focus { outline: none; }
        .search-input::placeholder { color: #666; }
        /* Results run edge to edge, like the library lists */
        .search-results { margin: 4px -20px 0; }
        .result-list { display: flex; flex-direction: column; animation: results-in 0.35s ease-out; }
        @keyframes results-in { from { opacity: 0; transform: translateY(8px); } }
        .search-hint {
          color: #777;
          font-size: 14px;
          text-align: center;
          margin: 32px 20px;
        }
        /* Skeleton rows: same geometry as <search-result-item>, with a shimmer sweep */
        .skeleton-row {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 8px 10px;
          border-bottom: 1px solid #0a0a0a;
          animation: skeleton-in 0.3s ease-out both;
          animation-delay: calc(var(--i) * 60ms);
        }
        @keyframes skeleton-in { from { opacity: 0; } }
        .sk {
          background: linear-gradient(90deg, #1a1a1a 0%, #1a1a1a 35%, #2c2c2c 50%, #1a1a1a 65%, #1a1a1a 100%) 0 0 / 300% 100%;
          animation: shimmer 1.3s linear infinite;
          animation-delay: calc(var(--i) * 90ms);
          border-radius: 4px;
        }
        @keyframes shimmer { from { background-position: 100% 0; } to { background-position: -50% 0; } }
        .sk-cover { width: 56px; height: 56px; border-radius: 0; flex-shrink: 0; }
        .sk-lines { flex: 1; display: flex; flex-direction: column; gap: 7px; }
        .sk-title { height: 13px; width: 70%; }
        .sk-artist { height: 11px; width: 42%; }
        .sk-meta { height: 9px; width: 30%; }
        .sk-btn { width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0; }
        @media (prefers-reduced-motion: reduce) {
          .search-form.searching, .sk { animation-duration: 4s; }
        }
        /* ---- Discover candidate card ---- */
        .discover-card {
          background: #222;
          border: 1px solid #333;
          border-radius: 14px;
          padding: 14px;
          margin-bottom: 24px;
        }
        .seed-row {
          display: flex;
          align-items: center;
          gap: 8px;
          color: #888;
          font-size: 12px;
          margin-bottom: 12px;
          min-width: 0;
        }
        .seed-row img {
          width: 28px;
          height: 28px;
          border-radius: 4px;
          object-fit: cover;
          flex: none;
          background: #333;
        }
        .seed-label {
          flex: none;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          font-weight: 700;
          color: #8a7bff;
        }
        .seed-text {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .seed-text strong { color: #ddd; font-weight: 600; }
        .candidate-cover {
          position: relative;
          width: min(100%, 320px);
          aspect-ratio: 1;
          margin: 0 auto 12px;
          border-radius: 10px;
          overflow: hidden;
          background: #2d2d2d;
        }
        .candidate-cover img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }
        .preview-play {
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          width: 68px;
          height: 68px;
          border-radius: 50%;
          border: none;
          background: rgba(0, 0, 0, 0.6);
          color: #fff;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .preview-play svg { width: 30px; height: 30px; fill: #fff; }
        .preview-play:disabled { display: none; }
        .candidate-title {
          color: #fff;
          font-size: 17px;
          font-weight: 700;
          margin: 0 0 2px;
          overflow-wrap: anywhere;
        }
        .candidate-artist {
          color: #aaa;
          font-size: 14px;
          margin: 0 0 8px;
          overflow-wrap: anywhere;
        }
        .candidate-artist .source-tag { color: #666; text-transform: capitalize; }
        .candidate-status {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          font-weight: 700;
          padding: 3px 10px;
          border-radius: 999px;
          background: #333;
          color: #bbb;
          margin-bottom: 10px;
        }
        .candidate-status.ready { background: rgba(29, 185, 84, 0.18); color: #1db954; }
        .candidate-status.error { background: rgba(244, 67, 54, 0.15); color: #f66; }
        .candidate-status .dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: currentColor;
        }
        .candidate-status.pending .dot { animation: pulse 1.2s ease-in-out infinite; }
        @keyframes pulse { 50% { opacity: 0.25; } }
        .preview-progress {
          height: 18px;
          display: flex;
          align-items: center;
          cursor: pointer;
          margin-bottom: 4px;
        }
        .preview-progress .track {
          position: relative;
          flex: 1;
          height: 4px;
          border-radius: 2px;
          background: #3a3a3a;
          overflow: hidden;
        }
        .preview-progress .fill {
          position: absolute;
          inset: 0 auto 0 0;
          width: 0;
          background: #1db954;
        }
        .preview-time {
          display: flex;
          justify-content: space-between;
          color: #777;
          font-size: 11px;
          font-variant-numeric: tabular-nums;
          margin-bottom: 6px;
        }
        .discover-card .related-metrics { padding: 0 0 12px 0; }
        .rate-row {
          display: grid;
          grid-template-columns: 1fr auto 1fr;
          gap: 10px;
        }
        .rate-row button {
          padding: 12px 10px;
          border-radius: 10px;
          border: 1px solid #444;
          background: #2a2a2a;
          color: #fff;
          font-size: 15px;
          font-weight: 700;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
        }
        .rate-row svg { width: 18px; height: 18px; fill: currentColor; flex: none; }
        .rate-btn.dislike { color: #f66; border-color: rgba(244, 67, 54, 0.5); }
        .rate-btn.like, .next-btn { color: #1db954; border-color: rgba(29, 185, 84, 0.5); }
        .like-backdrop {
          position: fixed;
          inset: 0;
          z-index: 200;
          background: rgba(0, 0, 0, 0.6);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px 20px calc(120px + env(safe-area-inset-bottom, 0px));
          box-sizing: border-box;
        }
        .like-picker {
          width: 100%;
          max-width: 360px;
          max-height: 100%;
          overflow-y: auto;
          background: #232323;
          border: 1px solid #3a3a3a;
          border-radius: 14px;
          padding: 16px;
          box-sizing: border-box;
        }
        .like-picker h4 { color: #fff; margin: 0 0 4px; font-size: 17px; }
        .like-picker .pick-track {
          color: #888;
          font-size: 13px;
          margin: 0 0 12px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .like-picker .pick-list { display: flex; flex-direction: column; gap: 8px; }
        .like-picker .pick-label { color: #777; font-size: 12px; margin: 6px 0 0; }
        .pick-btn {
          padding: 12px 14px;
          border-radius: 10px;
          border: 1px solid #444;
          background: #2a2a2a;
          color: #fff;
          font-size: 15px;
          text-align: left;
          cursor: pointer;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .pick-btn.feeder { border-color: rgba(29, 185, 84, 0.5); }
        .pick-btn.muted { color: #aaa; }
        .redraw-btn { color: #bbb; }
        .rate-row button:disabled { opacity: 0.35; cursor: default; }
        .discover-note { color: #888; font-size: 13px; margin: 0 0 10px; }
        .up-next {
          color: #777;
          font-size: 12px;
          margin: 10px 0 0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .up-next-ready { color: #1db954; font-weight: 700; }
        .discover-note.error { color: #f66; }
        .discover-note.success { color: #1db954; }
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
        ${this.renderDiscoverCard()}
        ${this.renderLikePicker()}
        ${this.related ? `<h3>Related</h3>${this.renderRelatedBody()}` : ''}
        <div class="account-row">
          ${user ? `<span class="account-name">Signed in as ${user}</span>` : ''}
          <button class="logout-btn">Log out</button>
        </div>
      </div>
    `;
    this.updatePreviewProgress();
  }

  /**
   * Markup for the discover candidate card: its seed, cover with preview button, download status,
   * and the Dislike / Redraw / Like row.
   * @returns {string} HTML
   */
  renderDiscoverCard() {
    const d = this.discover;
    const busy = this.discoverBusy;
    const notice = this.discoverError
      ? `<p class="discover-note error">${esc(this.discoverError)}</p>`
      : (this.discoverNotice ? `<p class="discover-note success">${esc(this.discoverNotice)}</p>` : '');
    if (!d) return `<div class="discover-card">${notice || '<p class="discover-note">Drawing a candidate…</p>'}</div>`;

    const seed = d.seed ? `
      <div class="seed-row">
        <span class="seed-label">Seed</span>
        ${d.seed.cover ? `<img src="${esc(d.seed.cover)}" alt="">` : ''}
        <span class="seed-text"><strong>${esc(d.seed.title)}</strong> — ${esc(d.seed.artist || 'Unknown')}</span>
      </div>` : '';

    const t = d.track;
    const ready = d.status === 'ready' && t?.audio_url;
    const body = t ? `
      <div class="candidate-cover">
        ${t.cover ? `<img src="${esc(t.cover)}" alt="">` : ''}
        <button class="preview-play" ${ready ? '' : 'disabled'} aria-label="Play preview">${this.previewIcon()}</button>
      </div>
      <p class="candidate-title">${esc(t.title || 'Unknown')}</p>
      <p class="candidate-artist">${esc(t.artist || 'Unknown')} <span class="source-tag">· ${esc(t.source)}</span></p>
      ${this.renderCandidateStatus(d)}
      ${ready ? `
        <div class="preview-progress"><div class="track"><div class="fill"></div></div></div>
        <div class="preview-time"><span class="preview-current">0:00</span><span class="preview-total">${t.duration ? formatDuration(t.duration) : ''}</span></div>` : ''}
      <div class="related-metrics">${this.formatMetrics(t)}</div>` : this.renderCandidateStatus(d);

    const thumbDown = '<svg viewBox="0 0 24 24"><path d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z"/></svg>';
    const thumbUp = '<svg viewBox="0 0 24 24"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg>';
    const redraw = '<svg viewBox="0 0 24 24"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>';
    const skipNext = '<svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>';
    // After a like the track keeps playing: Next replaces Like, and Redraw goes (it would do the same).
    const liked = this.liked;
    const pending = this.pendingDiscover;
    const upNext = liked
      ? (pending?.track ? { status: pending.status, title: pending.track.title } : null)
      : d.next;
    return `
      <div class="discover-card">
        ${notice}
        ${seed}
        ${body}
        <div class="rate-row">
          <button class="rate-btn dislike" data-rating="dislike" ${t && !busy && !liked ? '' : 'disabled'}>${thumbDown} Dislike</button>
          ${liked ? '<span></span>' : `<button class="redraw-btn" ${busy ? 'disabled' : ''} aria-label="Redraw">${redraw}</button>`}
          ${liked
            ? `<button class="next-btn" ${busy ? 'disabled' : ''}>Next ${skipNext}</button>`
            : `<button class="rate-btn like" data-rating="like" ${ready && !busy ? '' : 'disabled'}>${thumbUp} Like</button>`}
        </div>
        ${this.renderUpNext(upNext)}
      </div>`;
  }

  /**
   * Markup for the like's playlist picker: the Play-tab feeder playlists, "Other" (expands to the
   * user's remaining playlists) and "None". Empty when the picker is closed.
   * @returns {string} HTML
   */
  renderLikePicker() {
    if (!this.likePicker || !this.discover?.track) return '';
    const playlists = (appState.get('playlists') || []).filter((p) => p.kind !== 'orphans');
    const feederIds = appState.get('playFeeders') || [];
    const feeders = playlists.filter((p) => feederIds.includes(p.id));
    const others = playlists.filter((p) => !feederIds.includes(p.id));
    const button = (p, cls = '') => `<button class="pick-btn ${cls}" data-pick="${p.id}">${esc(p.name)}</button>`;
    const otherList = this.likePicker.showOther
      ? (others.length
        ? `<p class="pick-label">Other playlists</p>${others.map((p) => button(p)).join('')}`
        : '<p class="pick-label">No other playlists</p>')
      : (others.length ? '<button class="pick-btn muted" data-pick="other">Other…</button>' : '');
    const t = this.discover.track;
    return `
      <div class="like-backdrop">
        <div class="like-picker" role="dialog" aria-label="Add to playlist">
          <h4>Add to playlist?</h4>
          <p class="pick-track">${esc(t.title || 'Unknown')} — ${esc(t.artist || 'Unknown')}</p>
          <div class="pick-list">
            ${feeders.map((p) => button(p, 'feeder')).join('')}
            ${otherList}
            <button class="pick-btn muted" data-pick="none">None</button>
          </div>
        </div>
      </div>`;
  }

  /**
   * One-line progress of the next candidate, which the server pre-downloads once the current one is ready.
   * @param {Object|null} next - { status, title, artist } from the discover state
   * @returns {string} HTML
   */
  renderUpNext(next) {
    if (!next || next.status === 'error') return '';
    const label = {
      ready: '<span class="up-next-ready">ready</span>',
      downloading: 'downloading…',
      fetching_related: 'finding tracks…',
    }[next.status] || esc(next.status);
    const title = next.title ? ` · ${esc(next.title)}` : '';
    return `<p class="up-next">Up next: ${label}${title}</p>`;
  }

  /**
   * Status pill for the candidate: seed lookup, download progress, ready, or error.
   * @param {Object} d - this.discover
   * @returns {string} HTML
   */
  renderCandidateStatus(d) {
    let cls = 'pending';
    let label;
    if (d.status === 'ready') {
      cls = 'ready';
      label = 'Ready to play';
    } else if (d.status === 'downloading') {
      const dl = (appState.get('downloadStatuses') || {})[d.track?.url];
      label = dl === 'downloading' ? 'Downloading…' : 'Queued for download…';
    } else if (d.status === 'fetching_related') {
      const job = d.seed?.related_job;
      const pos = job?.state === 'queued' && job.position > 1 ? ` (position ${job.position})` : '';
      label = `Finding tracks related to the seed${pos}…`;
    } else if (d.status === 'error') {
      cls = 'error';
      label = d.error || 'Something went wrong — try Redraw.';
    } else {
      label = 'No candidate';
    }
    return `<div class="candidate-status ${cls}"><span class="dot"></span>${esc(label)}</div>`;
  }

  /** @returns {string} Play or pause SVG for the preview button, matching the preview's state. */
  previewIcon() {
    return this.preview.paused
      ? '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
  }

  /** Sync the preview button icon with the preview's play state (no full re-render). */
  updatePreviewButton() {
    const btn = this.shadowRoot.querySelector('.preview-play');
    if (btn) btn.innerHTML = this.previewIcon();
  }

  /** Move the preview progress bar and time label to the preview's position. */
  updatePreviewProgress() {
    const fill = this.shadowRoot.querySelector('.preview-progress .fill');
    const label = this.shadowRoot.querySelector('.preview-current');
    const duration = this.preview.duration;
    if (fill && duration) fill.style.width = `${(this.preview.currentTime / duration) * 100}%`;
    if (label) label.textContent = formatDuration(this.preview.currentTime * 1000);
  }

  /** Play/pause the candidate preview (the controller pauses the main player first). */
  togglePreview() {
    playback.togglePreview();
  }

  /**
   * Seek the preview to the tapped point of the progress bar.
   * @param {MouseEvent} event
   * @param {HTMLElement} bar - .preview-progress
   */
  seekPreview(event, bar) {
    const duration = this.preview.duration;
    if (!duration) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    playback.seekPreview(ratio * duration);
    this.updatePreviewProgress();
  }

  /**
   * Point the preview at the candidate's file, stopping it when the candidate changed.
   * @param {Object|null} state - Discover state from the server
   */
  syncPreview(state) {
    const track = state?.status === 'ready' ? state.track : null;
    playback.loadPreview(track);
    if (track && this.autoplayNext) {
      this.autoplayNext = false;
      playback.playPreview();
    }
  }

  /**
   * Store a discover state from the server and re-render the Recommended subtab.
   * @param {Object} state
   */
  applyDiscover(state) {
    if (this.liked) {
      // The liked track stays on screen and playing; hold the new state until Next.
      this.pendingDiscover = state;
      if (this.activeSubtab === 'recommended') this.renderContent();
      return;
    }
    this.discover = state;
    this.syncPreview(state);
    if (this.activeSubtab === 'recommended') this.renderContent();
  }

  /** Fetch the current candidate (the server draws one if needed). */
  async loadDiscover() {
    try {
      const state = await fetchDiscover();
      this.discoverError = null;
      this.applyDiscover(state);
    } catch (err) {
      this.discoverError = err.message || 'Could not load a candidate';
      if (this.activeSubtab === 'recommended') this.renderContent();
    }
  }

  /**
   * Dislike the candidate, then show the next one (likes go through likeCandidate).
   * @param {'dislike'} rating
   */
  async rateCandidate(rating) {
    const track = this.discover?.track;
    if (!track || this.discoverBusy || this.liked) return;
    this.autoplayNext = true;
    const ok = await this.discoverAction(() => rateDiscover(track.url, rating));
    if (!ok) this.autoplayNext = false;
  }

  /** Open the like's playlist picker (the preview keeps playing). */
  openLikePicker() {
    if (this.discover?.status !== 'ready' || this.discoverBusy || this.liked) return;
    this.likePicker = { showOther: false };
    this.renderContent();
  }

  /**
   * Like the candidate and optionally add it to a playlist, keeping it on screen and playing:
   * the server already moves on, but its next state is held back until Next.
   * @param {number|null} playlistId - Playlist chosen in the picker, or null for none
   */
  async likeCandidate(playlistId) {
    this.likePicker = null;
    const track = this.discover?.track;
    if (!track || this.discoverBusy) {
      this.renderContent();
      return;
    }
    const playlist = (appState.get('playlists') || []).find((p) => p.id === playlistId) || null;
    this.liked = true;   // set first so a socket-triggered refetch can't stop the preview
    this.discoverBusy = true;
    this.discoverError = null;
    this.discoverNotice = null;
    this.renderContent();
    try {
      const state = await rateDiscover(track.url, 'like');
      this.pendingDiscover = state;
      this.discoverNotice = `Added "${track.title}" to the library`;
      if (playlist && state.added_song_id) {
        try {
          await addSongToPlaylist(playlist.id, state.added_song_id);
          this.discoverNotice = `Added "${track.title}" to ${playlist.name}`;
        } catch (err) {
          this.discoverError = `Liked, but couldn't add it to ${playlist.name}: ${err.message}`;
        }
      }
    } catch (err) {
      this.liked = false;
      this.pendingDiscover = null;
      this.discoverBusy = false;
      await this.loadDiscover();
      this.discoverError = err.message || 'Request failed';
      this.renderContent();
      return;
    }
    this.discoverBusy = false;
    this.renderContent();
    try {
      const [songs, playlists] = await Promise.all([fetchSongs(), fetchPlaylists()]);
      if (songs) appState.set('songs', songs);
      if (playlists) appState.set('playlists', playlists);
    } catch (err) {
      console.error('Error refreshing the library after a like:', err);
    }
  }

  /** Leave the liked track for the next candidate (stopping the liked track's preview). */
  showNextCandidate() {
    if (!this.liked || this.discoverBusy) return;
    const pending = this.pendingDiscover;
    this.liked = false;
    this.pendingDiscover = null;
    this.discoverNotice = null;
    this.discoverError = null;
    this.preview.pause();
    this.autoplayNext = true;
    if (pending) this.applyDiscover(pending);
    this.loadDiscover();   // pick up anything the held-back state missed
  }

  /** Discard the candidate without rating it and draw a new one. */
  redrawCandidate() {
    if (this.discoverBusy) return;
    this.autoplayNext = false;
    this.discoverAction(() => redrawDiscover());
  }

  /**
   * Run a rate/redraw request with the buttons disabled; the preview stops right away.
   * @param {() => Promise<Object>} request - Resolves to the next discover state
   * @returns {Promise<boolean>} Whether the request succeeded
   */
  async discoverAction(request) {
    this.discoverBusy = true;
    this.discoverError = null;
    this.discoverNotice = null;
    this.preview.pause();
    this.renderContent();
    try {
      const state = await request();
      this.discoverBusy = false;
      this.applyDiscover(state);
      return true;
    } catch (err) {
      this.discoverBusy = false;
      // The candidate may have changed underneath us (e.g. rated on another device): resync,
      // then show why the action failed.
      await this.loadDiscover();
      this.discoverError = err.message || 'Request failed';
      this.renderContent();
      return false;
    }
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

    const items = r.results.map(resultItemHtml).join('');
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
    if (track.library_song_id) chips.push(`<span class="in-library">${icon('in-library')} In library</span>`);
    if (track.duration) chips.push(`${icon('duration')} ${formatDuration(track.duration)}`);
    if (m.plays != null) chips.push(`${icon('play-count')} ${compactNumber.format(m.plays)}`);
    if (m.likes != null) {
      const ratio = m.like_ratio != null ? ` (${(m.like_ratio * 100).toFixed(1)}%)` : '';
      chips.push(`${icon('like-count')} ${compactNumber.format(m.likes)}${ratio}`);
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
    if (!this.discover) this.loadDiscover();
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
        <form class="search-form ${this.searching ? 'searching' : ''}" role="search">
          <span class="search-glyph" aria-hidden="true">${SEARCH_SVG}</span>
          <input type="search" class="search-input" placeholder="Search YouTube & SoundCloud" enterkeyhint="search"
            autocomplete="off" autocorrect="off" spellcheck="false" value="${esc(this.searchQuery)}">
        </form>
        <div class="source-pills">${pills}</div>
        <div class="search-results"></div>
      </div>
    `;

    const searchInput = container.querySelector('.search-input');
    searchInput.addEventListener('input', (e) => { this.searchQuery = e.target.value; });
    // Search runs only on Enter (form submit), never while typing.
    container.querySelector('.search-form').addEventListener('submit', (e) => {
      e.preventDefault();
      searchInput.blur();   // drop the on-screen keyboard so the results are visible
      this.handleSearch(this.searchQuery.trim());
    });

    this.renderSearchResults();
  }

  /**
   * Return to the default (Recommended) subtab — used when the tab button is re-tapped.
   */
  showDefaultSubtab() {
    if (this.activeSubtab === 'recommended') return;
    this.activeSubtab = 'recommended';
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
   * Run a search (on Enter). An empty query clears the results; a newer search
   * supersedes one still in flight.
   * @param {string} query - Search query
   */
  async handleSearch(query) {
    const seq = ++this.searchSeq;
    if (!query) {
      this.searchResults = [];
      this.searchedQuery = null;
      this.setSearching(false);
      return;
    }

    this.setSearching(true);
    const results = await searchSongs(query);   // resolves to [] on failure
    if (seq !== this.searchSeq) return;
    this.searchResults = results || [];
    this.searchedQuery = query;
    this.setSearching(false);
  }

  /**
   * Toggle the searching animation (input glow + skeleton rows) and redraw the results.
   * @param {boolean} on
   */
  setSearching(on) {
    this.searching = on;
    this.shadowRoot.querySelector('.search-form')?.classList.toggle('searching', on);
    this.renderSearchResults();
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

    if (this.searching) {
      resultsEl.innerHTML = SKELETON_ROWS;
      return;
    }
    if (this.searchedQuery == null) {
      resultsEl.innerHTML = '<p class="search-hint">Type a song or artist and press Enter.</p>';
      return;
    }

    const filtered = this.searchResults.filter(r =>
      this.selectedSources.has((r.source || '').toLowerCase())
    );
    if (filtered.length === 0) {
      const why = this.searchResults.length ? 'with the selected sources' : `for “${esc(this.searchedQuery)}”`;
      resultsEl.innerHTML = `<p class="search-hint">No results ${why}.</p>`;
      return;
    }

    resultsEl.innerHTML = `<div class="result-list">${this.interleaveResults(filtered).map(resultItemHtml).join('')}</div>`;
  }

  /**
   * Download a track from search results
   * @param {Object} track - Track object with title, artist, source, url, cover
   */
  async downloadSearchResult(track) {
    // Progress shows on the row's own button (driven by downloadStatuses), so only
    // failures to queue get a banner.
    try {
      const result = await downloadTrack(track.url, track.source, track);
      if (!result.success) this.showMessage(`Couldn't queue "${track.title}"`, 'warning');
    } catch (error) {
      this.showMessage(`Download failed: ${error.message}`, 'error');
    }
  }

  /**
   * Enqueue a search result. A track already in the library goes in as that song; otherwise
   * it goes in as a pending entry (the player skips it until it's downloaded) and its
   * download is started if it isn't already under way. Repeat taps follow the usual
   * enqueue → move-to-front → play cycle in MusicApp.enqueueSong.
   * @param {Object} track - { title, artist, source, url, cover }
   * @param {number|null} librarySongId - Library id from the search result, if known
   */
  enqueueSearchResult(track, librarySongId) {
    const songs = appState.get('songs') || [];
    const librarySong = songs.find(s => (librarySongId ? s.id === librarySongId : s.download_link === track.url) && s.url);
    this.dispatchEvent(new CustomEvent('enqueue-song', {
      detail: { song: librarySong || pendingSong(track) },
      bubbles: true
    }));
    if (librarySong) return;
    const status = (appState.get('downloadStatuses') || {})[track.url];
    if (!['queued', 'downloading', 'completed'].includes(status)) this.downloadSearchResult(track);
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
    this.preview.pause();
  }
}

customElements.define('discover-tab', DiscoverTab);
