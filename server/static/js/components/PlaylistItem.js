/**
 * Playlist item component for displaying a single playlist.
 * Usage: <playlist-item name="My Playlist" songs-count="12" icon="/path/to/icon" playlist-id="1"
 *          playtime="${playlistPlaytime(playlist)}" feeder="true"
 *          covers="${playlistCoversAttr(playlist)}"></playlist-item>
 * Each playlist shows an icon (custom or default), name, song count and total playtime
 * (`playtime`, seconds) on a liquid-glass
 * slab: the playlist's covers (`covers`, space-separated URLs) drift slowly sideways behind
 * heavily refracting, frosted glass (drawn by the shared GlassStripRenderer).
 *
 * Swipe actions (each direction independently enabled by setting its attribute to the
 * reveal text; absent attribute = that direction disabled):
 *  - swipe-right="add as feeder"   → swiping the card right reveals the text and, past the
 *                                     threshold, emits 'feeder-add'.
 *  - swipe-left="remove as feeder" → swiping the card left reveals the text and, past the
 *                                     threshold, emits 'feeder-remove'.
 *
 * A round glass lens on the right toggles feeder status: lit when `feeder="true"`; a
 * click emits 'feeder-remove' when lit, 'feeder-add' otherwise.
 *
 * Emits:
 *  - 'playlist-settings-request' (long-press) with { detail: { playlistId, origin } }
 *  - 'feeder-add'    (committed right swipe / lens click) with { detail: { playlistId } }
 *  - 'feeder-remove' (committed left swipe / lens click)  with { detail: { playlistId } }
 */

import glassStrip from '../services/GlassStripRenderer.js';

const MAX_COVERS = 5;        // covers shown drifting behind the glass

/**
 * Build the `covers` attribute for a playlist: the covers of its first MAX_COVERS tracks
 * (distinct, in playlist order), space-separated and escaped for a double-quoted attribute.
 * @param {{songs?: {cover?: string}[]}} playlist
 * @returns {string}
 */
export function playlistCoversAttr(playlist) {
  const picked = [...new Set((playlist.songs || []).map(s => s.cover).filter(Boolean))].slice(0, MAX_COVERS);
  return picked.map(u => u.replace(/ /g, '%20')).join(' ')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * Total playtime of a playlist in seconds: each song's clip (start_time..end_time, falling
 * back to the whole file) summed. Songs whose length isn't known yet count as 0.
 * @param {{songs?: {duration?: number, start_time?: number, end_time?: number}[]}} playlist
 * @returns {number}
 */
export function playlistPlaytime(playlist) {
  return Math.round((playlist.songs || []).reduce((total, s) => {
    const end = s.end_time ?? s.duration;
    return end ? total + Math.max(0, end - (s.start_time || 0)) : total;
  }, 0));
}

/**
 * Format seconds as "48 min" / "2 h 5 min".
 * @param {number} seconds
 * @returns {string}
 */
function formatPlaytime(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

const SWIPE_THRESHOLD = 80;  // px past which a swipe commits its action
const MAX_SWIPE = 140;       // px the card can be dragged
const DIR_LOCK = 10;         // px of movement before horizontal/vertical intent is locked
const SETTLE_MS = 350;       // snap-back transition (0.3s) plus slack, before the layer is dropped
const SCROLL_SLOP = 3;       // px the card may drift under a held finger before it counts as a scroll

class PlaylistItem extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.isLongPress = false;
    this.isSwipe = false;
    this.longPressTimer = null;
    this.longPressDelay = 500;
    this.longPressThreshold = 15;

    // Swipe state
    this.isDragging = false;
    this.swiping = false;
    this.swipeDir = null; // 'left' | 'right' once locked
    this.startX = 0;
    this.startY = 0;
    this.currentX = 0;
    this.swipeDistance = 0; // travel along the locked direction, never negative
  }

  static get observedAttributes() {
    return ['name', 'songs-count', 'playtime', 'icon', 'playlist-id', 'swipe-left', 'swipe-right',
      'covers', 'feeder'];
  }

  attributeChangedCallback(name) {
    // Feeder toggles just relight the lens; a full render would rebuild the glass canvas.
    const lens = this.shadowRoot.querySelector('.feeder-lens');
    if (name === 'feeder' && lens) {
      lens.classList.toggle('on', this.isFeeder);
      lens.setAttribute('aria-pressed', String(this.isFeeder));
      return;
    }
    this.render();
  }

  /** True when this playlist is currently a Play-tab feeder. */
  get isFeeder() {
    return this.getAttribute('feeder') === 'true';
  }

  connectedCallback() {
    this.render();
    if (!this._eventsAttached) {
      this.attachEvents();
      this._eventsAttached = true;
    }
  }

  disconnectedCallback() {
    this.endSwipeVisuals();
    glassStrip.unregister(this._glass);
    this._glass = null;
  }

  /** Hand the freshly rendered canvas to the shared glass renderer (new before old, so a
      shared cover texture isn't released and reloaded in between). */
  attachGlass() {
    const old = this._glass;
    this._glass = null;
    if (this.isConnected) {
      const canvas = this.shadowRoot.querySelector('canvas.glass');
      const covers = (this.getAttribute('covers') || '').split(' ').filter(Boolean);
      const seed = (parseInt(this.getAttribute('playlist-id'), 10) || 0) * 2.618;
      this._glass = glassStrip.register(canvas, covers, seed);
    }
    glassStrip.unregister(old);
  }

  /** True when at least one swipe direction is enabled. */
  get swipeEnabled() {
    return this.hasAttribute('swipe-left') || this.hasAttribute('swipe-right');
  }

  /**
   * Wire up long-press detection and (when enabled) swipe gestures. A held press
   * opens the playlist's settings menu; a normal tap bubbles to the host tab.
   */
  attachEvents() {
    // The lens's click must not also open the playlist (the host tab listens for clicks).
    this.shadowRoot.addEventListener('click', (e) => {
      if (!e.target.closest('.feeder-lens')) return;
      e.stopPropagation();
      const playlistId = parseInt(this.getAttribute('playlist-id'), 10);
      this.dispatchEvent(new CustomEvent(this.isFeeder ? 'feeder-remove' : 'feeder-add', {
        detail: { playlistId }, bubbles: true, composed: true
      }));
    });
    this.addEventListener('touchstart', (e) => this.handleStart(e), { passive: true });
    this.addEventListener('touchmove', (e) => this.handleMove(e), { passive: false });
    this.addEventListener('touchend', () => this.handleEnd(), { passive: true });
    this.addEventListener('touchcancel', () => this.handleEnd(), { passive: true });
    this.addEventListener('mousedown', (e) => this.handleStart(e));
    this.addEventListener('mousemove', (e) => this.handleMove(e));
    this.addEventListener('mouseup', () => this.handleEnd());
    this.addEventListener('mouseleave', () => this.handleEnd());
  }

  handleStart(event) {
    // A press on the lens is a button press — no long-press menu, no swipe.
    if (event.composedPath().some(el => el.classList?.contains('feeder-lens'))) return;
    const point = event.type === 'touchstart' ? event.touches[0] : event;
    this.isLongPress = false;
    this.isSwipe = false;
    this.isDragging = true;
    this.swiping = false;
    this.swipeDir = null;
    this.startX = point.clientX;
    this.startY = point.clientY;
    this.currentX = point.clientX;
    this.swipeDistance = 0;
    // Where the card sits on screen right now. A scroll moves it even when the finger
    // barely travels, which is what the long-press timer checks before it fires.
    this.startTop = this.getBoundingClientRect().top;
    this.cancelLongPress();
    this.longPressTimer = setTimeout(() => this.onLongPressFired(), this.longPressDelay);
  }

  handleMove(event) {
    const point = event.type === 'touchmove' ? event.touches[0] : event;
    const dx = point.clientX - this.startX; // positive → rightward
    const dy = point.clientY - this.startY;

    // Checked before the isDragging guard: once the gesture is written off as a
    // scroll the guard swallows every later move, so a timer left running here
    // would still fire mid-scroll and pop the settings menu open.
    if (Math.hypot(dx, dy) > this.longPressThreshold || Math.abs(dy) > DIR_LOCK) {
      this.cancelLongPress();
    }

    if (!this.isDragging) return;
    this.currentX = point.clientX;
    if (!this.swipeEnabled) return;

    // Lock intent once: horizontal swipe vs vertical scroll.
    if (!this.swiping) {
      if (Math.abs(dy) > DIR_LOCK && Math.abs(dy) > Math.abs(dx)) {
        this.isDragging = false; // vertical — let the list scroll
        return;
      }
      if (Math.abs(dx) <= DIR_LOCK) return;

      const dir = dx < 0 ? 'left' : 'right';
      const attr = dir === 'left' ? 'swipe-left' : 'swipe-right';
      if (!this.hasAttribute(attr)) {
        this.isDragging = false; // this direction is disabled — ignore the gesture
        return;
      }
      this.swiping = true;
      this.swipeDir = dir;
      this.cancelLongPress(); // a swipe is under way — not a press
      this.beginSwipeVisuals();
    }

    if (event.cancelable) event.preventDefault(); // own the horizontal gesture

    // Travel is measured along the locked direction only, so moving back past the
    // start point rests the card at 0 instead of dragging it the other way.
    const travel = this.swipeDir === 'left' ? -dx : dx;
    const distance = Math.max(0, Math.min(travel, MAX_SWIPE));
    this.swipeDistance = distance;
    this.isSwipe = distance > 5;
    // Touch/mouse moves can arrive faster than (and out of step with) paint; write the
    // offset once per frame instead of on every event.
    if (!this.swipeFrame) this.swipeFrame = requestAnimationFrame(() => this.paintSwipe());
  }

  /** Apply the latest drag offset (called from requestAnimationFrame). */
  paintSwipe() {
    this.swipeFrame = null;
    const distance = this.swipeDistance;
    const card = this.shadowRoot.querySelector('.playlist-card');
    const reveal = this.shadowRoot.querySelector(
      this.swipeDir === 'left' ? '.reveal-right' : '.reveal-left'
    );
    if (card) {
      card.classList.add('dragging');
      card.style.transform = `translateX(${this.swipeDir === 'left' ? -distance : distance}px)`;
    }
    if (reveal) reveal.classList.toggle('visible', distance > 12);
  }

  /**
   * A swipe just locked in: give the card its own compositor layer, so each frame is a
   * pure GPU move rather than a repaint.
   */
  beginSwipeVisuals() {
    clearTimeout(this.settleTimer);
    const card = this.shadowRoot.querySelector('.playlist-card');
    if (card) card.style.willChange = 'transform';
  }

  /** Undo beginSwipeVisuals once the card is at rest (or gone). */
  endSwipeVisuals() {
    cancelAnimationFrame(this.swipeFrame);
    this.swipeFrame = null;
    clearTimeout(this.settleTimer);
    const card = this.shadowRoot.querySelector('.playlist-card');
    if (card) card.style.willChange = '';
  }

  handleEnd() {
    this.cancelLongPress();
    if (!this.isDragging) return;
    this.isDragging = false;

    const committed = this.swiping;
    const dir = this.swipeDir;
    const distance = this.swipeDistance;
    this.swiping = false;
    this.swipeDir = null;
    this.swipeDistance = 0;

    if (committed && distance >= SWIPE_THRESHOLD) {
      this.commitSwipe(dir);
    } else {
      this.resetPosition();
    }

    if (this.isSwipe) setTimeout(() => { this.isSwipe = false; }, 0);
  }

  /** Snap the card and reveal panels back to rest. */
  resetPosition() {
    cancelAnimationFrame(this.swipeFrame); // a frame still queued would re-apply the drag
    this.swipeFrame = null;
    const card = this.shadowRoot.querySelector('.playlist-card');
    if (card) {
      card.classList.remove('dragging');
      card.style.transform = '';
    }
    this.shadowRoot.querySelectorAll('.reveal').forEach(r => r.classList.remove('visible'));
    // Keep the layer through the snap-back transition, then drop it.
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.endSwipeVisuals(), SETTLE_MS);
  }

  /**
   * Fire the action for a committed swipe. Right → 'feeder-add', left → 'feeder-remove'.
   * The card snaps back; the host list re-renders from state to reflect the change.
   * @param {'left'|'right'} dir
   */
  commitSwipe(dir) {
    this.resetPosition();
    const playlistId = parseInt(this.getAttribute('playlist-id'), 10);
    const eventName = dir === 'right' ? 'feeder-add' : 'feeder-remove';
    this.dispatchEvent(new CustomEvent(eventName, {
      detail: { playlistId }, bubbles: true, composed: true
    }));
  }

  cancelLongPress() {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  onLongPressFired() {
    this.longPressTimer = null;

    // A slow scroll drags the finger less than longPressThreshold over the whole delay,
    // so the move handler never cancels the timer and the menu pops open under a finger
    // that was only ever scrolling. The finger's own travel can't tell the two apart at
    // that speed -- the card's travel can. A real press holds the card still; any scroll,
    // however slow, has carried it up or down the screen by now.
    if (Math.abs(this.getBoundingClientRect().top - this.startTop) > SCROLL_SLOP) return;

    this.isLongPress = true;
    const playlistId = parseInt(this.getAttribute('playlist-id'), 10);
    // The settings sheet grows out of (and shrinks back into) this card.
    const radius = parseFloat(getComputedStyle(this).borderTopLeftRadius) || 0;
    this.dispatchEvent(new CustomEvent('playlist-settings-request', {
      detail: { playlistId, origin: { el: this, inset: 0, radius } }, bubbles: true, composed: true
    }));
  }

  render() {
    const name = this.getAttribute('name') || 'Unnamed Playlist';
    const count = parseInt(this.getAttribute('songs-count') || 0);
    const icon = this.getAttribute('icon') || '';
    const playtime = parseInt(this.getAttribute('playtime') || 0, 10);
    const countText = `${count} song${count !== 1 ? 's' : ''}`
      + (playtime > 0 ? ` · ${formatPlaytime(playtime)}` : '');
    const leftText = this.getAttribute('swipe-left') || '';   // revealed on left swipe (right edge)
    const rightText = this.getAttribute('swipe-right') || ''; // revealed on right swipe (left edge)

    const iconHtml = icon
      ? `<img class="playlist-icon-img" src="${icon}" alt="" decoding="async">`
      : `<div class="playlist-icon-default" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/>
          </svg>
        </div>`;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          position: relative;
          overflow: hidden;
          border-radius: 14px;
          touch-action: ${this.swipeEnabled ? 'pan-y' : 'auto'};
        }
        /* Revealed action panels sit behind the sliding card. */
        .reveal {
          position: absolute;
          inset: 0;
          z-index: 0;
          display: flex;
          align-items: center;
          padding: 0 22px;
          opacity: 0;
          transition: opacity 0.2s ease;
          color: #fff;
          font-weight: 700;
          font-size: 15px;
          border-radius: 14px;
        }
        .reveal.visible { opacity: 1; }
        .reveal-right { justify-content: flex-end; background: #e53935; }  /* left swipe → remove */
        .reveal-left  { justify-content: flex-start; background: #1db954; } /* right swipe → add */
        .playlist-card {
          position: relative;
          z-index: 1;
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 14px 16px;
          border-radius: 14px;
          /* Fallback / loading look; the glass canvas fades in over it. */
          background: linear-gradient(135deg, #2a2a2a 0%, #1c1c1c 100%);
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
          cursor: pointer;
          transform: translateX(0);
          transition: transform 0.3s ease-out;
        }
        .playlist-card.dragging { transition: none; }
        /* Liquid-glass slab with the playlist's covers drifting behind it. */
        canvas.glass {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          border-radius: 14px;
          opacity: 0;
          transition: opacity 0.6s ease, filter 0.2s ease;
          pointer-events: none;
        }
        canvas.glass.ready { opacity: 1; }
        @media (hover: hover) {
          .playlist-card:hover canvas.glass { filter: brightness(1.18) saturate(1.1); }
        }
        .playlist-icon, .playlist-info { position: relative; z-index: 1; }
        .playlist-icon {
          width: 56px;
          height: 56px;
          border-radius: 10px;
          flex-shrink: 0;
          overflow: hidden;
          display: flex;
          align-items: center;
          justify-content: center;
          /* Sits on the glass like a tile resting on it. */
          box-shadow: 0 6px 14px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.16);
        }
        .playlist-icon-img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        .playlist-icon-default {
          width: 100%;
          height: 100%;
          background: linear-gradient(145deg, #1db954 0%, #169c46 100%);
          display: flex;
          align-items: center;
          justify-content: center;
          color: rgba(255, 255, 255, 0.9);
        }
        .playlist-icon-default svg {
          width: 28px;
          height: 28px;
        }
        .playlist-info {
          flex: 1;
          min-width: 0;
        }
        .playlist-name {
          font-size: 16px;
          font-weight: 600;
          color: #fff;
          margin: 0 0 4px 0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7), 0 0 12px rgba(0, 0, 0, 0.4);
        }
        .playlist-meta {
          font-size: 13px;
          color: rgba(255, 255, 255, 0.72);
          font-weight: 500;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.7);
        }
        /* Feeder toggle: a circular lens cut into the glass slab — recessed (shadow along
           the top inner edge, light catching the bottom rim) and re-refracting the covers
           behind it. Lit green while the playlist is a feeder. */
        .feeder-lens {
          position: relative;
          z-index: 1;
          flex-shrink: 0;
          width: 44px;
          height: 44px;
          padding: 0;
          border: none;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          color: rgba(255, 255, 255, 0.55);
          background:
            radial-gradient(circle at 50% 120%, rgba(255, 255, 255, 0.22), transparent 60%),
            rgba(0, 0, 0, 0.18);
          -webkit-backdrop-filter: blur(3px) saturate(1.8) brightness(1.1);
          backdrop-filter: blur(3px) saturate(1.8) brightness(1.1);
          box-shadow:
            inset 0 3px 6px rgba(0, 0, 0, 0.45),
            inset 0 -1px 1px rgba(255, 255, 255, 0.35),
            0 1px 0 rgba(255, 255, 255, 0.14);
          -webkit-tap-highlight-color: transparent;
          transition: color 0.25s ease, background 0.25s ease, box-shadow 0.25s ease, transform 0.12s ease;
        }
        .feeder-lens svg { width: 22px; height: 22px; filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6)); }
        .feeder-lens.on {
          color: #1ed760;
          background:
            radial-gradient(circle at 50% 120%, rgba(30, 215, 96, 0.35), transparent 65%),
            rgba(29, 185, 84, 0.16);
          box-shadow:
            inset 0 3px 6px rgba(0, 0, 0, 0.4),
            inset 0 -1px 1px rgba(120, 255, 170, 0.5),
            0 0 12px rgba(30, 215, 96, 0.35);
        }
        .feeder-lens.on svg { filter: drop-shadow(0 0 4px rgba(30, 215, 96, 0.7)); }
        .feeder-lens:active { transform: scale(0.92); }
        @media (hover: hover) {
          .feeder-lens:not(.on):hover { color: rgba(255, 255, 255, 0.85); }
        }
      </style>
      ${rightText ? `<div class="reveal reveal-left"><span>${this.escHtml(rightText)}</span></div>` : ''}
      ${leftText ? `<div class="reveal reveal-right"><span>${this.escHtml(leftText)}</span></div>` : ''}
      <div class="playlist-card">
        <canvas class="glass"></canvas>
        <div class="playlist-icon">
          ${iconHtml}
        </div>
        <div class="playlist-info">
          <h4 class="playlist-name">${this.escHtml(name)}</h4>
          <div class="playlist-meta">${countText}</div>
        </div>
        <button class="feeder-lens${this.isFeeder ? ' on' : ''}" type="button"
          aria-pressed="${this.isFeeder}" title="Feeder: random songs play from it when the queue runs out">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M4.25 5.61C6.27 8.2 10 13 10 13v6c0 .55.45 1 1 1h2c.55 0 1-.45 1-1v-6s3.72-4.8 5.74-7.39A.998.998 0 0 0 18.95 4H5.04c-.83 0-1.3.95-.79 1.61z"/>
          </svg>
        </button>
      </div>
    `;
    this.attachGlass();
  }

  escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

customElements.define('playlist-item', PlaylistItem);
