/**
 * Track editor - full-page frosted sheet to edit a song's name, artist and clip
 * (start/end), re-download it, show related tracks or delete it. Everything behind it
 * is blurred. The button in the corner spins the card over (3D flip) to its back: the
 * playlists (feeders first), where tapping one adds/removes the track. Given an `origin` element, the sheet grows out of that element's box and
 * shrinks back into it on close (the element is hidden meanwhile, so it reads as the
 * element itself expanding) — the Play tab uses this for its title slab.
 * Usage: const ed = document.createElement('track-editor');
 *        ed.setAttribute('song', JSON.stringify(song));
 *        ed.origin = { el, inset, radius }; // optional: px inset of the visible box, corner radius
 *        root.appendChild(ed);
 * Emits: 'close' when dismissed, 'saved' when save succeeds, 'deleted' when deleted,
 *        'redownload' when a re-download is queued (detail: { songId }),
 *        'show-related' when "Show related" is tapped (detail: { song }),
 *        'playlist-toggle' when a playlist is tapped on the back (detail: { playlistId, add, song,
 *        result } — the handler sets result to a promise of the outcome)
 */

import { updateSong, deleteSong, redownloadSong } from '../services/api.js';
import appState from '../state/appState.js';
import { icon as uiIcon } from '../icons.js';

const MIN_GAP = 0.1;       // minimum seconds between start and end
const PREVIEW_SECONDS = 3; // length of the start/end preview snippets
const OPEN_MS = 420;       // sheet grow / shrink duration
const EASE = 'cubic-bezier(0.2, 0.85, 0.25, 1)';
const FLIP_MS = 760;       // card flip duration

// Two arrows chasing round: "turn the card over".
const FLIP_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/>
  <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/></svg>`;
const CHECK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const NOTE_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>`;

/** Escape text for HTML. */
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

class TrackEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    this.song = null;
    this.origin = null; // { el, inset, radius } the sheet grows out of, if any
    this.duration = 0;
    this.startTime = 0;
    this.endTime = 0;
    this.isLoadingDuration = true;
    this.closing = false;
    this.flipped = false;  // showing the playlists side
    this.flipping = false;
    this.pendingToggles = new Map(); // playlistId -> membership we're waiting on

    // Slider drag state
    this.draggingThumb = null; // 'start' | 'end'
    this.lastPointerX = 0;
    this.sliderRect = null;
    this.precisionFactor = 1;
    this.boundMove = this.handleSliderMove.bind(this);
    this.boundEnd = this.handleSliderEnd.bind(this);

    // Preview playback state (a dedicated <audio>, independent of the main app's)
    this.previewAudio = null;
    this.previewWhich = null; // 'start' | 'end' | null
    this.previewTimer = null;
  }

  static get observedAttributes() {
    return ['song'];
  }

  attributeChangedCallback(name, oldVal, newVal) {
    // Before connect, connectedCallback reads the attribute itself.
    if (name === 'song' && newVal && this.isConnected) {
      this.parseSong(newVal);
      this.render();
      this.initFromSong();
    }
  }

  /** @param {string} json - The `song` attribute */
  parseSong(json) {
    try {
      this.song = JSON.parse(json);
    } catch (e) {
      this.song = null;
    }
  }

  /** Read the clip from the song and load the file's duration for the slider. */
  initFromSong() {
    if (!this.song) return;

    this.startTime = this.song.start_time ?? 0;
    this.endTime = this.song.end_time ?? null;
    this.isLoadingDuration = true;

    if (this.song.url) {
      const audio = new Audio();
      audio.preload = 'metadata';
      audio.addEventListener('loadedmetadata', () => {
        this.duration = audio.duration;
        if (this.endTime == null || this.endTime > this.duration) {
          this.endTime = this.duration;
        }
        if (this.startTime > this.endTime) {
          this.startTime = 0;
        }
        this.isLoadingDuration = false;
        this.renderClip();
      });
      audio.addEventListener('error', () => {
        this.duration = 300; // Fallback 5 min
        if (this.endTime == null || this.endTime > this.duration) this.endTime = this.duration;
        this.isLoadingDuration = false;
        this.renderClip();
      });
      audio.src = this.song.url.startsWith('/') ? window.location.origin + this.song.url : this.song.url;
    } else {
      this.duration = 300;
      if (this.endTime == null) this.endTime = this.duration;
      this.isLoadingDuration = false;
      this.renderClip();
    }
  }

  connectedCallback() {
    const songAttr = this.getAttribute('song');
    if (songAttr) this.parseSong(songAttr);
    this.render();
    this.initFromSong();
    this.animateOpen();
    this.unsubscribeState = appState.subscribe((key) => {
      if (key === 'playlists' || key === 'playFeeders') this.renderPlaylists();
    });
  }

  disconnectedCallback() {
    this.unsubscribeState?.();
    this.stopPreview();
    this.handleSliderEnd();
    this.showOrigin();
  }

  formatTime(seconds) {
    if (seconds == null || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  /** Format as m:ss.mmm for the editable time fields. */
  formatTimeMs(seconds) {
    if (seconds == null || isNaN(seconds) || seconds < 0) seconds = 0;
    const totalMs = Math.round(seconds * 1000);
    const m = Math.floor(totalMs / 60000);
    const s = Math.floor((totalMs % 60000) / 1000);
    const ms = totalMs % 1000;
    return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  }

  /** Parse "m:ss.mmm", "ss.mmm" or a plain seconds value into seconds. Returns null if unparseable. */
  parseTimeMs(str) {
    str = String(str).trim();
    if (!str) return null;
    let total;
    if (str.includes(':')) {
      const parts = str.split(':');
      const minutes = parseFloat(parts[0]);
      const secs = parseFloat(parts[1]);
      if (isNaN(minutes) || isNaN(secs)) return null;
      total = minutes * 60 + secs;
    } else {
      total = parseFloat(str);
    }
    return isNaN(total) ? null : total;
  }

  /** True when the song is a library row (numeric id) that can be saved/deleted. */
  isLibrarySong() {
    const id = this.song?.id;
    return id != null && (typeof id === 'number' || /^\d+$/.test(String(id)));
  }

  /**
   * Render the sheet once. Later updates (duration loaded) only re-render the clip
   * section, so the open animation and typed text survive them.
   */
  render() {
    const song = this.song || {};
    const canSave = this.isLibrarySong();
    const canShowRelated = canSave && ['youtube', 'soundcloud'].includes((song.source || '').toLowerCase());

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          position: fixed;
          inset: 0;
          z-index: 1000;
          --accent: #8000FF;
          --accent-text: #b98cff;
          --glass: rgba(255,255,255,0.07);
          --glass-strong: rgba(255,255,255,0.12);
          --hairline: rgba(255,255,255,0.12);
          --muted: rgba(255,255,255,0.55);
          --danger: #ff5a5f;
          color: #fff;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        button { font: inherit; -webkit-tap-highlight-color: transparent; }
        .backdrop {
          position: absolute;
          inset: 0;
          background: rgba(0,0,0,0.42);
          -webkit-backdrop-filter: blur(26px) saturate(150%);
          backdrop-filter: blur(26px) saturate(150%);
        }
        /* The page-filling sheet. It's laid out at full size from the start; the open
           animation only clips it (clip-path) from the origin's box, so nothing reflows. */
        .sheet {
          position: absolute;
          top: max(12px, env(safe-area-inset-top));
          bottom: max(12px, env(safe-area-inset-bottom));
          left: max(12px, env(safe-area-inset-left));
          right: max(12px, env(safe-area-inset-right));
          max-width: 560px;
          margin: 0 auto;
          perspective: 1600px;
        }
        /* The card that flips. Each face is a full glass panel; the back one starts
           turned away, and backface-visibility hides whichever faces away from you. */
        .flipper {
          position: absolute;
          inset: 0;
          transform-style: preserve-3d;
          -webkit-transform-style: preserve-3d;
        }
        .face {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          border-radius: 28px;
          background: linear-gradient(160deg, rgba(60,60,72,0.62), rgba(18,18,24,0.72));
          border: 1px solid var(--hairline);
          box-shadow: 0 30px 80px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.10);
          overflow: hidden;
          -webkit-backface-visibility: hidden;
          backface-visibility: hidden;
        }
        .face.back {
          transform: rotateY(180deg);
          background: linear-gradient(200deg, rgba(64,44,92,0.66), rgba(16,14,24,0.76));
        }
        /* Only the face toward you takes taps. */
        .sheet.show-back .front, .sheet:not(.show-back) .back { pointer-events: none; }
        /* Darkens a face as it turns edge-on, so the spin reads as lit 3D. */
        .shade {
          position: absolute;
          inset: 0;
          background: linear-gradient(90deg, rgba(0,0,0,0.65), rgba(0,0,0,0.15));
          opacity: 0;
          pointer-events: none;
          z-index: 3;
        }
        .sheet-scroll {
          flex: 1 1 auto;
          overflow-y: auto;
          overscroll-behavior: contain;
          -webkit-overflow-scrolling: touch;
          padding: 22px 20px 12px;
        }

        /* Header: cover + editable name/artist, styled like the slab's text. */
        .head {
          display: flex;
          gap: 16px;
          align-items: center;
          margin-bottom: 26px;
        }
        .cover {
          flex: 0 0 auto;
          width: 76px;
          height: 76px;
          border-radius: 16px;
          background: var(--glass-strong) center / cover no-repeat;
          box-shadow: 0 8px 24px rgba(0,0,0,0.45);
        }
        .names { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
        .name-input {
          -webkit-user-select: text;
          user-select: text;
          -webkit-touch-callout: default;
          width: 100%;
          box-sizing: border-box;
          background: transparent;
          border: none;
          border-radius: 10px;
          color: #fff;
          padding: 4px 8px;
          margin-left: -8px;
          transition: background 150ms;
          text-overflow: ellipsis;
        }
        .name-input:focus { outline: none; background: var(--glass-strong); }
        .title-input { font-size: 22px; font-weight: 700; line-height: 30px; }
        .artist-input { font-size: 17px; line-height: 24px; color: rgba(255,255,255,0.75); }
        .name-input::placeholder { color: rgba(255,255,255,0.3); }
        .flip-btn {
          flex: 0 0 auto;
          align-self: flex-start;
          width: 34px;
          height: 34px;
          padding: 0;
          border-radius: 50%;
          border: none;
          background: var(--glass-strong);
          color: rgba(255,255,255,0.85);
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
        }
        .flip-btn svg { width: 18px; height: 18px; }

        /* Back face: the track's playlists. */
        .back-head {
          display: flex;
          gap: 14px;
          align-items: center;
          padding: 22px 20px 16px;
          border-bottom: 1px solid var(--hairline);
        }
        .back-head .cover { width: 52px; height: 52px; border-radius: 12px; }
        .back-titles { flex: 1 1 auto; min-width: 0; }
        .back-title { font-size: 20px; font-weight: 700; line-height: 26px; }
        .back-sub {
          font-size: 13px;
          color: var(--muted);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .back-scroll {
          flex: 1 1 auto;
          overflow-y: auto;
          overscroll-behavior: contain;
          -webkit-overflow-scrolling: touch;
          padding: 18px 20px 20px;
        }
        .pl-icon {
          flex: 0 0 auto;
          width: 40px;
          height: 40px;
          border-radius: 10px;
          background: var(--glass-strong) center / cover no-repeat;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--muted);
        }
        .pl-text { flex: 1 1 auto; min-width: 0; }
        .pl-name { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .check {
          flex: 0 0 auto;
          width: 26px;
          height: 26px;
          border-radius: 50%;
          border: 2px solid rgba(255,255,255,0.3);
          box-sizing: border-box;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background 160ms, border-color 160ms, transform 160ms;
        }
        .check svg { width: 14px; height: 14px; opacity: 0; transition: opacity 160ms; }
        .row.member .check { background: var(--accent); border-color: var(--accent); box-shadow: 0 0 12px rgba(128,0,255,0.5); }
        .row.member .check svg { opacity: 1; }
        .row:active .check { transform: scale(0.88); }
        .row.pending .check { opacity: 0.6; }
        .empty { color: var(--muted); font-size: 14px; padding: 6px 4px; }

        .section-label {
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--muted);
          margin: 0 4px 10px;
        }
        .card {
          background: var(--glass);
          border: 1px solid var(--hairline);
          border-radius: 20px;
          padding: 18px 16px;
          margin-bottom: 22px;
        }
        .loading { color: var(--muted); font-size: 14px; margin: 6px 0; }

        /* Clip range slider */
        .range-track {
          position: relative;
          height: 32px;
          margin: 4px 14px 0;
        }
        .range-bar, .range-fill {
          position: absolute;
          top: 50%;
          transform: translateY(-50%);
          height: 8px;
          border-radius: 4px;
        }
        .range-bar { left: 0; right: 0; background: rgba(255,255,255,0.14); }
        .range-fill {
          background: linear-gradient(90deg, var(--accent), #a64dff);
          box-shadow: 0 0 14px rgba(128,0,255,0.55);
          pointer-events: none;
        }
        .range-thumb {
          position: absolute;
          top: 50%;
          transform: translate(-50%, -50%);
          width: 26px;
          height: 26px;
          background: #fff;
          border-radius: 50%;
          box-shadow: 0 2px 10px rgba(0,0,0,0.45);
          cursor: grab;
          z-index: 2;
          touch-action: none;
        }
        .range-thumb:active { cursor: grabbing; transform: translate(-50%, -50%) scale(1.12); }
        .range-ends {
          display: flex;
          justify-content: space-between;
          font-size: 11px;
          color: var(--muted);
          margin: 6px 2px 0;
          font-variant-numeric: tabular-nums;
        }
        .precision-hint { font-size: 11px; color: var(--muted); margin: 10px 2px 4px; }

        .time-control { margin-top: 16px; }
        .time-control-head {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
        }
        .time-control-title { font-size: 14px; font-weight: 600; }
        .preview-btn {
          background: var(--glass-strong);
          border: none;
          color: var(--accent-text);
          border-radius: 999px;
          font-size: 12px;
          font-weight: 600;
          padding: 6px 12px;
          cursor: pointer;
        }
        .preview-btn.playing { background: var(--accent); color: #fff; }
        .time-row { display: flex; align-items: center; gap: 4px; }
        .adj-btn {
          flex: 1 1 0;
          min-width: 0;
          padding: 8px 0;
          background: var(--glass);
          border: none;
          color: rgba(255,255,255,0.8);
          border-radius: 10px;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
        }
        .adj-btn:active { background: var(--glass-strong); }
        .time-input {
          flex: 2.4 1 0;
          min-width: 0;
          text-align: center;
          padding: 7px 4px;
          background: rgba(0,0,0,0.28);
          border: 1px solid transparent;
          border-radius: 10px;
          color: #fff;
          font-size: 15px;
          font-variant-numeric: tabular-nums;
          box-sizing: border-box;
        }
        .time-input:focus { outline: none; border-color: var(--accent); }
        .units-hint { font-size: 10px; color: var(--muted); text-align: right; margin: 8px 2px 0; }

        /* Action list: iOS-style grouped rows. */
        .list { padding: 0; overflow: hidden; }
        .row {
          display: flex;
          align-items: center;
          gap: 12px;
          width: 100%;
          padding: 15px 16px;
          background: none;
          border: none;
          color: #fff;
          font-size: 16px;
          text-align: left;
          cursor: pointer;
        }
        .row + .row { border-top: 1px solid var(--hairline); }
        .row:active:not(:disabled) { background: var(--glass); }
        .row:disabled { opacity: 0.4; cursor: not-allowed; }
        .row .icon { width: 22px; text-align: center; }
        .row .sub { display: block; font-size: 12px; color: var(--muted); margin-top: 2px; }
        .row.danger { color: var(--danger); }
        @media (hover: hover) {
          .row:hover:not(:disabled), .adj-btn:hover { background: var(--glass-strong); }
          .flip-btn:hover { color: #fff; }
        }

        /* Pinned footer */
        .actions {
          flex: 0 0 auto;
          display: flex;
          gap: 10px;
          padding: 12px 20px 18px;
          border-top: 1px solid var(--hairline);
          background: rgba(10,10,14,0.25);
        }
        .actions button {
          flex: 1;
          padding: 14px;
          border: none;
          border-radius: 16px;
          font-size: 16px;
          font-weight: 600;
          cursor: pointer;
        }
        .cancel-btn { background: var(--glass-strong); color: #fff; }
        .save-btn {
          background: var(--accent);
          color: #fff;
          box-shadow: 0 6px 20px rgba(128,0,255,0.45);
        }
        .save-btn:disabled { background: rgba(255,255,255,0.15); box-shadow: none; cursor: not-allowed; }
      </style>

      <div class="backdrop" id="backdrop"></div>
      <div class="sheet" role="dialog" aria-label="Edit track">
        <div class="flipper">
          <div class="face front">
            <div class="shade"></div>
            <div class="sheet-scroll">
              <div class="content">
                <div class="head">
                  <div class="cover" id="cover"></div>
                  <div class="names">
                    <input type="text" class="name-input title-input" id="title-input" placeholder="Track name" aria-label="Name">
                    <input type="text" class="name-input artist-input" id="artist-input" placeholder="Artist" aria-label="Artist">
                  </div>
                  <button class="flip-btn" aria-label="Playlists">${FLIP_ICON}</button>
                </div>

                <div class="section-label">Clip</div>
                <div class="card" id="clip"></div>

                <div class="section-label">Track</div>
                <div class="card list">
                  ${canShowRelated ? `<button class="row" id="related-btn"><span class="icon">${uiIcon('related-tracks')}</span><span>Show related</span></button>` : ''}
                  <button class="row" id="redownload-btn" ${!canSave ? 'disabled' : ''}>
                    <span class="icon">${uiIcon('re-download')}</span>
                    <span><span class="label">Re-download file</span><span class="sub">Re-fetch the audio if the wrong file got attached</span></span>
                  </button>
                  <button class="row danger" id="delete-btn" ${!canSave ? 'disabled' : ''}><span class="icon">${uiIcon('delete')}</span><span>Delete track</span></button>
                </div>
              </div>
            </div>
            <div class="actions">
              <button class="cancel-btn" id="cancel-btn">Cancel</button>
              <button class="save-btn" id="save-btn" ${!canSave ? 'disabled' : ''}>Save</button>
            </div>
          </div>

          <div class="face back">
            <div class="shade"></div>
            <div class="back-head">
              <div class="cover"></div>
              <div class="back-titles">
                <div class="back-title">Playlists</div>
                <div class="back-sub" id="back-sub"></div>
              </div>
              <button class="flip-btn" aria-label="Back to track">${FLIP_ICON}</button>
            </div>
            <div class="back-scroll" id="playlists"></div>
            <div class="actions">
              <button class="save-btn" id="done-btn">Done</button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Values set as properties, not interpolated, so quotes/markup in names are inert.
    this.shadowRoot.getElementById('title-input').value = song.title ?? '';
    this.shadowRoot.getElementById('artist-input').value = song.artist ?? '';
    if (song.cover) {
      const url = `url("${String(song.cover).replace(/"/g, '%22')}")`;
      this.shadowRoot.querySelectorAll('.cover').forEach((el) => { el.style.backgroundImage = url; });
    }
    this.shadowRoot.getElementById('back-sub').textContent =
      [song.title, song.artist].filter(Boolean).join(' — ');

    this.attachEventListeners();
    this.renderClip();
    this.renderPlaylists();
  }

  /** Render the clip card (slider + start/end controls) for the current duration state. */
  renderClip() {
    const clip = this.shadowRoot.getElementById('clip');
    if (!clip) return;

    if (this.isLoadingDuration) {
      clip.innerHTML = '<p class="loading">Loading duration…</p>';
      return;
    }

    clip.innerHTML = `
      <div class="range-track" id="range-track">
        <div class="range-bar"></div>
        <div class="range-fill" id="range-fill"></div>
        <div class="range-thumb" id="thumb-start" data-thumb="start"></div>
        <div class="range-thumb" id="thumb-end" data-thumb="end"></div>
      </div>
      <div class="range-ends"><span>0:00</span><span>${this.formatTime(this.duration)}</span></div>
      <p class="precision-hint">Drag a handle — move further above or below the bar for finer control.</p>
      ${this.timeControlHtml('start', 'Start', `${uiIcon('play-preview')} First ${PREVIEW_SECONDS}s`)}
      ${this.timeControlHtml('end', 'End', `${uiIcon('play-preview')} Last ${PREVIEW_SECONDS}s`)}
      <p class="units-hint">±10 / ±100 are milliseconds · m:ss.mmm</p>
    `;

    this.attachClipListeners();
    this.updateSliderPositions();
    this.updatePreviewButtons();
  }

  /**
   * Markup for one cutoff's controls: title, preview pill and ± nudges around the field.
   * @param {'start'|'end'} which
   * @param {string} title
   * @param {string} previewLabel
   * @returns {string}
   */
  timeControlHtml(which, title, previewLabel) {
    const adj = (delta, label) => `<button class="adj-btn" data-adjust="${which}" data-delta="${delta}">${label}</button>`;
    return `
      <div class="time-control">
        <div class="time-control-head">
          <span class="time-control-title">${title}</span>
          <button class="preview-btn" id="preview-${which}" data-preview="${which}">${previewLabel}</button>
        </div>
        <div class="time-row">
          ${adj(-1000, '−1s')}${adj(-100, '−100')}${adj(-10, '−10')}
          <input type="text" class="time-input" id="${which}-input" inputmode="decimal">
          ${adj(10, '+10')}${adj(100, '+100')}${adj(1000, '+1s')}
        </div>
      </div>
    `;
  }

  attachEventListeners() {
    const $ = (id) => this.shadowRoot.getElementById(id);

    $('title-input').addEventListener('input', (e) => { this.song = { ...this.song, title: e.target.value }; });
    $('artist-input').addEventListener('input', (e) => { this.song = { ...this.song, artist: e.target.value }; });
    [$('title-input'), $('artist-input')].forEach((field) => {
      field.addEventListener('keydown', (e) => { if (e.key === 'Enter') field.blur(); });
    });

    $('cancel-btn').addEventListener('click', () => this.close());
    $('done-btn').addEventListener('click', () => this.close());
    this.shadowRoot.querySelectorAll('.flip-btn').forEach((btn) => btn.addEventListener('click', () => this.flip()));
    $('playlists').addEventListener('click', (e) => {
      const row = e.target.closest('[data-playlist]');
      if (row) this.togglePlaylist(Number(row.dataset.playlist));
    });
    $('backdrop').addEventListener('click', () => this.close());
    $('save-btn').addEventListener('click', () => this.save());
    $('delete-btn').addEventListener('click', () => this.delete());
    $('redownload-btn').addEventListener('click', () => this.redownload());
    $('related-btn')?.addEventListener('click', () => this.showRelated());

    // Swipes on the blurred backdrop mustn't scroll the page underneath.
    $('backdrop').addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  }

  /** Wire the clip card's controls (re-run whenever renderClip replaces them). */
  attachClipListeners() {
    // ± adjustment buttons (millisecond nudges)
    this.shadowRoot.querySelectorAll('.adj-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.adjustTime(btn.dataset.adjust, parseInt(btn.dataset.delta, 10));
      });
    });

    // Editable time fields — commit on blur or Enter.
    ['start', 'end'].forEach((which) => {
      const field = this.shadowRoot.getElementById(`${which}-input`);
      if (!field) return;
      field.addEventListener('change', () => this.commitTimeInput(which));
      field.addEventListener('keydown', (e) => { if (e.key === 'Enter') field.blur(); });
    });

    // Preview snippets (first/last few seconds relative to the chosen cutoffs).
    this.shadowRoot.querySelectorAll('.preview-btn').forEach((btn) => {
      btn.addEventListener('click', () => this.togglePreview(btn.dataset.preview));
    });

    ['start', 'end'].forEach((which) => {
      const thumb = this.shadowRoot.getElementById(`thumb-${which}`);
      if (!thumb) return;
      thumb.addEventListener('mousedown', (e) => this.handleSliderStart(e, which));
      thumb.addEventListener('touchstart', (e) => this.handleSliderStart(e, which), { passive: false });
    });
  }

  /**
   * Whether the song is in a playlist, counting a toggle that's still in flight.
   * @param {Object} playlist
   * @returns {boolean}
   */
  isMember(playlist) {
    if (this.pendingToggles.has(playlist.id)) return this.pendingToggles.get(playlist.id);
    return (playlist.songs || []).some((s) => String(s.id) === String(this.song?.id));
  }

  /** Render the back face: feeder playlists first, then the rest, each with a check. */
  renderPlaylists() {
    const box = this.shadowRoot.getElementById('playlists');
    if (!box) return;
    if (!this.isLibrarySong()) {
      box.innerHTML = '<p class="empty">Only library tracks can be added to playlists.</p>';
      return;
    }
    const playlists = (appState.get('playlists') || []).filter((p) => p.kind !== 'orphans');
    const feederIds = appState.get('playFeeders') || [];
    const feeders = playlists.filter((p) => feederIds.includes(p.id));
    const others = playlists.filter((p) => !feederIds.includes(p.id));

    const row = (p) => {
      const member = this.isMember(p);
      const count = (p.songs || []).length;
      const icon = p.icon
        ? `<span class="pl-icon" style="background-image: url(&quot;${esc(p.icon)}&quot;)"></span>`
        : `<span class="pl-icon">${NOTE_ICON}</span>`;
      return `
        <button class="row ${member ? 'member' : ''} ${this.pendingToggles.has(p.id) ? 'pending' : ''}"
                data-playlist="${p.id}" aria-pressed="${member}">
          ${icon}
          <span class="pl-text"><span class="pl-name">${esc(p.name)}</span><span class="sub">${count} track${count === 1 ? '' : 's'}</span></span>
          <span class="check">${CHECK_ICON}</span>
        </button>`;
    };
    const section = (label, list) => list.length
      ? `<div class="section-label">${label}</div><div class="card list">${list.map(row).join('')}</div>`
      : '';

    // Keep the scroll position across re-renders (they happen on every toggle).
    const scroll = box.scrollTop;
    box.innerHTML = playlists.length
      ? section('Feeders', feeders) + section(feeders.length ? 'Other playlists' : 'Playlists', others)
      : '<p class="empty">No playlists yet.</p>';
    box.scrollTop = scroll;
  }

  /**
   * Add the song to, or remove it from, a playlist. Shown optimistically; the app does
   * the work (see MusicApp.togglePlaylistMembership) and reports success via detail.result.
   * @param {number} playlistId
   */
  async togglePlaylist(playlistId) {
    const playlist = (appState.get('playlists') || []).find((p) => p.id === playlistId);
    if (!playlist || this.pendingToggles.has(playlistId)) return;
    const add = !this.isMember(playlist);
    this.pendingToggles.set(playlistId, add);
    this.renderPlaylists();

    const s = this.song;
    const detail = {
      playlistId,
      add,
      song: { id: s.id, title: s.title, artist: s.artist, cover: s.cover, source: s.source,
              url: s.url, start_time: s.start_time ?? null, end_time: s.end_time ?? null },
      result: null
    };
    this.dispatchEvent(new CustomEvent('playlist-toggle', { detail, bubbles: true }));
    try {
      await detail.result;
    } finally {
      this.pendingToggles.delete(playlistId);
      this.renderPlaylists();
    }
  }

  /**
   * Spin the card over to the other side. Always turns the same way (front→back is
   * 0→180°, back→front 180→360°), dipping back in depth mid-turn, with each face
   * shaded as it goes edge-on.
   */
  flip() {
    if (this.flipping || this.closing) return;
    this.flipping = true;
    this.shadowRoot.activeElement?.blur();

    const sheet = this.shadowRoot.querySelector('.sheet');
    const flipper = this.shadowRoot.querySelector('.flipper');
    const from = this.flipped ? 180 : 0;
    const to = from + 180;
    this.flipped = !this.flipped;
    sheet.classList.toggle('show-back', this.flipped);
    if (this.flipped) this.renderPlaylists();

    const timing = { duration: FLIP_MS, easing: 'cubic-bezier(0.55, 0.05, 0.3, 1)' };
    const anim = flipper.animate([
      { transform: `rotateY(${from}deg)` },
      { transform: `translateZ(-140px) rotateY(${from + 90}deg) scale(0.94)`, offset: 0.5 },
      { transform: `rotateY(${to}deg)` }
    ], timing);
    this.shadowRoot.querySelectorAll('.shade').forEach((shade) => shade.animate(
      [{ opacity: 0 }, { opacity: 1, offset: 0.5 }, { opacity: 0 }], timing
    ));

    anim.finished.catch(() => {}).then(() => {
      flipper.style.transform = this.flipped ? 'rotateY(180deg)' : '';
      this.flipping = false;
    });
  }

  /**
   * The origin's visible box, in viewport px, or null when there's none to grow from.
   * @returns {{top:number,left:number,right:number,bottom:number,radius:number}|null}
   */
  originBox() {
    const el = this.origin?.el;
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const inset = this.origin.inset || 0;
    return {
      top: r.top + inset, left: r.left + inset,
      right: r.right - inset, bottom: r.bottom - inset,
      radius: this.origin.radius ?? 20
    };
  }

  /**
   * clip-path that crops the sheet down to the origin's box.
   * @param {Object} box - From originBox()
   * @returns {string}
   */
  originClip(box) {
    const s = this.shadowRoot.querySelector('.sheet').getBoundingClientRect();
    const t = box.top - s.top;
    const l = box.left - s.left;
    const r = s.right - box.right;
    const b = s.bottom - box.bottom;
    return `inset(${t}px ${r}px ${b}px ${l}px round ${box.radius}px)`;
  }

  /** @returns {Element[]} Each face's contents, faded in/out around the grow/shrink. */
  faceContents() {
    return [...this.shadowRoot.querySelectorAll('.content, .actions, .back-head, .back-scroll')];
  }

  /** Grow the sheet out of the origin (or fade/scale it in), blurring the page behind. */
  animateOpen() {
    const sheet = this.shadowRoot.querySelector('.sheet');
    const backdrop = this.shadowRoot.getElementById('backdrop');
    const opts = { duration: OPEN_MS, easing: EASE };

    backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS * 0.8, easing: 'ease-out' });

    const box = this.originBox();
    if (box) {
      this.origin.el.style.visibility = 'hidden';
      sheet.animate([
        { clipPath: this.originClip(box) },
        { clipPath: 'inset(0px 0px 0px 0px round 28px)' }
      ], opts);
    } else {
      sheet.animate([
        { opacity: 0, transform: 'scale(0.94)' },
        { opacity: 1, transform: 'none' }
      ], opts);
    }
    // Contents fade in once the sheet has mostly opened.
    this.faceContents().forEach((el) => el.animate(
      [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
      { duration: OPEN_MS * 0.7, delay: OPEN_MS * 0.3, easing: 'ease-out', fill: 'backwards' }
    ));
  }

  /** Reverse of animateOpen. Resolves when the sheet is gone. */
  animateClose() {
    const sheet = this.shadowRoot.querySelector('.sheet');
    const backdrop = this.shadowRoot.getElementById('backdrop');
    if (!sheet) return Promise.resolve();
    const opts = { duration: OPEN_MS * 0.8, easing: EASE, fill: 'forwards' };

    this.faceContents().forEach((el) => el.animate(
      [{ opacity: 1 }, { opacity: 0 }], { duration: OPEN_MS * 0.3, fill: 'forwards' }
    ));
    backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { ...opts, easing: 'ease-in' });

    const box = this.originBox();
    const anim = box
      ? sheet.animate([
          { clipPath: 'inset(0px 0px 0px 0px round 28px)' },
          { clipPath: this.originClip(box) }
        ], opts)
      : sheet.animate([
          { opacity: 1, transform: 'none' },
          { opacity: 0, transform: 'scale(0.94)' }
        ], opts);
    return anim.finished.catch(() => {});
  }

  /** Un-hide the origin element. */
  showOrigin() {
    if (this.origin?.el) this.origin.el.style.visibility = '';
  }

  updateSliderPositions() {
    if (!this.duration || this.duration <= 0) return;

    const track = this.shadowRoot.getElementById('range-track');
    const fill = this.shadowRoot.getElementById('range-fill');
    const thumbStart = this.shadowRoot.getElementById('thumb-start');
    const thumbEnd = this.shadowRoot.getElementById('thumb-end');

    if (!track || !fill || !thumbStart || !thumbEnd) return;

    const startPercent = (this.startTime / this.duration) * 100;
    const endPercent = (this.endTime / this.duration) * 100;

    thumbStart.style.left = `${startPercent}%`;
    thumbEnd.style.left = `${endPercent}%`;
    fill.style.left = `${startPercent}%`;
    fill.style.width = `${endPercent - startPercent}%`;

    this.updateTimeInputs();
  }

  /** Refresh the editable time fields, but never clobber the one being typed in. */
  updateTimeInputs() {
    const startField = this.shadowRoot.getElementById('start-input');
    const endField = this.shadowRoot.getElementById('end-input');
    const active = this.shadowRoot.activeElement;
    if (startField && startField !== active) startField.value = this.formatTimeMs(this.startTime);
    if (endField && endField !== active) endField.value = this.formatTimeMs(this.endTime);
  }

  /** Nudge a cutoff by a number of milliseconds, clamped to valid bounds. */
  adjustTime(which, deltaMs) {
    const d = deltaMs / 1000;
    if (which === 'start') {
      this.startTime = Math.max(0, Math.min(this.startTime + d, this.endTime - MIN_GAP));
    } else {
      this.endTime = Math.min(this.duration, Math.max(this.endTime + d, this.startTime + MIN_GAP));
    }
    this.updateSliderPositions();
  }

  /** Parse and apply the value typed into a time field, clamping to valid bounds. */
  commitTimeInput(which) {
    const field = this.shadowRoot.getElementById(`${which}-input`);
    if (!field) return;
    const parsed = this.parseTimeMs(field.value);
    if (parsed == null) {
      this.updateTimeInputs(); // revert to last good value
      return;
    }
    if (which === 'start') {
      this.startTime = Math.max(0, Math.min(parsed, this.endTime - MIN_GAP));
    } else {
      this.endTime = Math.min(this.duration, Math.max(parsed, this.startTime + MIN_GAP));
    }
    this.updateSliderPositions();
  }

  handleSliderStart(event, thumb) {
    event.preventDefault();
    this.draggingThumb = thumb;
    this.sliderRect = this.shadowRoot.getElementById('range-track').getBoundingClientRect();

    const isTouch = event.type.startsWith('touch');
    this.lastPointerX = isTouch ? event.touches[0].clientX : event.clientX;

    document.addEventListener('mousemove', this.boundMove);
    document.addEventListener('mouseup', this.boundEnd);
    document.addEventListener('touchmove', this.boundMove, { passive: false });
    document.addEventListener('touchend', this.boundEnd);
  }

  handleSliderMove(event) {
    if (!this.draggingThumb || !this.sliderRect || !this.duration) return;

    const isTouch = event.type.startsWith('touch');
    const clientX = isTouch ? event.touches[0].clientX : event.clientX;
    const clientY = isTouch ? event.touches[0].clientY : event.clientY;

    const sliderCenterY = this.sliderRect.top + this.sliderRect.height / 2;
    const distanceFromSlider = Math.abs(clientY - sliderCenterY);
    this.precisionFactor = 1 + distanceFromSlider * 0.02;

    const deltaX = clientX - this.lastPointerX;
    const effectiveDeltaX = deltaX / this.precisionFactor;

    const trackWidth = this.sliderRect.width;
    const secondsPerPixel = this.duration / trackWidth;
    const deltaSeconds = effectiveDeltaX * secondsPerPixel;

    if (this.draggingThumb === 'start') {
      let newStart = this.startTime + deltaSeconds;
      newStart = Math.max(0, Math.min(newStart, this.endTime - MIN_GAP));
      this.startTime = newStart;
    } else {
      let newEnd = this.endTime + deltaSeconds;
      newEnd = Math.min(this.duration, Math.max(newEnd, this.startTime + MIN_GAP));
      this.endTime = newEnd;
    }

    this.lastPointerX = clientX;
    this.updateSliderPositions();
    event.preventDefault();
  }

  handleSliderEnd() {
    this.draggingThumb = null;
    this.sliderRect = null;
    document.removeEventListener('mousemove', this.boundMove);
    document.removeEventListener('mouseup', this.boundEnd);
    document.removeEventListener('touchmove', this.boundMove);
    document.removeEventListener('touchend', this.boundEnd);
  }

  async save() {
    if (!this.song || !this.song.id) return;

    const titleInput = this.shadowRoot.getElementById('title-input');
    const artistInput = this.shadowRoot.getElementById('artist-input');
    const title = titleInput ? titleInput.value.trim() : this.song.title;
    const artist = artistInput ? artistInput.value.trim() : this.song.artist;

    const songId = typeof this.song.id === 'string' ? parseInt(this.song.id, 10) : this.song.id;

    try {
      const updates = {
        title: title || 'Unknown',
        artist: artist || 'Unknown',
        start_time: this.startTime,
        end_time: this.endTime
      };
      await updateSong(songId, updates);

      this.dispatchEvent(new CustomEvent('saved', {
        detail: {
          song: {
            ...this.song,
            ...updates
          }
        },
        bubbles: true
      }));

      this.close();
    } catch (err) {
      console.error('Failed to save track:', err);
      alert('Failed to save: ' + (err.message || 'Unknown error'));
    }
  }

  async delete() {
    if (!this.song || !this.song.id) return;

    const songTitle = this.song.title || 'this song';
    if (!confirm(`Delete "${songTitle}"? This cannot be undone.`)) return;

    const songId = typeof this.song.id === 'string' ? parseInt(this.song.id, 10) : this.song.id;

    try {
      await deleteSong(songId);

      this.dispatchEvent(new CustomEvent('deleted', {
        detail: { songId },
        bubbles: true
      }));

      this.close();
    } catch (err) {
      console.error('Failed to delete track:', err);
      alert('Failed to delete: ' + (err.message || 'Unknown error'));
    }
  }

  async redownload() {
    if (!this.song || !this.song.id) return;

    const songId = typeof this.song.id === 'string' ? parseInt(this.song.id, 10) : this.song.id;
    const btn = this.shadowRoot.getElementById('redownload-btn');
    const label = btn?.querySelector('.label');

    if (btn) {
      btn.disabled = true;
      label.textContent = 'Queuing…';
    }

    try {
      await redownloadSong(songId);

      this.dispatchEvent(new CustomEvent('redownload', {
        detail: { songId },
        bubbles: true
      }));

      this.close();
    } catch (err) {
      console.error('Failed to re-download track:', err);
      alert('Failed to re-download: ' + (err.message || 'Unknown error'));
      if (btn) {
        btn.disabled = false;
        label.textContent = 'Re-download file';
      }
    }
  }

  /** Hand the song to the app to list related tracks in the Discover tab. */
  showRelated() {
    this.dispatchEvent(new CustomEvent('show-related', {
      detail: { song: this.song },
      bubbles: true
    }));
    this.close();
  }

  /** Play, or stop, a short snippet at the chosen start or end cutoff. */
  togglePreview(which) {
    if (this.previewWhich === which) {
      this.stopPreview();
    } else {
      this.startPreview(which);
    }
  }

  startPreview(which) {
    if (!this.song || !this.song.url) return;

    // Pause the main app's playback so the two don't overlap.
    if (appState.get('isPlaying')) {
      this.dispatchEvent(new CustomEvent('toggle-play-pause', { bubbles: true, composed: true }));
    }

    this.stopPreview();

    // "Start" plays the first few seconds from the start cutoff; "End" plays the
    // last few seconds up to the end cutoff — so the user hears how each edge sounds.
    let from, to;
    if (which === 'start') {
      from = this.startTime;
      to = Math.min(this.startTime + PREVIEW_SECONDS, this.endTime);
    } else {
      from = Math.max(this.endTime - PREVIEW_SECONDS, this.startTime);
      to = this.endTime;
    }

    const audio = new Audio();
    audio.src = this.song.url.startsWith('/') ? window.location.origin + this.song.url : this.song.url;
    this.previewAudio = audio;
    this.previewWhich = which;

    const stopAt = () => { if (audio.currentTime >= to) this.stopPreview(); };
    audio.addEventListener('timeupdate', stopAt);
    audio.addEventListener('ended', () => this.stopPreview());
    audio.addEventListener('loadedmetadata', () => {
      audio.currentTime = from;
      audio.play().catch(() => this.stopPreview());
      // Backstop in case timeupdate granularity overshoots the snippet end.
      this.previewTimer = setTimeout(() => this.stopPreview(), Math.max(0, (to - from)) * 1000 + 250);
    });

    this.updatePreviewButtons();
  }

  stopPreview() {
    if (this.previewTimer) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    if (this.previewAudio) {
      this.previewAudio.pause();
      this.previewAudio.src = '';
      this.previewAudio = null;
    }
    this.previewWhich = null;
    this.updatePreviewButtons();
  }

  updatePreviewButtons() {
    const startBtn = this.shadowRoot.getElementById('preview-start');
    const endBtn = this.shadowRoot.getElementById('preview-end');
    if (startBtn) {
      const on = this.previewWhich === 'start';
      startBtn.classList.toggle('playing', on);
      startBtn.innerHTML = on ? `${uiIcon('stop-preview')} Stop` : `${uiIcon('play-preview')} First ${PREVIEW_SECONDS}s`;
    }
    if (endBtn) {
      const on = this.previewWhich === 'end';
      endBtn.classList.toggle('playing', on);
      endBtn.innerHTML = on ? `${uiIcon('stop-preview')} Stop` : `${uiIcon('play-preview')} Last ${PREVIEW_SECONDS}s`;
    }
  }

  /** Shrink back into the origin (or fade out), then remove. */
  async close() {
    if (this.closing) return;
    this.closing = true;
    this.stopPreview();
    this.handleSliderEnd();
    this.style.pointerEvents = 'none';
    this.dispatchEvent(new CustomEvent('close', { bubbles: true }));
    await this.animateClose();
    this.remove();
  }
}

customElements.define('track-editor', TrackEditor);
