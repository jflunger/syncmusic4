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
 *  - Swipe left-to-right    → same as a tap: enqueue (emits 'enqueue-song' { song }).
 *                             Playlist membership lives in the track editor's flip menu.
 *  - Long-press (library)   → edit (emits 'track-edit-request' { song, origin }).
 *
 * A pending entry (data-song has pending: true — enqueued from search, not downloaded yet) is
 * dimmed with a "Downloading" note; the player skips it until the download lands.
 *
 * Attributes:
 *  - no-swipe : disable the enqueue swipe gesture (tap + queue indicator still work).
 *
 * Emits: 'enqueue-song' (via bubbling click, or directly on a committed swipe),
 *        'remove-from-queue', 'toggle-play-pause', 'track-edit-request'.
 */

import appState from '../state/appState.js';
import { icon } from '../icons.js';

const MAX_SWIPE = 160;       // px the content can slide while swiping (wide enough to read the action text)
const SWIPE_THRESHOLD = 80;  // px past which a swipe enqueues (same cutoff as playlist-item)
const SETTLE_MS = 350;       // snap-back transition (0.3s) plus slack, before the layer is dropped
const DIR_LOCK = 8;          // px before we decide horizontal-vs-vertical intent

const PLAY_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="#fff"><path d="M8 5v14l11-7z"/></svg>';
const REMOVE_SVG = '<svg class="q-remove" viewBox="0 0 24 24" width="15" height="15" fill="#fff"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';

/**
 * Markup for the queue wedge in a given state.
 * @param {'playing'|'removable'} state
 * @param {number} [num] 1-based queue position (removable only)
 * @returns {string}
 */
function indicatorHtml(state, num) {
  const title = state === 'playing' ? 'Now playing' : 'Remove from queue';
  const extra = state === 'playing' ? '' : REMOVE_SVG;
  return `<div class="queue-indicator ${state}" title="${title}"><div class="q-plate"><div class="q-glyph"><span class="q-face">${faceHtml(state, num)}</span>${extra}</div></div></div>`;
}

/** Inner content of the wedge's face: play glyph or queue position. */
function faceHtml(state, num) {
  return state === 'playing' ? PLAY_SVG : String(num);
}

/** Identity of what a wedge displays, so changes can be detected and morphed. */
function indicatorKey(el) {
  if (!el) return '';
  const face = el.querySelector('.q-face:not(.q-out)');
  return `${el.classList.contains('playing') ? 'playing' : 'removable'}:${face ? face.textContent : ''}`;
}

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
  /* touch-action is set inline in render() — it depends on whether this is the current
     track, not just the no-swipe attribute, so it can't be a static :host rule. */
  :host(:last-child) { border-bottom: none; }

  /* Revealed action panel (sits behind the sliding content) */
  .action-panel {
    position: absolute;
    inset: 0;
    z-index: 0;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    padding-left: 22px;
    background: #1db954;
    color: #fff;
    font-size: 15px;
    font-weight: 700;
    white-space: nowrap;
    opacity: 0;
    transition: opacity 0.2s;
  }
  .action-panel.visible { opacity: 1; }

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
     the .content padding (8px 10px) so it reaches the actual track edges.
     Two layers on purpose: the outer box only slides (plain transform, no clip), the
     inner .q-plate carries the clip-path and paint. Animating a transform on the clipped
     element itself makes WebKit repaint the clip a frame behind — it flickers, then pops. */
  .queue-indicator {
    position: absolute;
    top: -8px;
    bottom: -8px;
    left: -10px;
    width: 42px;
    z-index: 3;
    font-size: 13px;
    font-weight: 700;
    color: #fff;
    will-change: transform;
  }
  /* Even-paced curves on purpose: a strong ease-out covers most of the distance in the
     first ~100ms (reads as "just appears"), a strong ease-in in the last ~100ms (reads
     as "just vanishes"). These keep the travel visible for most of the run. */
  .queue-indicator.entering { animation: wedge-in 0.55s cubic-bezier(0.3, 0.6, 0.3, 1) both; }
  .queue-indicator.leaving {
    animation: wedge-out 0.45s cubic-bezier(0.45, 0, 0.6, 0.6) forwards;
    pointer-events: none;
  }
  @keyframes wedge-in { from { transform: translateX(-100%); } to { transform: none; } }
  @keyframes wedge-out { from { transform: none; } to { transform: translateX(-100%); } }

  .q-plate {
    position: absolute;
    inset: 0;
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
    /* Flat face with a metallic rim only: the clip path itself, stroked (half the
       stroke falls inside the clip), lit along the top edge and shaded along the
       bottom, with a softer wide stroke underneath for a slight bevel. */
    background:
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 42 88'%3E%3Cdefs%3E%3ClinearGradient id='r' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='white' stop-opacity='.6'/%3E%3Cstop offset='.4' stop-color='white' stop-opacity='.12'/%3E%3Cstop offset='.6' stop-color='black' stop-opacity='.12'/%3E%3Cstop offset='1' stop-color='black' stop-opacity='.45'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cg fill='none' stroke='url(%23r)'%3E%3Cpath stroke-width='6' opacity='.35' d='M0,8 Q0,0 7.5,2.7 L34.5,12.3 Q42,15 42,23 L42,65 Q42,73 34.5,75.7 L7.5,85.3 Q0,88 0,80 Z'/%3E%3Cpath stroke-width='2.5' d='M0,8 Q0,0 7.5,2.7 L34.5,12.3 Q42,15 42,23 L42,65 Q42,73 34.5,75.7 L7.5,85.3 Q0,88 0,80 Z'/%3E%3C/g%3E%3C/svg%3E")
        0 0 / 100% 100% no-repeat,
      var(--wedge-color, #2c2c2c);
    transition: background-color 0.2s;
  }
  .queue-indicator.playing { --wedge-color: #1db954; }
  .queue-indicator.removable { cursor: pointer; }

  /* Glyph slot: number / icon. Holds two layers during a morph. */
  .q-glyph {
    position: relative;
    display: grid;
    place-items: center;
    min-width: 18px;
    height: 18px;
    text-shadow: 0 1px 1px rgba(0,0,0,0.35);
  }
  .q-glyph > * { grid-area: 1 / 1; }
  /* Block, not inline: an inline SVG sits on the text baseline and rides ~1.5px high. */
  .q-glyph svg { display: block; }
  .q-glyph .q-in  { animation: glyph-in 0.45s cubic-bezier(0.3, 0.7, 0.2, 1) both; }
  .q-glyph .q-out { animation: glyph-out 0.35s ease-in forwards; }
  @keyframes glyph-in {
    from { opacity: 0; filter: blur(6px); transform: translateY(6px) scale(0.6); }
    60%  { opacity: 1; filter: blur(1px); }
    to   { opacity: 1; filter: blur(0); transform: none; }
  }
  @keyframes glyph-out {
    to { opacity: 0; filter: blur(6px); transform: translateY(-6px) scale(1.4); }
  }
  .queue-indicator.removable .q-remove { display: none; }
  @media (hover: hover) {
    .queue-indicator.removable:hover { --wedge-color: #c0392b; }
    .queue-indicator.removable:hover .q-glyph > :not(.q-remove) { display: none; }
    .queue-indicator.removable:hover .q-remove { display: block; }
  }
  @media (prefers-reduced-motion: reduce) {
    .queue-indicator, .q-glyph > * { animation: none !important; }
  }

  .details { flex: 1; min-width: 0; }
  /* Pending queue entry: enqueued from search, still downloading — skipped until it lands */
  .content.pending .cover-wrap, .content.pending .title, .content.pending .artist { opacity: 0.55; }
  .pending-note {
    margin: 3px 0 0;
    font-size: 12px;
    color: #64b5f6;
    animation: pending-pulse 1.6s ease-in-out infinite;
  }
  @keyframes pending-pulse { 50% { opacity: 0.45; } }
  @media (prefers-reduced-motion: reduce) { .pending-note { animation: none; } }
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
      if (key === 'currentSong') {
        if (!this.isDragging) this.render();
      }
    });
  }

  disconnectedCallback() {
    if (this.unsubscribeState) this.unsubscribeState();
    document.removeEventListener('mousemove', this._onMove);
    document.removeEventListener('mouseup', this._onEnd);
    this.endSwipeVisuals();
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

  /** Swipe-to-enqueue is live unless disabled, or the track is already playing. */
  get swipeEnabled() {
    return !this.hasAttribute('no-swipe') && this.songId != null && !this.isCurrentSong;
  }

  /** What a tap (and so a swipe) does to this track right now — mirrors MusicApp.enqueueSong. */
  get enqueueLabel() {
    const i = this.queueIndex;
    return i < 0 ? 'add to queue' : i === 0 ? 'play now' : 'play next';
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
    const indicator = content.querySelector('.queue-indicator:not(.leaving)');

    if (isCurrent) {
      // Current track's green badge is managed by render(); leave it untouched.
    } else if (queued) {
      if (indicator) {
        // Position changed (or a stale playing badge) → morph the existing wedge in place.
        this.morphIndicator(indicator, 'removable', qIndex + 1);
      } else {
        content.insertAdjacentHTML('afterbegin', indicatorHtml('removable', qIndex + 1));
        this.enterIndicator(content.firstElementChild);
      }
    } else if (indicator && indicator.classList.contains('removable')) {
      // No longer queued → slide the wedge back out to the left.
      this.dismissIndicator(indicator);
    }

    const cover = this.shadowRoot.querySelector('.cover');
    if (cover) cover.classList.toggle('vinyl', isCurrent || queued);
  }

  /** Slide a freshly inserted wedge in from the left. */
  enterIndicator(el) {
    el.classList.add('entering');
    const done = (e) => {
      if (e.target !== el || e.animationName !== 'wedge-in') return;
      // Drop the class so re-inserting this node (render reuse) can't replay the slide.
      el.classList.remove('entering');
      el.removeEventListener('animationend', done);
    };
    el.addEventListener('animationend', done);
  }

  /** Slide a wedge out to the left, then remove it. */
  dismissIndicator(el) {
    el.classList.remove('entering');
    el.classList.add('leaving');
    el.removeAttribute('title');
    const remove = () => el.remove();
    el.addEventListener('animationend', (e) => {
      if (e.target === el && e.animationName === 'wedge-out') remove();
    });
    // Fallback for reduced motion / detached rows, where animationend never fires.
    setTimeout(remove, 600);
  }

  /**
   * Switch a wedge to a new state/number, morphing its face: the old glyph blurs up
   * and out while the new one condenses in beneath it. No-op when nothing changed.
   * @param {HTMLElement} el
   * @param {'playing'|'removable'} state
   * @param {number} [num]
   */
  morphIndicator(el, state, num) {
    const nextKey = `${state}:${state === 'playing' ? '' : num}`;
    if (indicatorKey(el) === nextKey) return;

    const playing = state === 'playing';
    el.classList.toggle('playing', playing);
    el.classList.toggle('removable', !playing);
    el.title = playing ? 'Now playing' : 'Remove from queue';

    const glyph = el.querySelector('.q-glyph');
    glyph.querySelectorAll('.q-face:not(.q-out)').forEach(old => {
      old.classList.remove('q-in');
      old.classList.add('q-out');
      old.addEventListener('animationend', () => old.remove(), { once: true });
      setTimeout(() => old.remove(), 400);
    });
    const face = document.createElement('span');
    face.className = 'q-face q-in';
    face.innerHTML = faceHtml(state, num);
    face.addEventListener('animationend', () => face.classList.remove('q-in'), { once: true });
    glyph.prepend(face);

    const remove = glyph.querySelector('.q-remove');
    if (playing && remove) remove.remove();
    if (!playing && !remove) glyph.insertAdjacentHTML('beforeend', REMOVE_SVG);
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

  /** True for a pending queue entry (enqueued from search, still downloading). */
  get isPending() {
    return !!this.songData.pending;
  }

  /* ---------- render hooks (subclasses, e.g. <search-result-item>, fill these) ---------- */

  /** @returns {string} Extra markup overlaid on the cover (inside .cover-wrap). */
  coverExtraHtml() { return ''; }

  /** @returns {string} Extra lines under the artist. */
  detailsExtraHtml() { return ''; }

  /** @returns {string} Markup after the details, at the row's right edge. */
  trailingHtml() { return ''; }

  /* ---------- render ---------- */

  render() {
    const title = this.getAttribute('title') || this.songData.title || 'Unknown';
    const artist = this.getAttribute('artist') || this.songData.artist || 'Unknown';
    const cover = this.getAttribute('cover') || this.songData.cover || '';
    const source = (this.getAttribute('source') || this.songData.source || 'unknown').toLowerCase();
    const sourceIcon = icon(source === 'spotify' ? 'spotify-source' : source === 'soundcloud' ? 'soundcloud-source' : 'local-file');

    const currentSong = appState.get('currentSong');
    const isCurrent = this.songId != null && currentSong && String(currentSong.id) === String(this.songId);
    // Global transport state — the disc only spins while audio is actually playing.
    const playing = isCurrent && appState.get('isPlaying');
    const qIndex = this.queueIndex;
    const queued = qIndex >= 0;
    const isVinyl = isCurrent || queued;
    const pending = this.isPending;

    const swipeUI = this.swipeEnabled;

    // Queue indicator overlay (left half of cover). Green play icon when playing,
    // grey position number (tap to remove) when queued.
    const indicatorState = isCurrent ? 'playing' : queued ? 'removable' : null;
    const prevIndicator = this.shadowRoot.querySelector('.content > .queue-indicator:not(.leaving)');

    // Text is filled in when a swipe starts, since the queue may have changed since render.
    const panelHtml = swipeUI ? '<div class="action-panel"></div>' : '';

    // touch-action depends on whether the swipe is live, so it's set on the host inline
    // rather than baked into the shared sheet.
    this.style.touchAction = swipeUI ? 'pan-y' : 'manipulation';

    this.shadowRoot.innerHTML = `
      ${panelHtml}
      <div class="content ${pending ? 'pending' : ''}">
        ${indicatorState ? indicatorHtml(indicatorState, qIndex + 1) : ''}
        <div class="cover-wrap">
          <div class="cover ${isVinyl ? 'vinyl' : ''} ${isCurrent ? 'spinning' : ''} ${playing ? 'playing' : ''}">
            ${cover ? `<img src="${this.escHtml(cover)}" alt="Cover" loading="lazy" decoding="async">` : `<div class="no-cover">${sourceIcon}</div>`}
          </div>
          ${this.coverExtraHtml()}
        </div>
        <div class="details">
          <h4 class="title">${this.escHtml(title)}</h4>
          <p class="artist"><span class="source-dot ${source}"></span>${this.escHtml(artist)}</p>
          ${pending ? '<p class="pending-note">Downloading · plays once ready</p>' : ''}
          ${this.detailsExtraHtml()}
        </div>
        ${this.trailingHtml()}
      </div>
    `;

    this.animateIndicatorChange(prevIndicator, indicatorState, qIndex + 1);
    this.hasRendered = true;
  }

  /**
   * After a full re-render, carry the wedge across instead of letting it pop: reuse the
   * previous node (morphing its face if the state changed), slide a new one in, or slide
   * a vanished one out. The very first render of a row never animates.
   */
  animateIndicatorChange(prev, state, num) {
    if (!this.hasRendered) return;
    const content = this.shadowRoot.querySelector('.content');
    const next = content.querySelector('.queue-indicator');
    if (prev && next) {
      content.replaceChild(prev, next);
      this.morphIndicator(prev, state, num);
    } else if (next) {
      this.enterIndicator(next);
    } else if (prev) {
      content.prepend(prev);
      this.dismissIndicator(prev);
    }
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

    // The editor grows out of (and shrinks back into) this row, like the Play tab's slab.
    const radius = parseFloat(getComputedStyle(this).borderTopLeftRadius) || 0;
    this.dispatchEvent(new CustomEvent('track-edit-request', {
      detail: { song, origin: { el: this, inset: 0, radius } }, bubbles: true, composed: true
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
    const dx = point.clientX - this.startX; // positive → rightward
    const dy = point.clientY - this.startY;

    if (Math.hypot(dx, dy) > this.longPressThreshold) this.cancelLongPress();

    // Decide intent once: horizontal swipe vs vertical scroll
    if (!this.swiping) {
      if (!this.swipeEnabled) {
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
        const panel = this.shadowRoot.querySelector('.action-panel');
        if (panel) panel.textContent = this.enqueueLabel;
        this.beginSwipeVisuals();
      } else {
        return;
      }
    }

    if (event.cancelable) event.preventDefault();

    const distance = Math.max(0, Math.min(dx, MAX_SWIPE)); // only reveal rightward
    this.isSwipe = distance > 5;
    this.swipeX = distance;
    // Touch/mouse moves can arrive faster than (and out of step with) paint; write the
    // offset once per frame instead of on every event.
    if (!this.swipeFrame) this.swipeFrame = requestAnimationFrame(() => this.paintSwipe());
  }

  /** Apply the latest drag offset (called from requestAnimationFrame). */
  paintSwipe() {
    this.swipeFrame = null;
    const content = this.shadowRoot.querySelector('.content');
    const panel = this.shadowRoot.querySelector('.action-panel');
    if (content) {
      content.classList.add('dragging');
      content.style.transform = `translateX(${this.swipeX}px)`;
    }
    if (panel) panel.classList.toggle('visible', this.swipeX > 12);
  }

  /**
   * A swipe just locked in: give the sliding content its own compositor layer, so each
   * frame is a pure GPU move rather than a repaint.
   */
  beginSwipeVisuals() {
    clearTimeout(this.settleTimer);
    const content = this.shadowRoot.querySelector('.content');
    if (content) content.style.willChange = 'transform';
  }

  /** Undo beginSwipeVisuals once the row is at rest (or gone). */
  endSwipeVisuals() {
    cancelAnimationFrame(this.swipeFrame);
    this.swipeFrame = null;
    clearTimeout(this.settleTimer);
    const content = this.shadowRoot.querySelector('.content');
    if (content) content.style.willChange = '';
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

    const dx = this.currentX - this.startX;

    this.resetPosition();
    if (wasSwiping && this.swipeEnabled && dx >= SWIPE_THRESHOLD) this.enqueueFromSwipe();

    if (this.isSwipe) setTimeout(() => { this.isSwipe = false; }, 0);
  }

  /** Snap the content back to its resting position. */
  resetPosition(immediate = false) {
    cancelAnimationFrame(this.swipeFrame); // a frame still queued would re-apply the drag
    this.swipeFrame = null;
    const content = this.shadowRoot.querySelector('.content');
    const panel = this.shadowRoot.querySelector('.action-panel');
    if (content) {
      if (!immediate) content.classList.remove('dragging');
      content.style.transform = '';
    }
    if (panel) panel.classList.remove('visible');
    // Keep the layer through the snap-back transition, then drop it.
    clearTimeout(this.settleTimer);
    if (immediate) this.endSwipeVisuals();
    else this.settleTimer = setTimeout(() => this.endSwipeVisuals(), SETTLE_MS);
  }

  /**
   * A committed swipe does exactly what a tap does: hand the track to the host tab's
   * enqueue path (MusicApp.enqueueSong — enqueue → move to front → play).
   */
  enqueueFromSwipe() {
    const song = this.songData;
    if (!song.id) return;
    this.dispatchEvent(new CustomEvent('enqueue-song', {
      detail: { song }, bubbles: true, composed: true
    }));
  }
}

customElements.define('song-item', SongItem);

export default SongItem;
