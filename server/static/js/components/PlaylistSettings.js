/**
 * Playlist settings overlay - Edit playlist info, manage feeder playlists,
 * trigger sync, and view sync progress.
 * Usage: const el = document.createElement('playlist-settings');
 *        el.setPlaylist(playlistObj);
 *        parentShadowRoot.appendChild(el);
 * Emits: 'playlist-updated', 'playlist-deleted', 'close'
 */

import appState from '../state/appState.js';
import {
  updatePlaylist, deletePlaylist, uploadPlaylistIcon, usePlaylistFeederIcon, removePlaylistIcon,
  fetchFeeders, addFeeder, removeFeeder, triggerSync, fetchSyncStatus,
  fetchPlaylists, fetchSongs
} from '../services/api.js';

class PlaylistSettings extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.playlist = null;
    this.feeders = [];
    this.syncItems = [];
    this.isSyncing = false;
    this.isAddingFeeder = false;
    this.unsubscribeSync = null;
  }

  setPlaylist(playlist) {
    this.playlist = { ...playlist };
    this.render();
    this.loadFeeders();
    this.loadSyncStatus();
    this.subscribeSyncUpdates();
  }

  connectedCallback() {
    if (this.playlist) {
      this.render();
      this.loadFeeders();
      this.loadSyncStatus();
      this.subscribeSyncUpdates();
    }
  }

  disconnectedCallback() {
    if (this.unsubscribeSync) {
      this.unsubscribeSync();
      this.unsubscribeSync = null;
    }
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
    if (!this.playlist) return;
    try {
      this.feeders = await fetchFeeders(this.playlist.id);
      this.renderFeeders();
    } catch (e) {
      console.error('Failed to load feeders:', e);
    }
  }

  async loadSyncStatus() {
    if (!this.playlist) return;
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

  render() {
    const p = this.playlist || {};
    const name = (p.name || '').replace(/"/g, '&quot;');
    const desc = (p.description || '').replace(/"/g, '&quot;');
    const iconUrl = (p.icon || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          position: absolute;
          top: 0; left: 0; right: 0; bottom: 0;
          z-index: 1000;
          display: flex;
          align-items: stretch;
          justify-content: center;
        }
        .backdrop {
          position: absolute;
          inset: 0;
          background: rgba(0,0,0,0.75);
        }
        .panel {
          position: relative;
          z-index: 1;
          background: #1a1a1a;
          width: 100%;
          max-width: 500px;
          height: 100%;
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
        }
        .header {
          display: flex;
          align-items: center;
          /* Top inset pushes the back button / title below the iOS notch & clock in the PWA,
             mirroring how the subtab navbars absorb safe-area-inset-top. */
          padding: calc(16px + env(safe-area-inset-top, 0px)) 20px 16px;
          position: sticky;
          top: 0;
          background: #1a1a1a;
          z-index: 10;
          border-bottom: 1px solid #333;
        }
        .back-btn {
          background: none;
          border: none;
          color: #fff;
          font-size: 24px;
          cursor: pointer;
          padding: 4px 12px 4px 0;
          line-height: 1;
        }
        .header h2 {
          margin: 0;
          font-size: 18px;
          color: #fff;
          flex: 1;
        }
        .body { padding: 0 20px 40px; }

        /* Sections */
        .section {
          margin-top: 24px;
        }
        .section-title {
          font-size: 13px;
          font-weight: 600;
          color: #888;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 12px;
        }

        /* Section 1: Playlist Info */
        .info-card {
          background: #2a2a2a;
          border-radius: 12px;
          padding: 20px;
        }
        .field { margin-bottom: 14px; }
        .field label {
          display: block;
          font-size: 12px;
          color: #aaa;
          margin-bottom: 4px;
        }
        .field input, .field textarea {
          -webkit-user-select: text;
          user-select: text;
          -webkit-touch-callout: default;
          width: 100%;
          padding: 10px 12px;
          background: #1a1a1a;
          border: 1px solid #444;
          border-radius: 8px;
          color: #fff;
          font-size: 15px;
          box-sizing: border-box;
          font-family: inherit;
        }
        .field textarea { resize: vertical; min-height: 60px; }
        .field input:focus, .field textarea:focus {
          outline: none;
          border-color: #1db954;
        }
        .icon-field {
          display: flex;
          align-items: center;
          gap: 16px;
          margin-bottom: 14px;
        }
        .icon-preview {
          width: 72px;
          height: 72px;
          border-radius: 12px;
          flex-shrink: 0;
          overflow: hidden;
          display: flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(145deg, #1db954 0%, #169c46 100%);
        }
        .icon-preview img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        .icon-preview .icon-placeholder {
          color: rgba(255,255,255,0.9);
        }
        .icon-preview .icon-placeholder svg {
          width: 36px;
          height: 36px;
        }
        .icon-actions {
          display: flex;
          flex-direction: column;
          gap: 8px;
          flex: 1;
        }
        .icon-btn {
          padding: 8px 14px;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          border: 1px solid #444;
          background: #1a1a1a;
          color: #fff;
        }
        @media (hover: hover) {
          .icon-btn:hover {
            background: #2a2a2a;
            border-color: #1db954;
            color: #1db954;
          }
        }
        .icon-btn.remove { color: #e74c3c; }
        @media (hover: hover) {
          .icon-btn.remove:hover { border-color: #e74c3c; color: #e74c3c; }
        }

        /* Feeder icon picker */
        .feeder-icon-picker {
          background: #1a1a1a;
          border: 1px solid #444;
          border-radius: 10px;
          padding: 12px;
          margin-top: 12px;
        }
        .feeder-icon-picker-title {
          font-size: 12px;
          color: #aaa;
          margin-bottom: 10px;
        }
        .feeder-icon-options {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
        }
        .feeder-icon-option {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
          width: 84px;
          padding: 6px;
          background: #2a2a2a;
          border: 1px solid #444;
          border-radius: 8px;
          color: #ccc;
          font-size: 11px;
          cursor: pointer;
        }
        @media (hover: hover) { .feeder-icon-option:hover { border-color: #1db954; color: #1db954; } }
        .feeder-icon-option img {
          width: 70px;
          height: 70px;
          border-radius: 6px;
          object-fit: cover;
          background: #333;
        }
        .feeder-icon-option span {
          width: 100%;
          text-align: center;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .feeder-icon-cancel {
          margin-top: 10px;
          padding: 6px 12px;
          background: #444;
          color: #fff;
          border: none;
          border-radius: 6px;
          font-size: 12px;
          cursor: pointer;
        }
        .info-actions {
          display: flex;
          gap: 10px;
          margin-top: 16px;
        }
        .save-info-btn {
          flex: 1;
          padding: 10px;
          background: #1db954;
          color: #fff;
          border: none;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
        }
        @media (hover: hover) { .save-info-btn:hover { background: #1ed760; } }
        .delete-playlist-btn {
          padding: 10px 16px;
          background: #c0392b;
          color: #fff;
          border: none;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
        }
        @media (hover: hover) { .delete-playlist-btn:hover { background: #e74c3c; } }

        /* Section 2: Feeders */
        .feeder-list { display: flex; flex-direction: column; gap: 10px; }
        .feeder-item {
          display: flex;
          align-items: center;
          gap: 12px;
          background: #2a2a2a;
          border-radius: 10px;
          padding: 10px 12px;
        }
        .feeder-thumb {
          width: 48px;
          height: 48px;
          border-radius: 6px;
          object-fit: cover;
          background: #333;
          flex-shrink: 0;
        }
        .feeder-info {
          flex: 1;
          min-width: 0;
        }
        .feeder-name {
          font-size: 14px;
          font-weight: 600;
          color: #fff;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .feeder-source {
          font-size: 11px;
          color: #888;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .feeder-remove {
          background: none;
          border: none;
          color: #666;
          font-size: 18px;
          cursor: pointer;
          padding: 4px 8px;
          flex-shrink: 0;
        }
        @media (hover: hover) { .feeder-remove:hover { color: #e74c3c; } }
        .add-feeder-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          width: 100%;
          padding: 12px;
          background: #2a2a2a;
          border: 2px dashed #444;
          border-radius: 10px;
          color: #888;
          font-size: 14px;
          cursor: pointer;
          margin-top: 10px;
        }
        @media (hover: hover) {
          .add-feeder-btn:hover {
            border-color: #1db954;
            color: #1db954;
          }
        }

        /* Add feeder form */
        .add-feeder-form {
          background: #2a2a2a;
          border-radius: 10px;
          padding: 14px;
          margin-top: 10px;
        }
        .add-feeder-form input {
          -webkit-user-select: text;
          user-select: text;
          -webkit-touch-callout: default;
          width: 100%;
          padding: 10px 12px;
          background: #1a1a1a;
          border: 1px solid #444;
          border-radius: 8px;
          color: #fff;
          font-size: 14px;
          box-sizing: border-box;
          margin-bottom: 10px;
        }
        .add-feeder-form input:focus {
          outline: none;
          border-color: #1db954;
        }
        .add-feeder-form-actions {
          display: flex;
          gap: 8px;
        }
        .add-feeder-form-actions button {
          flex: 1;
          padding: 8px;
          border: none;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        }
        .add-feeder-submit {
          background: #1db954;
          color: #fff;
        }
        @media (hover: hover) { .add-feeder-submit:hover { background: #1ed760; } }
        .add-feeder-submit:disabled { background: #555; cursor: not-allowed; }
        .add-feeder-cancel {
          background: #444;
          color: #fff;
        }
        .feeder-loading {
          color: #888;
          font-size: 13px;
          text-align: center;
          padding: 8px;
        }
        .feeder-error {
          color: #e74c3c;
          font-size: 13px;
          padding: 4px 0;
        }
        .empty-msg {
          color: #666;
          font-size: 13px;
          text-align: center;
          padding: 8px;
        }

        /* Section 3: Sync */
        .sync-btn {
          width: 100%;
          padding: 14px;
          background: #1db954;
          color: #fff;
          border: none;
          border-radius: 10px;
          font-size: 16px;
          font-weight: 700;
          cursor: pointer;
          letter-spacing: 0.3px;
        }
        @media (hover: hover) { .sync-btn:hover { background: #1ed760; } }
        .sync-btn:disabled {
          background: #555;
          cursor: not-allowed;
          color: #999;
        }

        /* Section 4: Sync Progress */
        .sync-list { display: flex; flex-direction: column; gap: 6px; }
        .sync-item {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 10px;
          background: #2a2a2a;
          border-radius: 8px;
        }
        .sync-item.downloaded { opacity: 0.5; }
        .sync-status-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .dot-pending { background: #f39c12; }
        .dot-downloading {
          background: #3498db;
          animation: pulse 1s ease-in-out infinite;
        }
        .dot-downloaded { background: #1db954; }
        .dot-error { background: #e74c3c; }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        .sync-item-info { flex: 1; min-width: 0; }
        .sync-item-title {
          font-size: 13px;
          color: #fff;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .sync-item-artist {
          font-size: 11px;
          color: #888;
        }
        .sync-item-status {
          font-size: 11px;
          color: #888;
          text-transform: capitalize;
          flex-shrink: 0;
        }
        .sync-summary {
          font-size: 13px;
          color: #888;
          margin-bottom: 8px;
        }
      </style>

      <div class="backdrop" id="backdrop"></div>
      <div class="panel">
        <div class="header">
          <button class="back-btn" id="back-btn">&larr;</button>
          <h2>Playlist Settings</h2>
        </div>
        <div class="body">
          <!-- Section 1: Info -->
          <div class="section">
            <div class="section-title">Playlist Info</div>
            <div class="info-card">
              <div class="field">
                <label>Playlist Icon</label>
                <div class="icon-field">
                  <div class="icon-preview" id="icon-preview">
                    ${iconUrl
                      ? `<img src="${iconUrl}" alt="">`
                      : `<span class="icon-placeholder"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></svg></span>`
                    }
                  </div>
                  <div class="icon-actions">
                    <input type="file" id="icon-input" accept="image/jpeg,image/png,image/webp,image/gif" style="display:none">
                    <button type="button" class="icon-btn" id="upload-icon-btn">Upload icon</button>
                    <button type="button" class="icon-btn" id="use-feeder-icon-btn" style="display:${this.feeders.some(f => f.thumbnail) ? 'block' : 'none'}">Use feeder icon</button>
                    ${iconUrl ? '<button type="button" class="icon-btn remove" id="remove-icon-btn">Remove icon</button>' : ''}
                  </div>
                </div>
                <div id="feeder-icon-picker-slot"></div>
              </div>
              <div class="field">
                <label>Name</label>
                <input type="text" id="name-input" value="${name}" placeholder="Playlist name">
              </div>
              <div class="field">
                <label>Description</label>
                <textarea id="desc-input" placeholder="Optional description">${p.description || ''}</textarea>
              </div>
              <div class="info-actions">
                <button class="save-info-btn" id="save-info-btn">Save Changes</button>
                <button class="delete-playlist-btn" id="delete-playlist-btn">Delete</button>
              </div>
            </div>
          </div>

          <!-- Section 2: Feeders -->
          <div class="section">
            <div class="section-title">Feeder Playlists</div>
            <div id="feeders-container">
              <div class="feeder-loading">Loading...</div>
            </div>
          </div>

          <!-- Section 3: Sync -->
          <div class="section">
            <div class="section-title">Sync</div>
            <div id="sync-button-container">
              <button class="sync-btn" id="sync-btn" disabled>Sync Now</button>
            </div>
          </div>

          <!-- Section 4: Sync Progress -->
          <div class="section" id="sync-progress-section" style="display:none">
            <div class="section-title">Sync Progress</div>
            <div id="sync-progress-container"></div>
          </div>
        </div>
      </div>
    `;

    this.attachEventListeners();
  }

  attachEventListeners() {
    this.shadowRoot.getElementById('backdrop').addEventListener('click', () => this.close());
    this.shadowRoot.getElementById('back-btn').addEventListener('click', () => this.close());

    this.shadowRoot.getElementById('save-info-btn').addEventListener('click', () => this.saveInfo());
    this.shadowRoot.getElementById('delete-playlist-btn').addEventListener('click', () => this.deletePlaylist());
    this.shadowRoot.getElementById('sync-btn').addEventListener('click', () => this.doSync());

    const uploadIconBtn = this.shadowRoot.getElementById('upload-icon-btn');
    const iconInput = this.shadowRoot.getElementById('icon-input');
    if (uploadIconBtn && iconInput) {
      uploadIconBtn.addEventListener('click', () => iconInput.click());
      iconInput.addEventListener('change', (e) => this.uploadIcon(e));
    }
    const useFeederIconBtn = this.shadowRoot.getElementById('use-feeder-icon-btn');
    if (useFeederIconBtn) {
      useFeederIconBtn.addEventListener('click', () => this.showFeederIconPicker());
    }
    const removeIconBtn = this.shadowRoot.getElementById('remove-icon-btn');
    if (removeIconBtn) {
      removeIconBtn.addEventListener('click', () => this.doRemoveIcon());
    }
  }

  async saveInfo() {
    if (!this.playlist) return;
    const nameInput = this.shadowRoot.getElementById('name-input');
    const descInput = this.shadowRoot.getElementById('desc-input');
    const name = nameInput.value.trim();
    const description = descInput.value.trim() || null;

    if (!name) { alert('Name cannot be empty'); return; }

    try {
      const updated = await updatePlaylist(this.playlist.id, { name, description });
      this.playlist.name = updated.name;
      this.playlist.description = updated.description;

      const playlists = await fetchPlaylists();
      appState.set('playlists', playlists);

      this.dispatchEvent(new CustomEvent('playlist-updated', {
        detail: { playlist: this.playlist },
        bubbles: true
      }));
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
      const playlists = await fetchPlaylists();
      appState.set('playlists', playlists);
      this.dispatchEvent(new CustomEvent('playlist-updated', {
        detail: { playlist: this.playlist },
        bubbles: true
      }));
      this.refreshAfterRender();
    } catch (err) {
      alert('Failed to upload icon: ' + err.message);
    }
  }

  /** Show a picker of feeder covers; selecting one stores it as the playlist icon. */
  showFeederIconPicker() {
    const slot = this.shadowRoot.getElementById('feeder-icon-picker-slot');
    if (!slot) return;
    const choices = this.feeders.filter(f => f.thumbnail);
    if (choices.length === 0) return;

    let html = '<div class="feeder-icon-picker">'
      + '<div class="feeder-icon-picker-title">Use a feeder cover as this playlist\'s icon</div>'
      + '<div class="feeder-icon-options">';
    for (const f of choices) {
      html += `
        <button type="button" class="feeder-icon-option" data-feeder-id="${f.id}" title="${this.escHtml(f.name || '')}">
          <img src="${f.thumbnail}" alt="">
          <span>${this.escHtml(f.name || 'Unknown')}</span>
        </button>`;
    }
    html += '</div><button type="button" class="feeder-icon-cancel" id="feeder-icon-cancel">Cancel</button></div>';
    slot.innerHTML = html;

    slot.querySelectorAll('.feeder-icon-option').forEach(btn => {
      btn.addEventListener('click', () => this.useFeederIcon(parseInt(btn.dataset.feederId)));
    });
    slot.querySelector('#feeder-icon-cancel').addEventListener('click', () => { slot.innerHTML = ''; });
  }

  async useFeederIcon(feederId) {
    if (!this.playlist) return;
    const slot = this.shadowRoot.getElementById('feeder-icon-picker-slot');
    try {
      const { icon } = await usePlaylistFeederIcon(this.playlist.id, feederId);
      this.playlist.icon = icon;
      const playlists = await fetchPlaylists();
      appState.set('playlists', playlists);
      this.dispatchEvent(new CustomEvent('playlist-updated', {
        detail: { playlist: this.playlist },
        bubbles: true
      }));
      this.refreshAfterRender();
    } catch (err) {
      if (slot) slot.innerHTML = `<div class="feeder-error">${this.escHtml(err.message)}</div>`;
      else alert('Failed to set icon: ' + err.message);
    }
  }

  /**
   * Re-render the whole panel, then restore the feeder & sync sections from
   * cached state (render() resets those to their loading/empty placeholders).
   */
  refreshAfterRender() {
    this.render();
    this.renderFeeders();
    this.renderSyncProgress();
  }

  async doRemoveIcon() {
    if (!this.playlist) return;
    try {
      await removePlaylistIcon(this.playlist.id);
      this.playlist.icon = null;
      const playlists = await fetchPlaylists();
      appState.set('playlists', playlists);
      this.dispatchEvent(new CustomEvent('playlist-updated', {
        detail: { playlist: this.playlist },
        bubbles: true
      }));
      this.refreshAfterRender();
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

  renderFeeders() {
    const container = this.shadowRoot.getElementById('feeders-container');
    if (!container) return;

    let html = '';
    if (this.feeders.length === 0) {
      html = '<div class="empty-msg">No feeder playlists yet</div>';
    } else {
      html = '<div class="feeder-list">';
      for (const f of this.feeders) {
        const thumb = f.thumbnail
          ? `<img class="feeder-thumb" src="${f.thumbnail}" alt="">`
          : `<div class="feeder-thumb"></div>`;
        html += `
          <div class="feeder-item" data-feeder-id="${f.id}">
            ${thumb}
            <div class="feeder-info">
              <div class="feeder-name">${this.escHtml(f.name || 'Unknown')}</div>
              <div class="feeder-source">${f.source}</div>
            </div>
            <button class="feeder-remove" data-feeder-id="${f.id}">&times;</button>
          </div>
        `;
      }
      html += '</div>';
    }
    html += `<button class="add-feeder-btn" id="add-feeder-btn">+ Add Feeder Playlist</button>`;
    html += `<div id="add-feeder-form-slot"></div>`;

    container.innerHTML = html;

    container.querySelectorAll('.feeder-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const feederId = parseInt(e.currentTarget.dataset.feederId);
        this.doRemoveFeeder(feederId);
      });
    });

    const addBtn = container.querySelector('#add-feeder-btn');
    if (addBtn) {
      addBtn.addEventListener('click', () => this.showAddFeederForm());
    }

    this.updateFeederIconButton();
    this.renderSyncButton();
  }

  /** Show the "Use feeder icon" button only when a feeder with a cover exists. */
  updateFeederIconButton() {
    const btn = this.shadowRoot.getElementById('use-feeder-icon-btn');
    if (!btn) return;
    btn.style.display = this.feeders.some(f => f.thumbnail) ? 'block' : 'none';
  }

  showAddFeederForm() {
    const slot = this.shadowRoot.getElementById('add-feeder-form-slot');
    if (!slot) return;

    slot.innerHTML = `
      <div class="add-feeder-form">
        <input type="text" id="feeder-url-input" placeholder="YouTube or SoundCloud playlist URL">
        <div id="feeder-form-error"></div>
        <div class="add-feeder-form-actions">
          <button class="add-feeder-cancel" id="feeder-cancel-btn">Cancel</button>
          <button class="add-feeder-submit" id="feeder-submit-btn">Add</button>
        </div>
      </div>
    `;

    const urlInput = slot.querySelector('#feeder-url-input');
    urlInput.focus();

    slot.querySelector('#feeder-cancel-btn').addEventListener('click', () => {
      slot.innerHTML = '';
    });

    slot.querySelector('#feeder-submit-btn').addEventListener('click', () => this.submitAddFeeder());

    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.submitAddFeeder();
    });
  }

  async submitAddFeeder() {
    if (this.isAddingFeeder || !this.playlist) return;

    const urlInput = this.shadowRoot.getElementById('feeder-url-input');
    const errorEl = this.shadowRoot.getElementById('feeder-form-error');
    const submitBtn = this.shadowRoot.getElementById('feeder-submit-btn');
    const url = urlInput ? urlInput.value.trim() : '';

    if (!url) {
      if (errorEl) errorEl.innerHTML = '<div class="feeder-error">Please enter a URL</div>';
      return;
    }

    this.isAddingFeeder = true;
    if (submitBtn) submitBtn.disabled = true;
    if (errorEl) errorEl.innerHTML = '<div class="feeder-loading">Validating playlist...</div>';

    try {
      const feeder = await addFeeder(this.playlist.id, url);
      this.feeders.push(feeder);
      this.renderFeeders();
    } catch (e) {
      if (errorEl) errorEl.innerHTML = `<div class="feeder-error">${this.escHtml(e.message)}</div>`;
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
    } catch (e) {
      alert('Failed to remove feeder: ' + e.message);
    }
  }

  renderSyncButton() {
    const btn = this.shadowRoot.getElementById('sync-btn');
    if (!btn) return;
    btn.disabled = this.feeders.length === 0 || this.isSyncing;
    btn.textContent = this.isSyncing ? 'Syncing...' : 'Sync Now';
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

  renderSyncProgress() {
    const section = this.shadowRoot.getElementById('sync-progress-section');
    const container = this.shadowRoot.getElementById('sync-progress-container');
    if (!section || !container) return;

    if (this.syncItems.length === 0) {
      section.style.display = 'none';
      return;
    }
    section.style.display = 'block';

    const downloaded = this.syncItems.filter(i => i.status === 'downloaded').length;
    const errors = this.syncItems.filter(i => i.status === 'error').length;
    const pending = this.syncItems.filter(i => i.status === 'pending' || i.status === 'downloading').length;

    // Show non-downloaded items first, then downloaded
    const active = this.syncItems.filter(i => i.status !== 'downloaded');
    const done = this.syncItems.filter(i => i.status === 'downloaded');
    const ordered = [...active, ...done];

    let html = `<div class="sync-summary">${downloaded}/${this.syncItems.length} downloaded`;
    if (errors) html += `, ${errors} failed`;
    if (pending) html += `, ${pending} in progress`;
    html += `</div>`;

    html += '<div class="sync-list">';
    for (const item of ordered) {
      const dotClass = `dot-${item.status}`;
      html += `
        <div class="sync-item ${item.status}">
          <div class="sync-status-dot ${dotClass}"></div>
          <div class="sync-item-info">
            <div class="sync-item-title">${this.escHtml(item.title || 'Unknown')}</div>
            <div class="sync-item-artist">${this.escHtml(item.artist || 'Unknown')}</div>
          </div>
          <div class="sync-item-status">${item.status}</div>
        </div>
      `;
    }
    html += '</div>';

    container.innerHTML = html;
  }

  escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  close() {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true }));
    this.remove();
  }
}

customElements.define('playlist-settings', PlaylistSettings);
