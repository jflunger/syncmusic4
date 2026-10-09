/**
 * Playlist settings - full-page frosted sheet, styled and animated like the track editor.
 * The front edits the playlist's icon, name and description (or deletes it); the button in
 * the corner spins the card over (3D flip) to its back: the feeder playlists, the sync
 * button and sync progress. Given an `origin` element, the sheet grows out of that
 * element's box and shrinks back into it on close (the element is hidden meanwhile).
 * Likes is filled automatically, so it has no back, no delete and a fixed icon.
 * Usage: const el = document.createElement('playlist-settings');
 *        el.setPlaylist(playlistObj);
 *        el.origin = { el, inset, radius, resolve }; // optional; resolve() re-finds el
 *                                                    // after the list re-renders
 *        parentShadowRoot.appendChild(el);
 * Emits: 'playlist-updated' (detail: { playlist }), 'playlist-deleted' (detail: { playlistId }),
 *        'close'
 */

import appState from '../state/appState.js';
import { icon as uiIcon } from '../icons.js';
import {
  updatePlaylist, deletePlaylist, uploadPlaylistIcon, usePlaylistFeederIcon, removePlaylistIcon,
  fetchFeeders, addFeeder, removeFeeder, triggerSync, fetchSyncStatus,
  fetchPlaylists, fetchSongs
} from '../services/api.js';

const OPEN_MS = 420;       // sheet grow / shrink duration
const EASE = 'cubic-bezier(0.2, 0.85, 0.25, 1)';
const FLIP_MS = 760;       // card flip duration

// Two arrows chasing round: "turn the card over".
const FLIP_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/>
  <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/></svg>`;
const LIST_ICON = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></svg>`;

/** Escape text for HTML. */
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

class PlaylistSettings extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.playlist = null;
    this.origin = null; // { el, inset, radius, resolve } the sheet grows out of, if any
    this.feeders = [];
    this.feedersLoaded = false;
    this.syncItems = [];
    this.isSyncing = false;
    this.isAddingFeeder = false;
    this.unsubscribeSync = null;
    this.closing = false;
    this.flipped = false;  // showing the feeders side
    this.flipping = false;
  }

  /** @param {Object} playlist */
  setPlaylist(playlist) {
    this.playlist = { ...playlist };
    if (this.isConnected) this.open();
  }

  connectedCallback() {
    if (this.playlist) this.open();
  }

  disconnectedCallback() {
    if (this.unsubscribeSync) {
      this.unsubscribeSync();
      this.unsubscribeSync = null;
    }
    this.showOrigin();
  }

  /** Render the sheet, load feeders and sync state, and grow it in. */
  open() {
    this.render();
    this.loadFeeders();
    this.loadSyncStatus();
    this.subscribeSyncUpdates();
    this.animateOpen();
  }

  /** True for the auto-filled Likes playlist (fixed heart icon; no feeders, sync or delete). */
  isAuto() {
    return this.playlist?.kind === 'orphans';
  }

  subscribeSyncUpdates() {
    if (this.unsubscribeSync) this.unsubscribeSync();
    this.unsubscribeSync = appState.subscribe((key, value) => {
      if (key === 'syncStatuses' && this.playlist) {
        const items = value[this.playlist.id];
        if (items) {
          for (const update of items) {
            const idx = this.syncItems.findIndex(i => i.download_link === update.download_link);
            if (idx >= 0) {
              this.syncItems[idx] = { ...this.syncItems[idx], ...update };
            }
          }
          this.renderSyncProgress();
        }
      }
    });
  }

  async loadFeeders() {
    if (!this.playlist || this.isAuto()) return;
    try {
      this.feeders = await fetchFeeders(this.playlist.id);
    } catch (e) {
      console.error('Failed to load feeders:', e);
    }
    this.feedersLoaded = true;
    this.renderFeeders();
    this.renderIcon();
  }

  async loadSyncStatus() {
    if (!this.playlist || this.isAuto()) return;
    try {
      // Load persisted per-track progress for display only. "Syncing" is NOT
      // derived from these — it's the transient act of enqueuing (see doSync),
      // so a half-finished sync from before a restart must not lock the button.
      this.syncItems = await fetchSyncStatus(this.playlist.id);
      this.renderSyncProgress();
      this.renderSyncButton();
    } catch (e) {
      console.error('Failed to load sync status:', e);
    }
  }

  /**
   * Render the sheet once. Later updates (icon, feeders, sync) re-render only their own
   * sections, so the open animation, flip side and typed text survive them.
   */
  render() {
    const p = this.playlist || {};
    const auto = this.isAuto();

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
        .sheet-scroll, .back-scroll {
          flex: 1 1 auto;
          overflow-y: auto;
          overscroll-behavior: contain;
          -webkit-overflow-scrolling: touch;
        }
        .sheet-scroll { padding: 22px 20px 12px; }
        .back-scroll { padding: 18px 20px 20px; }

        /* Header: icon + editable name/description, styled like the track editor's. */
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
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--muted);
        }
        .cover svg { width: 36px; height: 36px; }
        .cover.has-icon svg { display: none; }
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
          font-family: inherit;
          transition: background 150ms;
          text-overflow: ellipsis;
        }
        .name-input:focus { outline: none; background: var(--glass-strong); }
        .title-input { font-size: 22px; font-weight: 700; line-height: 30px; }
        .desc-input { font-size: 17px; line-height: 24px; color: rgba(255,255,255,0.75); }
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

        /* Back face header */
        .back-head {
          display: flex;
          gap: 14px;
          align-items: center;
          padding: 22px 20px 16px;
          border-bottom: 1px solid var(--hairline);
        }
        .back-head .cover { width: 52px; height: 52px; border-radius: 12px; }
        .back-head .cover svg { width: 26px; height: 26px; }
        .back-titles { flex: 1 1 auto; min-width: 0; }
        .back-title { font-size: 20px; font-weight: 700; line-height: 26px; }
        .back-sub {
          font-size: 13px;
          color: var(--muted);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

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
        .muted { color: var(--muted); font-size: 14px; margin: 0; }
        .error { color: var(--danger); font-size: 13px; margin: 8px 2px 0; }

        /* Action list: iOS-style grouped rows. */
        .list { padding: 0; overflow: hidden; }
        .list > .muted { padding: 15px 16px; }
        .row {
          display: flex;
          align-items: center;
          gap: 12px;
          width: 100%;
          box-sizing: border-box;
          padding: 15px 16px;
          background: none;
          border: none;
          color: #fff;
          font-size: 16px;
          text-align: left;
          cursor: pointer;
        }
        div.row { cursor: default; }
        .row + .row, .row + .add-form, .add-form + .row { border-top: 1px solid var(--hairline); }
        button.row:active:not(:disabled) { background: var(--glass); }
        .row:disabled { opacity: 0.4; cursor: not-allowed; }
        .row .icon { width: 22px; text-align: center; }
        .row .sub { display: block; font-size: 12px; color: var(--muted); margin-top: 2px; }
        .row.danger { color: var(--danger); }
        .row.accent { color: var(--accent-text); }
        @media (hover: hover) {
          button.row:hover:not(:disabled) { background: var(--glass-strong); }
          .flip-btn:hover { color: #fff; }
          .feeder-remove:hover { color: var(--danger); }
          .pick:hover { background: var(--glass-strong); }
        }

        /* Feeder covers to pick as the icon */
        .picker {
          display: flex;
          gap: 10px;
          overflow-x: auto;
          padding: 4px 16px 16px;
          -webkit-overflow-scrolling: touch;
        }
        .picker:empty { display: none; }
        .pick {
          flex: 0 0 auto;
          width: 84px;
          padding: 6px;
          border: none;
          border-radius: 14px;
          background: var(--glass);
          color: rgba(255,255,255,0.8);
          font-size: 11px;
          cursor: pointer;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .pick img { width: 72px; height: 72px; border-radius: 10px; object-fit: cover; }
        .pick span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

        /* Feeder rows */
        .thumb {
          flex: 0 0 auto;
          width: 40px;
          height: 40px;
          border-radius: 10px;
          object-fit: cover;
          background: var(--glass-strong);
        }
        .row-text { flex: 1 1 auto; min-width: 0; }
        .row-name { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .row-text .sub { text-transform: uppercase; letter-spacing: 0.05em; }
        .feeder-remove {
          flex: 0 0 auto;
          width: 30px;
          height: 30px;
          padding: 0;
          border: none;
          border-radius: 50%;
          background: var(--glass-strong);
          color: rgba(255,255,255,0.7);
          font-size: 18px;
          line-height: 1;
          cursor: pointer;
        }
        .add-form { padding: 14px 16px; }
        .url-input {
          -webkit-user-select: text;
          user-select: text;
          -webkit-touch-callout: default;
          width: 100%;
          box-sizing: border-box;
          padding: 10px 12px;
          background: rgba(0,0,0,0.28);
          border: 1px solid transparent;
          border-radius: 12px;
          color: #fff;
          font-size: 15px;
          font-family: inherit;
        }
        .url-input:focus { outline: none; border-color: var(--accent); }
        .form-actions { display: flex; gap: 8px; margin-top: 10px; }
        .pill {
          flex: 1;
          padding: 9px;
          border: none;
          border-radius: 999px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          background: var(--glass-strong);
          color: #fff;
        }
        .pill.primary { background: var(--accent); }
        .pill:disabled { opacity: 0.5; cursor: not-allowed; }

        /* Sync progress */
        .sync-summary { font-size: 13px; color: var(--muted); margin: 0 4px 10px; }
        .sync-row { padding: 11px 16px; cursor: default; }
        .sync-row.downloaded { opacity: 0.5; }
        .dot { flex: 0 0 auto; width: 10px; height: 10px; border-radius: 50%; }
        .dot-pending { background: #f39c12; }
        .dot-downloading { background: #3498db; animation: pulse 1s ease-in-out infinite; }
        .dot-downloaded { background: #1db954; }
        .dot-error { background: var(--danger); }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        .sync-row .row-name { font-size: 14px; }
        .sync-row .sub { text-transform: none; letter-spacing: 0; }
        .status { flex: 0 0 auto; font-size: 11px; color: var(--muted); text-transform: capitalize; }

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
      <div class="sheet" role="dialog" aria-label="Edit playlist">
        <div class="flipper">
          <div class="face front">
            <div class="shade"></div>
            <div class="sheet-scroll">
              <div class="content">
                <div class="head">
                  <div class="cover">${LIST_ICON}</div>
                  <div class="names">
                    <input type="text" class="name-input title-input" id="name-input" placeholder="Playlist name" aria-label="Name">
                    <input type="text" class="name-input desc-input" id="desc-input" placeholder="Add a description" aria-label="Description">
                  </div>
                  ${auto ? '' : `<button class="flip-btn" aria-label="Feeders and sync">${FLIP_ICON}</button>`}
                </div>

                ${auto ? '' : `
                <div class="section-label">Icon</div>
                <div class="card list" id="icon-card"></div>

                <div class="section-label">Playlist</div>
                <div class="card list">
                  <button class="row danger" id="delete-btn"><span class="icon">${uiIcon('delete')}</span><span>Delete playlist</span></button>
                </div>`}
              </div>
            </div>
            <div class="actions">
              <button class="cancel-btn" id="cancel-btn">Cancel</button>
              <button class="save-btn" id="save-btn">Save</button>
            </div>
          </div>

          ${auto ? '' : `
          <div class="face back">
            <div class="shade"></div>
            <div class="back-head">
              <div class="cover">${LIST_ICON}</div>
              <div class="back-titles">
                <div class="back-title">Feeders</div>
                <div class="back-sub" id="back-sub"></div>
              </div>
              <button class="flip-btn" aria-label="Back to playlist">${FLIP_ICON}</button>
            </div>
            <div class="back-scroll">
              <div class="section-label">Feeder playlists</div>
              <div class="card list" id="feeders"><p class="muted">Loading…</p></div>
              <div id="sync-progress"></div>
            </div>
            <div class="actions">
              <button class="cancel-btn" id="done-btn">Done</button>
              <button class="save-btn" id="sync-btn" disabled>Sync now</button>
            </div>
          </div>`}
        </div>
      </div>
    `;

    // Values set as properties, not interpolated, so quotes/markup in names are inert.
    this.shadowRoot.getElementById('name-input').value = p.name ?? '';
    this.shadowRoot.getElementById('desc-input').value = p.description ?? '';
    const sub = this.shadowRoot.getElementById('back-sub');
    if (sub) sub.textContent = p.name ?? '';

    this.attachEventListeners();
    this.renderIcon();
  }

  attachEventListeners() {
    const $ = (id) => this.shadowRoot.getElementById(id);

    [$('name-input'), $('desc-input')].forEach((field) => {
      field.addEventListener('keydown', (e) => { if (e.key === 'Enter') field.blur(); });
    });
    $('backdrop').addEventListener('click', () => this.close());
    $('cancel-btn').addEventListener('click', () => this.close());
    $('save-btn').addEventListener('click', () => this.saveInfo());
    $('delete-btn')?.addEventListener('click', () => this.deletePlaylist());
    $('done-btn')?.addEventListener('click', () => this.close());
    $('sync-btn')?.addEventListener('click', () => this.doSync());
    this.shadowRoot.querySelectorAll('.flip-btn').forEach((btn) => btn.addEventListener('click', () => this.flip()));

    // Icon card: rows and the feeder-cover picker are re-rendered, so delegate.
    $('icon-card').addEventListener('click', (e) => {
      const pick = e.target.closest('[data-pick]');
      if (pick) { this.useFeederIcon(Number(pick.dataset.pick)); return; }
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.id === 'upload-icon-btn') $('icon-input').click();
      if (btn.id === 'use-feeder-icon-btn') this.toggleFeederIconPicker();
      if (btn.id === 'remove-icon-btn') this.doRemoveIcon();
    });
    $('icon-card').addEventListener('change', (e) => {
      if (e.target.id === 'icon-input') this.uploadIcon(e);
    });

    // Feeders card: remove, add, and the add form.
    $('feeders')?.addEventListener('click', (e) => {
      const remove = e.target.closest('[data-remove]');
      if (remove) { this.doRemoveFeeder(Number(remove.dataset.remove)); return; }
      const btn = e.target.closest('button');
      if (btn?.id === 'add-feeder-btn') this.showAddFeederForm();
      if (btn?.id === 'feeder-cancel-btn') this.renderFeeders();
      if (btn?.id === 'feeder-submit-btn') this.submitAddFeeder();
    });

    // Swipes on the blurred backdrop mustn't scroll the page underneath.
    $('backdrop').addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  }

  /** Show the playlist's icon on both faces and refresh the icon card's rows. */
  renderIcon() {
    const icon = this.playlist?.icon;
    this.shadowRoot.querySelectorAll('.cover').forEach((el) => {
      el.style.backgroundImage = icon ? `url("${String(icon).replace(/"/g, '%22')}")` : '';
      el.classList.toggle('has-icon', !!icon);
    });

    const card = this.shadowRoot.getElementById('icon-card');
    if (!card) return;
    const hasFeederCovers = this.feeders.some(f => f.thumbnail);
    card.innerHTML = `
      <input type="file" id="icon-input" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
      <button class="row" id="upload-icon-btn"><span class="icon">${uiIcon('upload-icon')}</span><span>Upload icon</span></button>
      ${hasFeederCovers ? `<button class="row" id="use-feeder-icon-btn"><span class="icon">${uiIcon('feeder-cover')}</span>
        <span><span>Use a feeder cover</span><span class="sub">Pick one of the feeder playlists' covers</span></span></button>
        <div class="picker" id="picker"></div>` : ''}
      ${icon ? `<button class="row danger" id="remove-icon-btn"><span class="icon">${uiIcon('remove')}</span><span>Remove icon</span></button>` : ''}
    `;
  }

  /** Show (or hide) the row of feeder covers to choose the icon from. */
  toggleFeederIconPicker() {
    const picker = this.shadowRoot.getElementById('picker');
    if (!picker) return;
    if (picker.childElementCount) { picker.innerHTML = ''; return; }
    picker.innerHTML = this.feeders.filter(f => f.thumbnail).map(f => `
      <button class="pick" data-pick="${f.id}" title="${esc(f.name)}">
        <img src="${esc(f.thumbnail)}" alt=""><span>${esc(f.name || 'Unknown')}</span>
      </button>`).join('');
  }

  /** Refresh the app's playlists and tell listeners this one changed. */
  async publishUpdate() {
    const playlists = await fetchPlaylists();
    appState.set('playlists', playlists);
    this.dispatchEvent(new CustomEvent('playlist-updated', {
      detail: { playlist: this.playlist },
      bubbles: true
    }));
  }

  async saveInfo() {
    if (!this.playlist) return;
    const name = this.shadowRoot.getElementById('name-input').value.trim();
    const description = this.shadowRoot.getElementById('desc-input').value.trim() || null;

    if (!name) { alert('Name cannot be empty'); return; }

    try {
      const updated = await updatePlaylist(this.playlist.id, { name, description });
      this.playlist.name = updated.name;
      this.playlist.description = updated.description;
      await this.publishUpdate();
      this.close();
    } catch (e) {
      alert('Failed to save: ' + e.message);
    }
  }

  async uploadIcon(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !this.playlist) return;
    if (!file.type.startsWith('image/')) {
      alert('Please select an image file (JPEG, PNG, WebP, or GIF)');
      return;
    }
    try {
      const { icon } = await uploadPlaylistIcon(this.playlist.id, file);
      this.playlist.icon = icon;
      this.renderIcon();
      await this.publishUpdate();
    } catch (err) {
      alert('Failed to upload icon: ' + err.message);
    }
  }

  async useFeederIcon(feederId) {
    if (!this.playlist) return;
    try {
      const { icon } = await usePlaylistFeederIcon(this.playlist.id, feederId);
      this.playlist.icon = icon;
      this.renderIcon();
      await this.publishUpdate();
    } catch (err) {
      alert('Failed to set icon: ' + err.message);
    }
  }

  async doRemoveIcon() {
    if (!this.playlist) return;
    try {
      await removePlaylistIcon(this.playlist.id);
      this.playlist.icon = null;
      this.renderIcon();
      await this.publishUpdate();
    } catch (err) {
      alert('Failed to remove icon: ' + err.message);
    }
  }

  async deletePlaylist() {
    if (!this.playlist) return;
    if (!confirm(`Delete "${this.playlist.name}"? This cannot be undone.`)) return;

    try {
      await deletePlaylist(this.playlist.id);

      const playlists = await fetchPlaylists();
      appState.set('playlists', playlists);

      this.dispatchEvent(new CustomEvent('playlist-deleted', {
        detail: { playlistId: this.playlist.id },
        bubbles: true
      }));
      this.close();
    } catch (e) {
      alert('Failed to delete: ' + e.message);
    }
  }

  /** Render the feeder rows plus the "add" row on the back face. */
  renderFeeders() {
    const box = this.shadowRoot.getElementById('feeders');
    if (!box || !this.feedersLoaded) return;

    const rows = this.feeders.map(f => `
      <div class="row">
        ${f.thumbnail ? `<img class="thumb" src="${esc(f.thumbnail)}" alt="">` : '<span class="thumb"></span>'}
        <span class="row-text"><span class="row-name">${esc(f.name || 'Unknown')}</span><span class="sub">${esc(f.source)}</span></span>
        <button class="feeder-remove" data-remove="${f.id}" aria-label="Remove feeder">${uiIcon('remove')}</button>
      </div>`).join('');
    box.innerHTML = (rows || '<p class="muted">No feeder playlists yet</p>')
      + `<button class="row accent" id="add-feeder-btn"><span class="icon">${uiIcon('add')}</span><span>Add feeder playlist</span></button>`;

    this.renderSyncButton();
  }

  /** Swap the "add" row for a URL field. */
  showAddFeederForm() {
    const addBtn = this.shadowRoot.getElementById('add-feeder-btn');
    if (!addBtn) return;
    const form = document.createElement('div');
    form.className = 'add-form';
    form.innerHTML = `
      <input type="text" class="url-input" id="feeder-url-input" placeholder="YouTube or SoundCloud playlist URL" inputmode="url">
      <div id="feeder-form-error"></div>
      <div class="form-actions">
        <button class="pill" id="feeder-cancel-btn">Cancel</button>
        <button class="pill primary" id="feeder-submit-btn">Add</button>
      </div>`;
    addBtn.replaceWith(form);

    const urlInput = form.querySelector('#feeder-url-input');
    urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.submitAddFeeder(); });
    urlInput.focus();
  }

  async submitAddFeeder() {
    if (this.isAddingFeeder || !this.playlist) return;

    const urlInput = this.shadowRoot.getElementById('feeder-url-input');
    const errorEl = this.shadowRoot.getElementById('feeder-form-error');
    const submitBtn = this.shadowRoot.getElementById('feeder-submit-btn');
    const url = urlInput ? urlInput.value.trim() : '';

    if (!url) {
      if (errorEl) errorEl.innerHTML = '<p class="error">Please enter a URL</p>';
      return;
    }

    this.isAddingFeeder = true;
    if (submitBtn) submitBtn.disabled = true;
    if (errorEl) errorEl.innerHTML = '<p class="muted" style="margin-top:8px">Validating playlist…</p>';

    try {
      const feeder = await addFeeder(this.playlist.id, url);
      this.feeders.push(feeder);
      this.renderFeeders();
      this.renderIcon();
    } catch (e) {
      if (errorEl) errorEl.innerHTML = `<p class="error">${esc(e.message)}</p>`;
      if (submitBtn) submitBtn.disabled = false;
    } finally {
      this.isAddingFeeder = false;
    }
  }

  async doRemoveFeeder(feederId) {
    if (!this.playlist) return;
    try {
      await removeFeeder(this.playlist.id, feederId);
      this.feeders = this.feeders.filter(f => f.id !== feederId);
      this.renderFeeders();
      this.renderIcon();
    } catch (e) {
      alert('Failed to remove feeder: ' + e.message);
    }
  }

  renderSyncButton() {
    const btn = this.shadowRoot.getElementById('sync-btn');
    if (!btn) return;
    btn.disabled = this.feeders.length === 0 || this.isSyncing;
    btn.textContent = this.isSyncing ? 'Syncing…' : 'Sync now';
  }

  async doSync() {
    if (!this.playlist || this.isSyncing) return;
    this.isSyncing = true;
    this.renderSyncButton();

    try {
      const result = await triggerSync(this.playlist.id);
      this.syncItems = result.sync_items || [];
      this.renderSyncProgress();

      // Refresh playlists (some songs may have been auto-added)
      const playlists = await fetchPlaylists();
      appState.set('playlists', playlists);
      const songs = await fetchSongs();
      appState.set('songs', songs);
    } catch (e) {
      alert('Sync failed: ' + e.message);
    } finally {
      // Enqueuing is done the moment the request returns; re-enable the button.
      // Pressing it again is a no-op for anything already downloaded or queued.
      this.isSyncing = false;
      this.renderSyncButton();
    }
  }

  /** Render per-track sync progress (unfinished first) on the back face. */
  renderSyncProgress() {
    const box = this.shadowRoot.getElementById('sync-progress');
    if (!box) return;
    if (this.syncItems.length === 0) { box.innerHTML = ''; return; }

    const downloaded = this.syncItems.filter(i => i.status === 'downloaded').length;
    const errors = this.syncItems.filter(i => i.status === 'error').length;
    const pending = this.syncItems.filter(i => i.status === 'pending' || i.status === 'downloading').length;
    const ordered = [
      ...this.syncItems.filter(i => i.status !== 'downloaded'),
      ...this.syncItems.filter(i => i.status === 'downloaded')
    ];

    let summary = `${downloaded}/${this.syncItems.length} downloaded`;
    if (errors) summary += `, ${errors} failed`;
    if (pending) summary += `, ${pending} in progress`;

    // Keep the scroll position: progress re-renders on every status update.
    const scroller = box.closest('.back-scroll');
    const scroll = scroller.scrollTop;
    box.innerHTML = `
      <div class="section-label">Sync progress</div>
      <div class="sync-summary">${summary}</div>
      <div class="card list">
        ${ordered.map(item => `
          <div class="row sync-row ${esc(item.status)}">
            <span class="dot dot-${esc(item.status)}"></span>
            <span class="row-text"><span class="row-name">${esc(item.title || 'Unknown')}</span><span class="sub">${esc(item.artist || 'Unknown')}</span></span>
            <span class="status">${esc(item.status)}</span>
          </div>`).join('')}
      </div>`;
    scroller.scrollTop = scroll;
  }

  /**
   * Spin the card over to the other side. Always turns the same way (front→back is
   * 0→180°, back→front 180→360°), dipping back in depth mid-turn, with each face
   * shaded as it goes edge-on.
   */
  flip() {
    if (this.flipping || this.closing || this.isAuto()) return;
    this.flipping = true;
    this.shadowRoot.activeElement?.blur();

    const sheet = this.shadowRoot.querySelector('.sheet');
    const flipper = this.shadowRoot.querySelector('.flipper');
    const from = this.flipped ? 180 : 0;
    const to = from + 180;
    this.flipped = !this.flipped;
    sheet.classList.toggle('show-back', this.flipped);

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
   * The live origin element. Saving re-renders the playlist list, which replaces the
   * element we grew out of — re-find its successor (and hide it too) via origin.resolve.
   * @returns {Element|null}
   */
  originEl() {
    if (!this.origin) return null;
    if (!this.origin.el?.isConnected && this.origin.resolve) {
      const el = this.origin.resolve();
      if (el) {
        this.showOrigin();
        this.origin.el = el;
        el.style.visibility = 'hidden';
      }
    }
    return this.origin.el?.isConnected ? this.origin.el : null;
  }

  /**
   * The origin's visible box, in viewport px, or null when there's none to grow from.
   * @returns {{top:number,left:number,right:number,bottom:number,radius:number}|null}
   */
  originBox() {
    const el = this.originEl();
    if (!el) return null;
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

  /** Shrink back into the origin (or fade out), then remove. */
  async close() {
    if (this.closing) return;
    this.closing = true;
    this.style.pointerEvents = 'none';
    this.shadowRoot.activeElement?.blur();
    this.dispatchEvent(new CustomEvent('close', { bubbles: true }));
    await this.animateClose();
    this.remove();
  }
}

customElements.define('playlist-settings', PlaylistSettings);
