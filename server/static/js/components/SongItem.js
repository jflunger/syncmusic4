/**
 * Universal track item — used everywhere the app lists tracks (Curate tracks/working,
 * Play queue/history). Square cover that morphs into a "vinyl" (circle with a hole) while
 * the track is queued or playing. A queue indicator overlays the left half of the cover.
 *
 * Usage: <song-item data-song-id="12" data-song='{...}' title="…" artist="…" cover="…" source="spotify"></song-item>
 *
 * Interaction:
 *  - Tap the row            → enqueue (bubbles as 'enqueue-song' from the host tab).
 *    Repeated taps cycle enqueue → move-to-front → play, handled by MusicApp.enqueueSong.
 *  - Tap the queue indicator → remove from queue (emits 'remove-from-queue' { songId, index }).
 *  - Swipe right-to-left    → toggle membership of the working playlist
 *                             (emits 'add-to-playlist' or 'remove-from-playlist' { song }).
 *  - Long-press (library)   → edit (emits 'track-edit-request' { song }).
 *
 * Membership UI reads the working playlist from appState ('workingPlaylist'). A rotated
 * square of the playlist icon peeks in from the right as a triangle when the track is a
 * member; swiping reveals "add to / remove from <playlist>" and drags the triangle in/out.
 *
 * Attributes:
 *  - no-swipe : disable the membership swipe gesture (tap + queue indicator still work).
 *
 * Emits: 'enqueue-song' (via bubbling click), 'remove-from-queue', 'add-to-playlist',
 *        'remove-from-playlist', 'track-edit-request'.
 */

import appState from '../state/appState.js';

const MAX_SWIPE = 240;       // px the content can slide while swiping (wide enough to read the action text)
const SWIPE_THRESHOLD = 80;  // px past which a swipe toggles membership (same cutoff as before)
const TAB_REVEAL = 150;      // px of drag over which the playlist triangle fully peeks in
const DIR_LOCK = 8;          // px before we decide horizontal-vs-vertical intent

/**
 * The row's stylesheet is identical for every <song-item>, so build it ONCE and share it
 * across all shadow roots via adoptedStyleSheets. Previously each row inlined this whole
 * block as a <style> string, forcing the browser to re-parse ~5KB of CSS per row — the
 * dominant cost when mounting a long library list. render() now only writes the markup.
 */
const SONG_ITEM_STYLE = `
  :host {
    display: block;
    position: relative;
    width: 100%;
    overflow: hidden;
    border-bottom: 1px solid #0a0a0a;
    -webkit-user-select: none;
    user-select: none;
    /* Let the browser skip layout/paint for rows scrolled out of view. The intrinsic
       size keeps the scrollbar honest before a row is first rendered (56px cover +
       16px padding + 1px border ≈ 73px). */
    content-visibility: auto;
    contain-intrinsic-size: 0 73px;
  }
  /* touch-action is set inline in render() — it depends on the working playlist, not
     just the no-swipe attribute, so it can't be expressed as a static :host rule. */
  :host(:last-child) { border-bottom: none; }

  /* Revealed action panel (sits behind the sliding content) */
  .action-panel {
    position: absolute;
    inset: 0;
    z-index: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding-right: 72px;
    opacity: 0;
    transition: opacity 0.2s;
  }
  .action-panel.add { background: #1db954; }
  .action-panel.remove { background: #e53935; }
  .action-panel.visible { opacity: 1; }
  .action-text {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    line-height: 1.15;
    color: #fff;
    font-weight: 700;
    text-align: right;
  }
  .action-text span:first-child { font-size: 13px; opacity: 0.85; font-weight: 600; }
  .action-text span:last-child {
    font-size: 15px;
    max-width: 160px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Rotated playlist-icon triangle peeking from the right edge.
     Side = cover height / √2 so the rotated square's diagonal equals the cover height. */
  .pl-tab {
    position: absolute;
    top: 50%;
    right: 0;
    width: 39.6px;
    height: 39.6px;
    z-index: 3;
    pointer-events: none;
    border-radius: 0;
    overflow: hidden;
    transform-origin: center;
    transform: translate(100%, -50%) rotate(45deg);
    opacity: 0;
    box-shadow: -2px 0 8px rgba(0, 0, 0, 0.35);
    transition: transform 0.3s ease-out, opacity 0.25s;
  }
  .pl-tab.member { transform: translate(50%, -50%) rotate(45deg); opacity: 1; }
  .pl-tab.dragging { transition: none; }
  .pl-tab-inner {
    width: 100%;
    height: 100%;
  }
  .pl-tab-inner img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .pl-tab-inner .pl-default {
    width: 100%;
    height: 100%;
    background: linear-gradient(145deg, #1db954 0%, #169c46 100%);
    display: flex;
    align-items: center;
    justify-content: center;
    color: rgba(255, 255, 255, 0.9);
  }
  .pl-tab-inner .pl-default svg { width: 18px; height: 18px; }

  /* Sliding foreground */
  .content {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 10px;
    background: #000;
    transform: translateX(0);
    transition: background 0.2s, transform 0.3s ease-out;
  }
  .content.dragging { transition: background 0.2s; }
  @media (hover: hover) { :host(:hover) .content { background: #333; } }

  .cover-wrap {
    position: relative;
    width: 56px;
    height: 56px;
    flex-shrink: 0;
  }
  .cover {
    width: 100%;
    height: 100%;
    background: #444;
    border-radius: 0;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: border-radius 0.35s ease;
  }
  .cover img { width: 100%; height: 100%; object-fit: cover; }
  .cover .no-cover { color: #666; font-size: 24px; }
  .cover.vinyl {
    border-radius: 50%;
    -webkit-mask: radial-gradient(circle at 50% 50%, transparent 0 6px, #000 7px);
    mask: radial-gradient(circle at 50% 50%, transparent 0 6px, #000 7px);
  }
  /* Disc holds its angle while paused (animation frozen) and resumes when playing,
     mirroring the floating now-playing vinyl in MusicApp. */
  .cover.spinning { animation: vinyl-spin 4s linear infinite; animation-play-state: paused; }
  .cover.spinning.playing { animation-play-state: running; }
  @keyframes vinyl-spin { to { transform: rotate(360deg); } }

  /* Queue indicator — a wedge poking in from the track's left edge, mirroring the
     sloped "valley" of the centre nav tab: full-height at the left edge, its top
     and bottom edges sloping inward to a shorter right edge. Negative insets cancel
     the .content padding (8px 10px) so it reaches the actual track edges. */
  .queue-indicator {
    position: absolute;
    top: -8px;
    bottom: -8px;
    left: -10px;
    width: 42px;
    z-index: 3;
    display: flex;
    align-items: center;
    justify-content: center;
    /* The left edge bleeds 10px past the track edge (then clips); pad it back so the
       number / play glyph centres in the *visible* wedge, not the full box. */
    padding-left: 10px;
    box-sizing: border-box;
    /* Rounded-corner wedge in the box's fixed 42×88 space (cover 56 + padding 16,
       plus ±8 insets). Top/bottom edges slope gently inward (~17%) to a shorter
       right edge; r=8 corners. Mirrors the centre nav tab's sloped valley. */
    clip-path: path('M0,8 Q0,0 7.5,2.7 L34.5,12.3 Q42,15 42,23 L42,65 Q42,73 34.5,75.7 L7.5,85.3 Q0,88 0,80 Z');
    font-size: 13px;
    font-weight: 700;
    color: #fff;
  }
  .queue-indicator.playing { background: #1db954; }
  .queue-indicator.removable { background: #282828; cursor: pointer; }
  .queue-indicator.removable .q-remove { display: none; }
  @media (hover: hover) {
    .queue-indicator.removable:hover { background: #c0392b; }
    .queue-indicator.removable:hover .q-num { display: none; }
    .queue-indicator.removable:hover .q-remove { display: block; }
  }

  .details { flex: 1; min-width: 0; }
  .title {
    font-weight: 600;
    margin: 0 0 4px 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .artist {
    font-size: 14px;
    color: #aaa;
    margin: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .source-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .source-dot.soundcloud { background: #ff6b35; }
  .source-dot.youtube { background: #ff0000; }
  .source-dot.spotify { background: #1db954; }
`;

/* Build the shared sheet once. Modern engines (iOS 16.4+, all evergreen desktop)
   support constructable stylesheets; this app is self-hosted to such browsers. */
const songItemSheet = new CSSStyleSheet();
songItemSheet.replaceSync(SONG_ITEM_STYLE);

class SongItem extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    // Share the single prebuilt stylesheet instead of inlining a <style> per row.
    this.shadowRoot.adoptedStyleSheets = [songItemSheet];

    // Gesture state
    this.isDragging = false;   // pointer is down
    this.swiping = false;      // horizontal gesture locked in
    this.isSwipe = false;      // a swipe happened (suppresses the trailing click)
    this.startX = 0;
    this.startY = 0;
    this.currentX = 0;

    // Long-press state
    this.isLongPress = false;
    this.longPressTimer = null;
    this.longPressThreshold = 15;
    this.longPressDelay = 500;

    this.isToggling = false; // guard against double add/remove

    this._onMove = this.handleMove.bind(this);
    this._onEnd = this.handleEnd.bind(this);
  }

  static get observedAttributes() {
    return ['title', 'artist', 'cover', 'source', 'no-swipe'];
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }

  connectedCallback() {
    this.render();
    this.attachEvents();
    this.unsubscribeState = appState.subscribe((key) => {
      // Toggle the spin in place rather than re-rendering, so the disc freezes at its
      // current angle on pause and resumes from there (matches the floating vinyl).
      if (key === 'isPlaying') {
        this.syncPlayingClass();
        return;
      }
      // Queue changes fan out to every visible row on each enqueue, so patch just the
      // indicator + disc shape in place rather than rebuilding the whole row.
      if (key === 'queue') {
        if (!this.isDragging) this.syncQueueIndicator();
        return;
      }
      if (key === 'currentSong' || key === 'workingPlaylist' || key === 'playlists') {
        if (!this.isDragging) this.render();
      }
    });
  }

  disconnectedCallback() {
    if (this.unsubscribeState) this.unsubscribeState();
    document.removeEventListener('mousemove', this._onMove);
    document.removeEventListener('mouseup', this._onEnd);
  }

  /* ---------- data helpers ---------- */

  get songData() {
    try {
      return JSON.parse(this.getAttribute('data-song') || '{}');
    } catch {
      return {};
    }
  }

  get songId() {
    return this.getAttribute('data-song-id') || this.songData.id;
  }

  get workingPlaylist() {
    return appState.get('workingPlaylist') || null;
  }

  get isMember() {
    const wp = this.workingPlaylist;
    if (!wp || !Array.isArray(wp.songs)) return false;
    return wp.songs.some(s => String(s.id) === String(this.songId));
  }

  get membershipEnabled() {
    return !this.hasAttribute('no-swipe') && !!this.workingPlaylist;
  }

  /** True when this row's track is the one currently loaded in the player. */
  get isCurrentSong() {
    const cur = appState.get('currentSong');
    return this.songId != null && cur && String(cur.id) === String(this.songId);
  }

  /** Toggle the disc's running/paused spin in place (no re-render). */
  syncPlayingClass() {
    const cover = this.shadowRoot.querySelector('.cover');
    if (cover) cover.classList.toggle('playing', this.isCurrentSong && !!appState.get('isPlaying'));
  }

  /**
   * Patch the queue wedge + disc shape in place when the play queue changes, instead of
   * re-rendering the entire row. The "now playing" badge is owned by currentSong (full
   * render), so this only touches the removable queue indicator and the .vinyl class.
   */
  syncQueueIndicator() {
    const content = this.shadowRoot.querySelector('.content');
    if (!content) return;

    const isCurrent = this.isCurrentSong;
    const qIndex = this.queueIndex;
    const queued = qIndex >= 0;
    let indicator = content.querySelector('.queue-indicator');

    if (isCurrent) {
      // Current track's green badge is managed by render(); leave it untouched.
    } else if (queued) {
      // Reuse the existing wedge if present, else insert one before the cover.
      if (!indicator || !indicator.classList.contains('removable')) {
        if (indicator) indicator.remove();
        indicator = document.createElement('div');
        content.insertBefore(indicator, content.firstChild);
      }
      indicator.className = 'queue-indicator removable';
      indicator.title = 'Remove from queue';
      indicator.innerHTML = `<span class="q-num">${qIndex + 1}</span>
        <svg class="q-remove" viewBox="0 0 24 24" width="15" height="15" fill="#fff"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;
    } else if (indicator && indicator.classList.contains('removable')) {
      // No longer queued → drop the wedge.
      indicator.remove();
    }

    const cover = this.shadowRoot.querySelector('.cover');
    if (cover) cover.classList.toggle('vinyl', isCurrent || queued);
  }

  /** Index of this track in the play queue, or -1. */
  get queueIndex() {
    const id = this.songId;
    if (id == null) return -1;
    return (appState.get('queue') || []).findIndex(s => String(s.id) === String(id));
  }

  isLibrarySong() {
    const id = this.songData.id;
    return typeof id === 'number' || (typeof id === 'string' && /^\d+$/.test(id));
  }

  escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  /* ---------- render ---------- */

  render() {
    const title = this.getAttribute('title') || this.songData.title || 'Unknown';
    const artist = this.getAttribute('artist') || this.songData.artist || 'Unknown';
    const cover = this.getAttribute('cover') || this.songData.cover || '';
    const source = (this.getAttribute('source') || this.songData.source || 'unknown').toLowerCase();
    const sourceIcon = source === 'spotify' ? '🎵' : source === 'soundcloud' ? '🎧' : '📁';

    const currentSong = appState.get('currentSong');
    const isCurrent = this.songId != null && currentSong && String(currentSong.id) === String(this.songId);
    // Global transport state — the disc only spins while audio is actually playing.
    const playing = isCurrent && appState.get('isPlaying');
    const qIndex = this.queueIndex;
    const queued = qIndex >= 0;
    const isVinyl = isCurrent || queued;

    const wp = this.workingPlaylist;
    const member = this.isMember;
    const membershipUI = this.membershipEnabled;

    // Queue indicator overlay (left half of cover). Green play icon when playing,
    // grey position number (tap to remove) when queued.
    let indicatorHtml = '';
    if (isCurrent) {
      indicatorHtml = `<div class="queue-indicator playing" title="Now playing">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="#fff"><path d="M8 5v14l11-7z"/></svg>
      </div>`;
    } else if (queued) {
      indicatorHtml = `<div class="queue-indicator removable" title="Remove from queue">
        <span class="q-num">${qIndex + 1}</span>
        <svg class="q-remove" viewBox="0 0 24 24" width="15" height="15" fill="#fff"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </div>`;
    }

    // Playlist-membership triangle (rotated square of the working-playlist icon).
    let tabHtml = '';
    let panelHtml = '';
    if (membershipUI) {
      const tabInner = wp.icon
        ? `<img src="${this.escHtml(wp.icon)}" alt="">`
        : `<div class="pl-default"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></svg></div>`;
      tabHtml = `<div class="pl-tab"><div class="pl-tab-inner">${tabInner}</div></div>`;

      const verb = member ? 'remove from' : 'add to';
      panelHtml = `<div class="action-panel ${member ? 'remove' : 'add'}">
        <div class="action-text"><span>${this.escHtml(verb)}</span><span>${this.escHtml(wp.name || 'playlist')}</span></div>
      </div>`;
    }

    // touch-action depends on whether the membership swipe is live (needs a working
    // playlist), so it's set on the host inline rather than baked into the shared sheet.
    this.style.touchAction = membershipUI ? 'pan-y' : 'manipulation';

    this.shadowRoot.innerHTML = `
      ${panelHtml}
      ${tabHtml}
      <div class="content">
        ${indicatorHtml}
        <div class="cover-wrap">
          <div class="cover ${isVinyl ? 'vinyl' : ''} ${isCurrent ? 'spinning' : ''} ${playing ? 'playing' : ''}">
            ${cover ? `<img src="${this.escHtml(cover)}" alt="Cover">` : `<div class="no-cover">${sourceIcon}</div>`}
          </div>
        </div>
        <div class="details">
          <h4 class="title">${this.escHtml(title)}</h4>
          <p class="artist"><span class="source-dot ${source}"></span>${this.escHtml(artist)}</p>
        </div>
      </div>
    `;

    // Apply the triangle's resting state (member peeks in, non-member hidden off-right).
    const tab = this.shadowRoot.querySelector('.pl-tab');
    if (tab && member) tab.classList.add('member');
  }

  /* ---------- events ---------- */

  attachEvents() {
    this.addEventListener('touchstart', this.handleStart.bind(this), { passive: true });
    this.addEventListener('touchmove', this._onMove, { passive: false });
    this.addEventListener('touchend', this._onEnd, { passive: true });
    // When the browser takes over the gesture for native scrolling it fires touchcancel
    // (and stops sending touchmove), so the long-press timer would otherwise survive and
    // fire mid-scroll. Treat it like an end: kill the timer and reset.
    this.addEventListener('touchcancel', this._onEnd, { passive: true });

    // Mouse drag tracking is bound to the document only while a drag is in progress
    // (added in handleStart, removed in handleEnd). Registering it per-row up front meant
    // every library row kept two always-live document listeners that fired on every mouse
    // move — thousands of them at library scale. Touch listeners stay element-scoped.
    this.addEventListener('mousedown', this.handleStart.bind(this));

    this.shadowRoot.addEventListener('click', (event) => {
      if (this.isSwipe) {
        event.stopPropagation();
        return;
      }
      // Tap the spinning disc of the current track → toggle play/pause. The green
      // "now playing" badge overlays the disc's left side, so it counts as the disc too.
      if (this.isCurrentSong && event.target.closest('.cover-wrap, .queue-indicator.playing')) {
        event.stopPropagation();
        this.dispatchEvent(new CustomEvent('toggle-play-pause', { bubbles: true, composed: true }));
        return;
      }
      // Tap the queue indicator → remove from queue
      const indicator = event.target.closest('.queue-indicator.removable');
      if (indicator) {
        event.stopPropagation();
        // Send the id, not the displayed index — the handler resolves the track's actual
        // queue position at removal time so a stale index can't remove the wrong song.
        const index = this.queueIndex;
        if (index >= 0) {
          this.dispatchEvent(new CustomEvent('remove-from-queue', {
            detail: { songId: this.songId, index }, bubbles: true, composed: true
          }));
        }
        return;
      }
      // Otherwise let the click bubble to the host tab, which enqueues.
    });
  }

  cancelLongPress() {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  onLongPressFired() {
    this.longPressTimer = null;
    if (!this.isLibrarySong()) return;

    this.isDragging = false;
    this.swiping = false;
    this.isLongPress = true;
    this.resetPosition(true);

    const d = this.songData;
    const song = {
      id: d.id,
      title: this.getAttribute('title') || d.title || 'Unknown',
      artist: this.getAttribute('artist') || d.artist || 'Unknown',
      cover: this.getAttribute('cover') || d.cover || '',
      source: this.getAttribute('source') || d.source || 'unknown',
      url: d.url,
      start_time: d.start_time ?? null,
      end_time: d.end_time ?? null
    };

    this.dispatchEvent(new CustomEvent('track-edit-request', {
      detail: { song }, bubbles: true, composed: true
    }));

    setTimeout(() => { this.isLongPress = false; }, 0);
  }

  handleStart(event) {
    const point = event.type === 'touchstart' ? event.touches[0] : event;
    this.isDragging = true;
    this.swiping = false;
    this.isSwipe = false;
    this.startX = point.clientX;
    this.startY = point.clientY;
    this.currentX = point.clientX;

    // For a mouse drag the pointer can leave the row, so track it on the document — but
    // only for the duration of this drag (torn down in handleEnd). Touch uses the
    // element-scoped touchmove/touchend bound in attachEvents.
    if (event.type === 'mousedown') {
      document.addEventListener('mousemove', this._onMove);
      document.addEventListener('mouseup', this._onEnd);
    }

    this.cancelLongPress();
    this.longPressTimer = setTimeout(() => this.onLongPressFired(), this.longPressDelay);
  }

  handleMove(event) {
    if (!this.isDragging) return;
    const point = event.type === 'touchmove' ? event.touches[0] : event;
    this.currentX = point.clientX;
    const dx = this.startX - point.clientX; // positive → leftward
    const dy = point.clientY - this.startY;

    if (Math.hypot(dx, dy) > this.longPressThreshold) this.cancelLongPress();

    // Decide intent once: horizontal swipe vs vertical scroll
    if (!this.swiping) {
      if (!this.membershipEnabled) {
        // Any directional movement means this isn't a stationary long-press; cancel it
        // here (DIR_LOCK is smaller than longPressThreshold, so the check above can miss
        // it) before we stop tracking and let the browser scroll.
        if (Math.abs(dx) > DIR_LOCK || Math.abs(dy) > DIR_LOCK) {
          this.cancelLongPress();
          this.isDragging = false;
        }
        return;
      }
      if (Math.abs(dy) > DIR_LOCK && Math.abs(dy) > Math.abs(dx)) {
        this.cancelLongPress();
        this.isDragging = false; // vertical scroll — let the list scroll
        return;
      }
      if (Math.abs(dx) > DIR_LOCK) {
        this.swiping = true;
      } else {
        return;
      }
    }

    if (event.cancelable) event.preventDefault();

    const distance = Math.max(0, Math.min(dx, MAX_SWIPE)); // only reveal leftward
    this.isSwipe = distance > 5;

    const content = this.shadowRoot.querySelector('.content');
    const panel = this.shadowRoot.querySelector('.action-panel');
    const tab = this.shadowRoot.querySelector('.pl-tab');

    content.classList.add('dragging');
    content.style.transform = `translateX(-${distance}px)`;

    if (panel) panel.classList.toggle('visible', distance > 12);

    // Drag the triangle in from the right as you swipe to ADD (non-member).
    if (tab && !this.isMember) {
      tab.classList.add('dragging');
      const progress = Math.min(distance / TAB_REVEAL, 1); // 0 → 1
      const tx = 100 - 50 * progress;                       // 100% (hidden) → 50% (peek)
      tab.style.transform = `translate(${tx}%, -50%) rotate(45deg)`;
      tab.style.opacity = String(Math.min(progress * 1.5, 1));
    }
  }

  handleEnd() {
    this.cancelLongPress();
    // Tear down the per-drag document listeners (no-op for the touch path / if never
    // added). Done before the isDragging early-out so a long-press that cleared
    // isDragging can't leak them.
    document.removeEventListener('mousemove', this._onMove);
    document.removeEventListener('mouseup', this._onEnd);
    if (!this.isDragging) return;
    this.isDragging = false;

    const wasSwiping = this.swiping;
    this.swiping = false;

    const dx = this.startX - this.currentX;

    if (wasSwiping && this.membershipEnabled && dx >= SWIPE_THRESHOLD) {
      this.toggleMembership();
    } else {
      this.resetPosition();
    }

    if (this.isSwipe) setTimeout(() => { this.isSwipe = false; }, 0);
  }

  /** Snap content/triangle back to their resting positions. */
  resetPosition(immediate = false) {
    const content = this.shadowRoot.querySelector('.content');
    const panel = this.shadowRoot.querySelector('.action-panel');
    const tab = this.shadowRoot.querySelector('.pl-tab');
    if (content) {
      if (!immediate) content.classList.remove('dragging');
      content.style.transform = '';
    }
    if (panel) panel.classList.remove('visible');
    if (tab) {
      tab.classList.remove('dragging');
      tab.style.transform = '';
      tab.style.opacity = '';
    }
  }

  /** Commit an add/remove of the working playlist and animate accordingly. */
  toggleMembership() {
    if (this.isToggling) return;
    this.isToggling = true;
    setTimeout(() => { this.isToggling = false; }, 500);

    const member = this.isMember;
    const d = this.songData;
    const song = {
      id: d.id,
      title: this.getAttribute('title') || d.title || 'Unknown',
      artist: this.getAttribute('artist') || d.artist || 'Unknown',
      cover: this.getAttribute('cover') || d.cover || '',
      source: this.getAttribute('source') || d.source || 'unknown'
    };

    const content = this.shadowRoot.querySelector('.content');
    const panel = this.shadowRoot.querySelector('.action-panel');
    const tab = this.shadowRoot.querySelector('.pl-tab');

    if (content) { content.classList.remove('dragging'); content.style.transform = ''; }
    if (panel) panel.classList.remove('visible');

    if (tab) {
      tab.classList.remove('dragging');
      if (member) {
        // Removing → slide the triangle back off the right edge.
        tab.classList.remove('member');
        tab.style.transform = 'translate(100%, -50%) rotate(45deg)';
        tab.style.opacity = '0';
      } else {
        // Adding → settle the triangle into its peeking position.
        tab.classList.add('member');
        tab.style.transform = '';
        tab.style.opacity = '';
      }
    }

    this.dispatchEvent(new CustomEvent(member ? 'remove-from-playlist' : 'add-to-playlist', {
      detail: { song }, bubbles: true, composed: true
    }));
  }
}

customElements.define('song-item', SongItem);
