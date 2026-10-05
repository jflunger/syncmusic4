/**
 * Playlist item component for displaying a single playlist.
 * Usage: <playlist-item name="My Playlist" songs-count="12" icon="/path/to/icon" playlist-id="1"></playlist-item>
 * Each playlist shows an icon (custom or default), name, and song count in an appealing card layout.
 *
 * Swipe actions (each direction independently enabled by setting its attribute to the
 * reveal text; absent attribute = that direction disabled):
 *  - swipe-left="add as feeder"    → swiping the card left reveals the text and, past the
 *                                     threshold, emits 'feeder-add'.
 *  - swipe-right="remove as feeder" → swiping the card right reveals the text and, past the
 *                                     threshold, emits 'feeder-remove'.
 *
 * Emits:
 *  - 'playlist-settings-request' (long-press) with { detail: { playlistId } }
 *  - 'feeder-add'    (committed left swipe)  with { detail: { playlistId } }
 *  - 'feeder-remove' (committed right swipe) with { detail: { playlistId } }
 */

const SWIPE_THRESHOLD = 80;  // px past which a swipe commits its action
const MAX_SWIPE = 140;       // px the card can be dragged
const DIR_LOCK = 10;         // px of movement before horizontal/vertical intent is locked
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
    return ['name', 'songs-count', 'icon', 'playlist-id', 'swipe-left', 'swipe-right'];
  }

  attributeChangedCallback() {
    this.render();
  }

  connectedCallback() {
    this.render();
    if (!this._eventsAttached) {
      this.attachEvents();
      this._eventsAttached = true;
    }
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
    }

    if (event.cancelable) event.preventDefault(); // own the horizontal gesture

    // Travel is measured along the locked direction only, so moving back past the
    // start point rests the card at 0 instead of dragging it the other way.
    const travel = this.swipeDir === 'left' ? -dx : dx;
    const distance = Math.max(0, Math.min(travel, MAX_SWIPE));
    this.swipeDistance = distance;
    this.isSwipe = distance > 5;

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
    const card = this.shadowRoot.querySelector('.playlist-card');
    if (card) {
      card.classList.remove('dragging');
      card.style.transform = '';
    }
    this.shadowRoot.querySelectorAll('.reveal').forEach(r => r.classList.remove('visible'));
  }

  /**
   * Fire the action for a committed swipe. Left → 'feeder-add', right → 'feeder-remove'.
   * The card snaps back; the host list re-renders from state to reflect the change.
   * @param {'left'|'right'} dir
   */
  commitSwipe(dir) {
    this.resetPosition();
    const playlistId = parseInt(this.getAttribute('playlist-id'), 10);
    const eventName = dir === 'left' ? 'feeder-add' : 'feeder-remove';
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
    this.dispatchEvent(new CustomEvent('playlist-settings-request', {
      detail: { playlistId }, bubbles: true, composed: true
    }));
  }

  render() {
    const name = this.getAttribute('name') || 'Unnamed Playlist';
    const count = parseInt(this.getAttribute('songs-count') || 0);
    const icon = this.getAttribute('icon') || '';
    const countText = `${count} song${count !== 1 ? 's' : ''}`;
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
          border-radius: 12px;
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
          border-radius: 12px;
        }
        .reveal.visible { opacity: 1; }
        .reveal-right { justify-content: flex-end; background: #1db954; }  /* left swipe → add */
        .reveal-left  { justify-content: flex-start; background: #e53935; } /* right swipe → remove */
        .playlist-card {
          position: relative;
          z-index: 1;
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 14px 16px;
          border-radius: 12px;
          background: linear-gradient(135deg, #2a2a2a 0%, #252525 100%);
          border: 1px solid rgba(255, 255, 255, 0.06);
          cursor: pointer;
          transform: translateX(0);
          transition: background 0.2s ease, border-color 0.2s ease, transform 0.3s ease-out;
        }
        .playlist-card.dragging { transition: background 0.2s ease; }
        @media (hover: hover) {
          .playlist-card:hover {
            background: linear-gradient(135deg, #333 0%, #2a2a2a 100%);
            border-color: rgba(29, 185, 84, 0.3);
          }
        }
        .playlist-icon {
          width: 56px;
          height: 56px;
          border-radius: 10px;
          flex-shrink: 0;
          overflow: hidden;
          display: flex;
          align-items: center;
          justify-content: center;
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
        }
        .playlist-meta {
          font-size: 13px;
          color: #888;
          font-weight: 500;
        }
      </style>
      ${rightText ? `<div class="reveal reveal-left"><span>${this.escHtml(rightText)}</span></div>` : ''}
      ${leftText ? `<div class="reveal reveal-right"><span>${this.escHtml(leftText)}</span></div>` : ''}
      <div class="playlist-card">
        <div class="playlist-icon">
          ${iconHtml}
        </div>
        <div class="playlist-info">
          <h4 class="playlist-name">${this.escHtml(name)}</h4>
          <div class="playlist-meta">${countText}</div>
        </div>
      </div>
    `;
  }

  escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

customElements.define('playlist-item', PlaylistItem);
