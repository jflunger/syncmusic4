/**
 * Track editor modal - Edit song name, artist, start and end times.
 * Usage: <track-editor song="..."></track-editor>
 * Emits: 'close' when dismissed, 'saved' when save succeeds, 'deleted' when deleted,
 *        'redownload' when a re-download is queued (detail: { songId })
 */

import { updateSong, deleteSong, redownloadSong } from '../services/api.js';
import appState from '../state/appState.js';

const MIN_GAP = 0.1;       // minimum seconds between start and end
const PREVIEW_SECONDS = 3; // length of the start/end preview snippets

class TrackEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    this.song = null;
    this.duration = 0;
    this.startTime = 0;
    this.endTime = 0;
    this.isLoadingDuration = true;

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
    if (name === 'song' && newVal) {
      try {
        this.song = typeof newVal === 'string' ? JSON.parse(newVal) : newVal;
        this.initFromSong();
      } catch (e) {
        this.song = null;
      }
    }
  }

  initFromSong() {
    if (!this.song) return;

    this.startTime = this.song.start_time ?? 0;
    this.endTime = this.song.end_time ?? null;
    this.isLoadingDuration = true;

    if (this.song.url) {
      const audio = new Audio();
      audio.addEventListener('loadedmetadata', () => {
        this.duration = audio.duration;
        if (this.endTime == null || this.endTime > this.duration) {
          this.endTime = this.duration;
        }
        if (this.startTime > this.endTime) {
          this.startTime = 0;
        }
        this.isLoadingDuration = false;
        this.render();
      });
      audio.addEventListener('error', () => {
        this.duration = 300; // Fallback 5 min
        this.isLoadingDuration = false;
        this.render();
      });
      audio.src = this.song.url.startsWith('/') ? window.location.origin + this.song.url : this.song.url;
    } else {
      this.duration = 300;
      this.isLoadingDuration = false;
      this.render();
    }
  }

  connectedCallback() {
    const songAttr = this.getAttribute('song');
    if (songAttr) {
      try {
        this.song = typeof songAttr === 'string' ? JSON.parse(songAttr) : songAttr;
        this.initFromSong();
      } catch (e) {
        this.song = null;
      }
    }
    this.render();
  }

  disconnectedCallback() {
    this.stopPreview();
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

  render() {
    const song = this.song || {};
    const canSave = song.id && (typeof song.id === 'number' || /^\d+$/.test(String(song.id)));
    const title = song.title ?? '';
    const artist = song.artist ?? '';

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          z-index: 1000;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .backdrop {
          position: absolute;
          inset: 0;
          background: rgba(0,0,0,0.7);
        }
        .modal {
          position: relative;
          z-index: 1;
          background: #2a2a2a;
          border-radius: 12px;
          padding: 24px;
          max-width: 400px;
          width: 90%;
          max-height: 90vh;
          overflow-y: auto;
          box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        }
        .modal h3 {
          margin: 0 0 20px 0;
          color: #fff;
        }
        .field {
          margin-bottom: 16px;
        }
        .field label {
          display: block;
          font-size: 12px;
          color: #aaa;
          margin-bottom: 4px;
        }
        .field input[type="text"] {
          -webkit-user-select: text;
          user-select: text;
          -webkit-touch-callout: default;
          width: 100%;
          padding: 10px 12px;
          background: #1a1a1a;
          border: 1px solid #444;
          border-radius: 8px;
          color: #fff;
          font-size: 16px;
          box-sizing: border-box;
        }
        .field input[type="text"]:focus {
          outline: none;
          border-color: #1db954;
        }
        .range-container {
          margin: 20px 0;
        }
        .range-track {
          position: relative;
          height: 24px;
          margin: 0 12px;
        }
        .range-bar {
          position: absolute;
          top: 50%;
          transform: translateY(-50%);
          height: 6px;
          background: #444;
          border-radius: 3px;
          left: 0;
          right: 0;
        }
        .range-fill {
          position: absolute;
          top: 50%;
          transform: translateY(-50%);
          height: 6px;
          background: #1db954;
          border-radius: 3px;
          pointer-events: none;
        }
        .range-thumb {
          position: absolute;
          top: 50%;
          transform: translate(-50%, -50%);
          width: 20px;
          height: 20px;
          background: #1db954;
          border-radius: 50%;
          cursor: grab;
          z-index: 2;
          touch-action: none;
        }
        .range-thumb:active {
          cursor: grabbing;
        }
        .range-labels {
          display: flex;
          justify-content: space-between;
          margin-top: 8px;
          font-size: 12px;
          color: #aaa;
        }
        .precision-hint {
          font-size: 11px;
          color: #888;
          margin: 10px 0 2px 0;
        }
        .time-control {
          margin-top: 12px;
        }
        .time-control-head {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 6px;
        }
        .time-control-title {
          font-size: 12px;
          color: #aaa;
        }
        .preview-btn {
          background: #1a1a1a;
          border: 1px solid #444;
          color: #1db954;
          border-radius: 6px;
          font-size: 12px;
          padding: 4px 10px;
          cursor: pointer;
          font-weight: 600;
        }
        .preview-btn.playing {
          background: #1db954;
          color: #fff;
          border-color: #1db954;
        }
        @media (hover: hover) {
          .preview-btn:hover {
            border-color: #1db954;
          }
        }
        .time-row {
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .adj-btn {
          flex: 0 0 auto;
          min-width: 34px;
          padding: 6px 0;
          background: #1a1a1a;
          border: 1px solid #444;
          color: #ddd;
          border-radius: 6px;
          font-size: 11px;
          cursor: pointer;
          font-weight: 600;
        }
        @media (hover: hover) {
          .adj-btn:hover {
            background: #333;
            border-color: #1db954;
          }
        }
        .time-input {
          flex: 1 1 auto;
          min-width: 0;
          text-align: center;
          padding: 6px 4px;
          background: #1a1a1a;
          border: 1px solid #444;
          border-radius: 6px;
          color: #fff;
          font-size: 14px;
          font-variant-numeric: tabular-nums;
          box-sizing: border-box;
        }
        .time-input:focus {
          outline: none;
          border-color: #1db954;
        }
        .units-hint {
          font-size: 10px;
          color: #777;
          text-align: right;
          margin: 4px 0 0 0;
        }
        .actions {
          display: flex;
          gap: 12px;
          margin-top: 24px;
        }
        .actions button {
          flex: 1;
          padding: 12px;
          border: none;
          border-radius: 8px;
          font-size: 16px;
          cursor: pointer;
          font-weight: 600;
        }
        .save-btn {
          background: #1db954;
          color: #fff;
        }
        @media (hover: hover) {
          .save-btn:hover {
            background: #1ed760;
          }
        }
        .save-btn:disabled {
          background: #555;
          cursor: not-allowed;
        }
        .cancel-btn {
          background: #444;
          color: #fff;
        }
        @media (hover: hover) {
          .cancel-btn:hover {
            background: #555;
          }
        }
        .delete-btn {
          flex: 0 0 auto;
          padding: 12px 16px;
          border: none;
          border-radius: 8px;
          font-size: 16px;
          cursor: pointer;
          font-weight: 600;
          background: #c0392b;
          color: #fff;
        }
        @media (hover: hover) {
          .delete-btn:hover {
            background: #e74c3c;
          }
        }
        .delete-btn:disabled {
          background: #555;
          cursor: not-allowed;
        }
        .loading {
          color: #aaa;
          font-size: 14px;
        }
        .redownload-btn {
          width: 100%;
          padding: 12px;
          border: 1px solid #444;
          border-radius: 8px;
          font-size: 15px;
          cursor: pointer;
          font-weight: 600;
          background: #1a1a1a;
          color: #ddd;
          margin-top: 4px;
        }
        @media (hover: hover) {
          .redownload-btn:hover:not(:disabled) {
            background: #333;
            border-color: #1db954;
          }
        }
        .redownload-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
        .redownload-hint {
          font-size: 11px;
          color: #888;
          margin: 6px 0 0 0;
          text-align: center;
        }
      </style>

      <div class="backdrop" id="backdrop"></div>
      <div class="modal">
        <h3>Edit Track</h3>

        <div class="field">
          <label>Name</label>
          <input type="text" id="title-input" value="${title.replace(/"/g, '&quot;')}" placeholder="Track name">
        </div>
        <div class="field">
          <label>Artist</label>
          <input type="text" id="artist-input" value="${artist.replace(/"/g, '&quot;')}" placeholder="Artist">
        </div>

        <div class="field range-container">
          <label>Start / End Time</label>
          ${this.isLoadingDuration
            ? '<p class="loading">Loading duration...</p>'
            : `
          <div class="range-track" id="range-track">
            <div class="range-bar"></div>
            <div class="range-fill" id="range-fill"></div>
            <div class="range-thumb" id="thumb-start" data-thumb="start"></div>
            <div class="range-thumb" id="thumb-end" data-thumb="end"></div>
          </div>
          <p class="precision-hint">Drag a handle — move further above or below the bar for finer (slower) control.</p>

          <div class="time-control">
            <div class="time-control-head">
              <span class="time-control-title">Start</span>
              <button class="preview-btn" id="preview-start" data-preview="start">▶ First ${PREVIEW_SECONDS}s</button>
            </div>
            <div class="time-row">
              <button class="adj-btn" data-adjust="start" data-delta="-1000">−1s</button>
              <button class="adj-btn" data-adjust="start" data-delta="-100">−100</button>
              <button class="adj-btn" data-adjust="start" data-delta="-10">−10</button>
              <input type="text" class="time-input" id="start-input" inputmode="decimal" value="${this.formatTimeMs(this.startTime)}">
              <button class="adj-btn" data-adjust="start" data-delta="10">+10</button>
              <button class="adj-btn" data-adjust="start" data-delta="100">+100</button>
              <button class="adj-btn" data-adjust="start" data-delta="1000">+1s</button>
            </div>
          </div>

          <div class="time-control">
            <div class="time-control-head">
              <span class="time-control-title">End</span>
              <button class="preview-btn" id="preview-end" data-preview="end">▶ Last ${PREVIEW_SECONDS}s</button>
            </div>
            <div class="time-row">
              <button class="adj-btn" data-adjust="end" data-delta="-1000">−1s</button>
              <button class="adj-btn" data-adjust="end" data-delta="-100">−100</button>
              <button class="adj-btn" data-adjust="end" data-delta="-10">−10</button>
              <input type="text" class="time-input" id="end-input" inputmode="decimal" value="${this.formatTimeMs(this.endTime)}">
              <button class="adj-btn" data-adjust="end" data-delta="10">+10</button>
              <button class="adj-btn" data-adjust="end" data-delta="100">+100</button>
              <button class="adj-btn" data-adjust="end" data-delta="1000">+1s</button>
            </div>
          </div>
          <p class="units-hint">±10 / ±100 are milliseconds · format m:ss.mmm</p>
          `
          }
        </div>

        <div class="field">
          <button class="redownload-btn" id="redownload-btn" ${!canSave ? 'disabled' : ''}>🔄 Re-download file</button>
          <p class="redownload-hint">Re-fetches the audio from the original source if the wrong file got attached.</p>
        </div>

        <div class="actions">
          <button class="delete-btn" id="delete-btn" ${!canSave ? 'disabled' : ''}>🗑</button>
          <button class="cancel-btn" id="cancel-btn">Cancel</button>
          <button class="save-btn" id="save-btn" ${!canSave ? 'disabled' : ''}>Save</button>
        </div>
      </div>
    `;

    this.attachEventListeners();
    if (!this.isLoadingDuration) {
      this.updateSliderPositions();
    }
  }

  attachEventListeners() {
    const titleInput = this.shadowRoot.getElementById('title-input');
    const artistInput = this.shadowRoot.getElementById('artist-input');
    const saveBtn = this.shadowRoot.getElementById('save-btn');
    const cancelBtn = this.shadowRoot.getElementById('cancel-btn');

    if (titleInput) {
      titleInput.addEventListener('input', (e) => { this.song = { ...this.song, title: e.target.value }; });
    }
    if (artistInput) {
      artistInput.addEventListener('input', (e) => { this.song = { ...this.song, artist: e.target.value }; });
    }
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => this.close());
    }

    const backdrop = this.shadowRoot.getElementById('backdrop');
    if (backdrop) {
      backdrop.addEventListener('click', () => this.close());
    }
    if (saveBtn) {
      saveBtn.addEventListener('click', () => this.save());
    }

    const deleteBtn = this.shadowRoot.getElementById('delete-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => this.delete());
    }

    const redownloadBtn = this.shadowRoot.getElementById('redownload-btn');
    if (redownloadBtn) {
      redownloadBtn.addEventListener('click', () => this.redownload());
    }

    // ± adjustment buttons (millisecond nudges)
    this.shadowRoot.querySelectorAll('.adj-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.adjustTime(btn.dataset.adjust, parseInt(btn.dataset.delta, 10));
      });
    });

    // Editable time fields — commit on blur or Enter.
    const startField = this.shadowRoot.getElementById('start-input');
    const endField = this.shadowRoot.getElementById('end-input');
    [startField, endField].forEach((field) => {
      if (!field) return;
      const which = field.id === 'start-input' ? 'start' : 'end';
      field.addEventListener('change', () => this.commitTimeInput(which));
      field.addEventListener('keydown', (e) => { if (e.key === 'Enter') field.blur(); });
    });

    // Preview snippets (first/last few seconds relative to the chosen cutoffs).
    this.shadowRoot.querySelectorAll('.preview-btn').forEach((btn) => {
      btn.addEventListener('click', () => this.togglePreview(btn.dataset.preview));
    });

    const thumbStart = this.shadowRoot.getElementById('thumb-start');
    const thumbEnd = this.shadowRoot.getElementById('thumb-end');
    if (thumbStart) {
      thumbStart.addEventListener('mousedown', (e) => this.handleSliderStart(e, 'start'));
      thumbStart.addEventListener('touchstart', (e) => this.handleSliderStart(e, 'start'), { passive: false });
    }
    if (thumbEnd) {
      thumbEnd.addEventListener('mousedown', (e) => this.handleSliderStart(e, 'end'));
      thumbEnd.addEventListener('touchstart', (e) => this.handleSliderStart(e, 'end'), { passive: false });
    }
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

    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Queuing...';
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
        btn.textContent = '🔄 Re-download file';
      }
    }
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
      startBtn.textContent = on ? `⏸ Stop` : `▶ First ${PREVIEW_SECONDS}s`;
    }
    if (endBtn) {
      const on = this.previewWhich === 'end';
      endBtn.classList.toggle('playing', on);
      endBtn.textContent = on ? `⏸ Stop` : `▶ Last ${PREVIEW_SECONDS}s`;
    }
  }

  close() {
    this.stopPreview();
    this.dispatchEvent(new CustomEvent('close', { bubbles: true }));
    this.remove();
  }
}

customElements.define('track-editor', TrackEditor);
