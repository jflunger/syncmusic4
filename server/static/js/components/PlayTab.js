/**
 * Play tab - Focused music player interface.
 * Usage: <play-tab></play-tab>
 * Emits: 'play-pause', 'next', 'previous', 'seek', 'enqueue-song', 'clear-queue', 'clear-history',
 *        'track-edit-request' (tap the title slab; detail: { song, origin }) events
 */

import appState from '../state/appState.js';
import './LiquidGlass.js';
import { playlistCoversAttr, playlistPlaytime } from './PlaylistItem.js';

// Fine scrubbing: dragging the finger down below the scrub slab slows the scrub, like
// iOS. Bands by px below the grab point: [max dy, rate, label]. The page never scrolls
// from the scrubber, so vertical movement is free to mean "sensitivity".
const SCRUB_SPEEDS = [
  [40, 1, ''],
  [100, 0.5, 'Half speed'],
  [160, 0.25, 'Quarter speed'],
  [Infinity, 0.1, 'Fine scrubbing'],
];

// Pull-to-reveal: dragging down from the top of the page fades out everything drawn
// over the cover (controls + bottom fade) instead of scrolling. Fully revealed after
// REVEAL_DISTANCE px of pull; on release it fades back in over REVEAL_RETURN_MS.
const REVEAL_DISTANCE = 120;
const REVEAL_RETURN_MS = 250;

class PlayTab extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    this.currentSong = null;
    this.isPlaying = false;
    this.currentTime = 0;
    this.duration = 0;
    this.queue = [];
    this.history = [];
    this.playFeeders = [];  // playlist ids drawn from when the queue empties
    this.playlists = [];    // full playlist data, looked up by feeder id for rendering

    // Drag state. A scrub owns its gesture from the first touch (touch-action: none):
    // horizontal movement moves the position, scaled by a rate that drops as the finger
    // goes down (SCRUB_SPEEDS), so it's integrated from the last X rather than absolute.
    this.isDragging = false;
    this.dragPosition = 0;
    this.progressRect = null;
    this.scrubLastX = 0;
    this.scrubStartY = 0;

    // History list expanded state
    this.historyExpanded = false;

    // Bound event handlers for cleanup. Pointer events cover mouse *and* touch, so the
    // scrubber drags identically on desktop and mobile.
    this.boundPointerMove = this.handleProgressPointerMove.bind(this);
    this.boundPointerUp = this.handleProgressPointerUp.bind(this);
    // A cancel (a system gesture took over) must abort the scrub WITHOUT
    // emitting a seek, unlike a normal pointerup.
    this.boundPointerCancel = this.handleProgressPointerCancel.bind(this);

    // Pull-to-reveal state. revealMode is null until the first move of a touch decides
    // it: 'pull' (downward from the top → reveal) or 'pass' (leave it to the scroller).
    this.revealMode = null;
    this.revealStartY = 0;
    this.revealAmount = 0;
    this._revealRaf = null;
  }

  connectedCallback() {
    this.render();
    this.attachEvents();
    this.loadState();
    this.attachPin();
  }

  /**
   * Keep the title slab fixed on screen like a top bar. It lives in .pin-layer, a
   * position:fixed box laid over where the cover sits at scroll 0 (so the browser
   * pins it natively — no scroll-linked JS). The box's place is measured here and set
   * on the host as --pin-top/left/width, re-measured whenever this tab resizes (which
   * includes becoming visible).
   */
  attachPin() {
    this.pinScroller = this.getScrollParent();
    this.pinObserver = new ResizeObserver(() => this.measurePin());
    this.pinObserver.observe(this);
    if (this.pinScroller) {
      this.boundFadeScroll = () => this.fadeControls();
      this.pinScroller.addEventListener('scroll', this.boundFadeScroll, { passive: true });
    }
  }

  /**
   * Fade the transport buttons and scrubber out as the page scrolls them up under the
   * pinned title slab: each is fully transparent (and stops taking taps) by the time
   * its top reaches the slab's middle. Set on the host as vars/classes so re-renders
   * keep it. Only opacity is scroll-linked — position stays native, so no iOS lag.
   */
  fadeControls() {
    const slot = this.shadowRoot.querySelector('.title-slot');
    const play = this.shadowRoot.querySelector('.glass-play');
    const scrub = this.shadowRoot.querySelector('.scrub-slab');
    if (!slot || !play || !scrub || !this.pinScroller) return;
    const scrollTop = Math.max(0, this.pinScroller.scrollTop);
    const fadeAt = slot.offsetTop + slot.offsetHeight / 2;
    const fade = (el) => Math.max(0, Math.min(1, 1 - scrollTop / Math.max(1, el.offsetTop - fadeAt)));
    const btns = fade(play);
    const scrubber = fade(scrub);
    this.style.setProperty('--fade-btns', btns.toFixed(3));
    this.style.setProperty('--fade-scrub', scrubber.toFixed(3));
    this.classList.toggle('btns-gone', btns < 0.1);
    this.classList.toggle('scrub-gone', scrubber < 0.1);
  }

  /** Measure the cover's scroll-0 viewport box for the fixed pin layer. */
  measurePin() {
    const hero = this.shadowRoot.querySelector('.cover-hero');
    if (!hero) return;
    const r = hero.getBoundingClientRect();
    // No rubber-band in the (shared) scroller while this tab shows: reaching the top
    // hands the gesture to pull-to-reveal instead of bouncing (see handleRevealMove).
    if (this.pinScroller) this.pinScroller.style.overscrollBehaviorY = r.width ? 'none' : '';
    if (!r.width) return; // tab hidden
    const scrollTop = this.pinScroller ? this.pinScroller.scrollTop : 0;
    this.style.setProperty('--pin-top', `${r.top + scrollTop}px`);
    this.style.setProperty('--pin-left', `${r.left}px`);
    this.style.setProperty('--pin-width', `${r.width}px`);
  }

  /**
   * Load state listeners
   */
  loadState() {
    this.unsubscribeState = appState.subscribe((key, value) => {
      if (key === 'currentSong') {
        this.currentSong = value;
        this.renderCurrentSong();
      }
      if (key === 'isPlaying') {
        this.isPlaying = value;
        this.renderPlayPause();
      }
      if (key === 'currentTime') {
        this.currentTime = value;
        this.renderProgress();
      }
      if (key === 'duration') {
        this.duration = value;
        this.renderProgress();
      }
      if (key === 'queue') {
        this.queue = value;
        this.renderQueue();
      }
      if (key === 'history') {
        this.history = value;
        this.renderHistory();
      }
      if (key === 'playFeeders') {
        this.playFeeders = value;
        this.renderFeeders();
      }
      if (key === 'playlists') {
        this.playlists = value;
        this.renderFeeders();
      }
    });

    this.currentSong = appState.get('currentSong');
    this.isPlaying = appState.get('isPlaying');
    this.currentTime = appState.get('currentTime');
    this.duration = appState.get('duration');
    this.queue = appState.get('queue');
    this.history = appState.get('history');
    this.playFeeders = appState.get('playFeeders');
    this.playlists = appState.get('playlists');
    this.render();
  }

  /**
   * Attach event listeners
   */
  attachEvents() {
    // Tap the title slab → open the track editor, grown out of the slab. The slab's
    // pin layer ignores pointers (so the page scrolls under it), so hit-test the tap
    // here, in the capture phase, before whatever lies beneath the slab acts on it.
    this.shadowRoot.addEventListener('click', (event) => {
      if (this.hitsSongSlab(event)) {
        event.stopPropagation();
        event.preventDefault();
        this.openTrackEditor();
      }
    }, true);

    this.shadowRoot.addEventListener('click', (event) => {
      const target = event.target;

      if (target.classList.contains('play-pause-btn') || target.closest('.play-pause-btn')) {
        this.dispatchEvent(new CustomEvent('play-pause', { bubbles: true, composed: true }));
      }

      if (target.classList.contains('next-btn') || target.closest('.next-btn')) {
        this.dispatchEvent(new CustomEvent('next', { bubbles: true, composed: true }));
      }

      if (target.closest('.clear-queue-btn')) {
        if (confirm('Clear the queue? This removes all upcoming songs.')) {
          this.dispatchEvent(new CustomEvent('clear-queue', { bubbles: true, composed: true }));
        }
        return;
      }

      if (target.closest('.clear-history-btn')) {
        if (confirm('Clear recently played? This cannot be undone.')) {
          this.dispatchEvent(new CustomEvent('clear-history', { bubbles: true, composed: true }));
        }
        return;
      }

      if (target.classList.contains('history-show-more') || target.closest('.history-show-more')) {
        this.historyExpanded = true;
        this.renderHistory();
      }

      if (target.classList.contains('prev-btn') || target.closest('.prev-btn')) {
        this.dispatchEvent(new CustomEvent('previous', { bubbles: true, composed: true }));
      }

      // Handle song-item click -> enqueue (bubbles to MusicApp)
      const songItem = target.closest('song-item');
      if (songItem && !target.closest('.remove-button')) {
        const songData = JSON.parse(songItem.getAttribute('data-song') || '{}');
        if (songData.id) {
          this.dispatchEvent(new CustomEvent('enqueue-song', {
            detail: { song: songData },
            bubbles: true,
            composed: true
          }));
        }
      }

    });

    // Scrubbing: a pointerdown anywhere on the padded scrub strip starts a drag; a tap
    // (down + up with no move) seeks on release. Pointer events fire for both mouse and
    // touch, so this is the single path for desktop and mobile.
    this.shadowRoot.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.progress-wrap')) {
        this.handleProgressPointerDown(event);
      }
    });

    // Move/end on document so the drag keeps tracking even when the finger/cursor leaves
    // the thin bar.
    document.addEventListener('pointermove', this.boundPointerMove);
    document.addEventListener('pointerup', this.boundPointerUp);
    document.addEventListener('pointercancel', this.boundPointerCancel);

    // Pull-to-reveal. touchmove must be non-passive so a downward pull can cancel the
    // page's scroll and drive the reveal instead.
    this.addEventListener('touchstart', (e) => this.handleRevealStart(e), { passive: true });
    this.addEventListener('touchmove', (e) => this.handleRevealMove(e), { passive: false });
    this.addEventListener('touchend', () => this.handleRevealEnd());
    this.addEventListener('touchcancel', () => this.handleRevealEnd());
  }

  /**
   * Find the scrollable ancestor (tab-content in MusicApp).
   * @returns {HTMLElement|null}
   */
  getScrollParent() {
    let el = this.parentElement;
    while (el) {
      const overflow = getComputedStyle(el).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') return el;
      el = el.parentElement;
    }
    return null;
  }

  /**
   * Begin tracking a touch for pull-to-reveal.
   * @param {TouchEvent} e
   */
  handleRevealStart(e) {
    cancelAnimationFrame(this._momentumRaf);
    if (e.touches.length !== 1) { this.revealMode = 'pass'; return; }
    cancelAnimationFrame(this._revealRaf);
    this.revealMode = null;
    this.revealStartY = this.revealLastY = e.touches[0].clientY;
    this.revealSamples = [];
  }

  /**
   * One gesture flows between scrolling and revealing:
   * - 'scroll': native scrolling. If it reaches the top while the finger keeps moving
   *   down, it becomes a pull from that point instead of overscrolling.
   * - 'pull': the finger's distance below the pull origin maps to reveal amount. Moving
   *   back above the origin scrolls the page with the finger (we drive scrollTop, since
   *   the gesture's native scroll was cancelled), with momentum on release.
   * revealNative marks a pull entered mid-scroll whose touchmoves can't be cancelled
   * (iOS): the browser keeps scrolling it, so we only drive the reveal.
   * @param {TouchEvent} e
   */
  handleRevealMove(e) {
    if (this.revealMode === 'pass' || this.isDragging) return;
    const y = e.touches[0].clientY;
    const scroller = this.pinScroller;
    const atTop = !scroller || scroller.scrollTop <= 0;
    const movingDown = y > this.revealLastY;
    this.revealLastY = y;

    if (this.revealMode === null) {
      if (y === this.revealStartY) return;
      this.revealMode = movingDown && atTop ? 'pull' : 'scroll';
      this.revealNative = false;
    } else if (this.revealMode === 'scroll' && atTop && movingDown) {
      this.revealMode = 'pull';
      this.revealStartY = y;
      this.revealNative = !e.cancelable;
    }
    if (this.revealMode !== 'pull') return;

    if (!this.revealNative && e.cancelable) e.preventDefault();
    const dy = y - this.revealStartY;
    this.setReveal(Math.min(1, Math.max(0, dy / REVEAL_DISTANCE)));
    if (this.revealNative || !scroller) return;
    scroller.scrollTop = Math.max(0, -dy);
    const now = performance.now();
    this.revealSamples.push({ t: now, y });
    while (this.revealSamples.length > 2 && now - this.revealSamples[0].t > 100) this.revealSamples.shift();
  }

  /**
   * Finger lifted: fade the covering elements back in, and if the pull turned into a
   * scroll we were driving, carry on with momentum.
   */
  handleRevealEnd() {
    const wasDriving = this.revealMode === 'pull' && !this.revealNative;
    this.revealMode = null;
    if (wasDriving) this.startMomentum();
    if (this.revealAmount <= 0) return;
    const from = this.revealAmount;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / REVEAL_RETURN_MS);
      this.setReveal(from * (1 - t) * (1 - t)); // ease-out
      if (t < 1) this._revealRaf = requestAnimationFrame(step);
    };
    this._revealRaf = requestAnimationFrame(step);
  }

  /**
   * Fling the scroller with the finger's release velocity, decaying like iOS
   * (0.998/ms). Stopped by the next touch.
   */
  startMomentum() {
    const samples = this.revealSamples || [];
    const scroller = this.pinScroller;
    if (!scroller || samples.length < 2 || scroller.scrollTop <= 0) return;
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (performance.now() - last.t > 60) return; // finger paused before lifting
    let v = -(last.y - first.y) / Math.max(1, last.t - first.t); // px/ms of scroll
    let prev = performance.now();
    const step = (now) => {
      const dt = now - prev;
      prev = now;
      const before = scroller.scrollTop;
      scroller.scrollTop = before + v * dt;
      v *= Math.pow(0.998, dt);
      if (Math.abs(v) > 0.02 && scroller.scrollTop !== before) {
        this._momentumRaf = requestAnimationFrame(step);
      }
    };
    this._momentumRaf = requestAnimationFrame(step);
  }

  /**
   * Apply reveal amount (0 = normal, 1 = cover fully uncovered) via the --reveal var.
   * @param {number} amount
   */
  setReveal(amount) {
    this.revealAmount = amount;
    this.style.setProperty('--reveal', String(amount));
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; height: 100%; margin: 0; padding: 0; box-sizing: content-box; }
        /* Spacer so the last item can be scrolled clear of the bottom nav bar. Sized to
           the bar's full box (100px incl. the now-playing disc, plus MusicApp's
           --nav-lift) with 24px to spare — not its 70px visual height, and not relying on
           the scroller's padding-bottom, which WebKit ignores in scroll containers. */
        .nav-spacer {
          height: calc(124px + var(--nav-lift, 0px) + env(safe-area-inset-bottom, 0px));
          flex: none;
        }
        /* Cover hero: a full-width square at the top of the page with the album
           art as its background. It scrolls away with the page like any other
           content; the bottom fades into the page black so the title blends in. */
        .cover-hero {
          position: relative;
          width: 100%;
          aspect-ratio: 1;
          background-color: #333;
          /* The fade is a background layer over the cover in the same box (not a
             separate overlay element) so fractional-pixel rounding can't leave a
             sliver of unfaded cover showing at the bottom edge. --cover is set
             inline from the current song. */
          background-image:
            linear-gradient(to bottom, rgba(0,0,0,0) 65%, rgba(0,0,0,calc(1 - var(--reveal, 0))) 99%),
            var(--cover, none);
          background-size: 100% 100%, cover;
          background-position: center;
          background-repeat: no-repeat;
        }
        /* Gaussian blur over the whole cover (and its bottom fade). Uses
           backdrop-filter so it blurs whatever the hero paints beneath it; fades
           out with --reveal so pull-to-reveal shows the sharp cover. */
        .cover-blur {
          position: absolute;
          inset: 0;
          -webkit-backdrop-filter: blur(12px);
          backdrop-filter: blur(12px);
          opacity: calc(1 - var(--reveal, 0));
          pointer-events: none;
        }
        .cover-placeholder {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .cover-hero.has-cover .cover-placeholder { display: none; }
        /* Overlay stacking title slab, controls and scrubber slab on the cover. It's a
           grid (not nested flex rows) so every <liquid-glass> is a direct child of a box
           the size of the cover — the glass maps the cover image against its parent.
           .pin-layer repeats the same grid (with placeholders) so its title slab lands
           exactly on the title slot here. */
        .hero-stack, .pin-layer {
          display: grid;
          grid-template-columns: 26% 36% 26%;
          column-gap: 2%;
          row-gap: 3%;
          justify-content: center;
          align-content: center;
          /* Pull-to-reveal fades the overlay out with the bottom fade. */
          opacity: calc(1 - var(--reveal, 0));
        }
        .hero-stack {
          position: absolute;
          inset: 0;
          z-index: 1;
        }
        /* Fixed, cover-sized box over the cover's scroll-0 spot (see measurePin). Only
           the title slab inside is visible; it stays put while the page scrolls under it.
           Above the list (song items use z-index up to 3); not interactive, so taps fall
           through to whatever scrolls beneath. */
        .pin-layer {
          position: fixed;
          top: var(--pin-top, 0px);
          left: var(--pin-left, 0px);
          width: var(--pin-width, 100%);
          height: var(--pin-width, 100vw);
          z-index: 5;
          pointer-events: none;
        }
        /* Placeholders keeping both grids' rows identical: the title slot in the hero,
           the button row and scrubber row in the pin layer. */
        .title-slot { grid-column: 1 / -1; height: var(--slab-h); }
        .button-slot { grid-column: 2; aspect-ratio: 1; }
        .scrub-slot { grid-column: 1 / -1; height: 56px; }
        /* The glass is the icon: big icon-shaped glass, sized off the cover width. */
        .hero-stack .glass-btn {
          aspect-ratio: 1; width: 100%; align-self: center;
          /* Scrolled away under the pinned title slab (see fadeControls). */
          opacity: var(--fade-btns, 1);
        }
        .hero-stack .scrub-slab { opacity: var(--fade-scrub, 1); }
        :host(.btns-gone) .glass-btn, :host(.scrub-gone) .scrub-slab { pointer-events: none; }
        /* Invisible hit target covering the whole glass. */
        .hero-stack .glass-btn button {
          background: none;
          border: none;
          padding: 0;
          width: 100%;
          height: 100%;
          cursor: pointer;
          -webkit-tap-highlight-color: transparent;
        }
        /* Title + artist (above the controls) and the scrubber (below) on frosted glass
           slabs spanning the button row. Slabs size to their content's height. */
        .song-slab, .scrub-slab {
          grid-column: 1 / -1;
          display: block;
        }
        /* Fixed line heights give the title slab a known height (--slab-h), which its
           placeholder in the hero grid must match. */
        :host { --slab-h: 96px; }
        .song-info {
          color: #fff;
          text-align: center;
          box-sizing: border-box;
          height: var(--slab-h);
          padding: 22px 32px;
          text-shadow: 0 1px 4px rgba(0,0,0,0.35);
        }
        .song-title {
          font-size: 20px;
          line-height: 26px;
          margin: 0 0 6px 0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .song-artist {
          color: rgba(255,255,255,0.75);
          font-size: 16px;
          line-height: 20px;
          margin: 0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .progress-wrap {
          /* The whole slab is the scrubber. touch-action:none: a gesture that starts
             here never scrolls the page — dragging down instead slows the scrub. */
          height: 56px;
          cursor: pointer;
          touch-action: none;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .progress-wrap.dragging { cursor: grabbing; }
        /* Seek time + speed, shown while scrubbing. */
        .scrub-label {
          color: #fff;
          font-size: 14px;
          font-variant-numeric: tabular-nums;
          text-shadow: 0 1px 4px rgba(0,0,0,0.5);
          opacity: 0;
          transition: opacity 120ms;
          pointer-events: none;
        }
        .progress-wrap.dragging .scrub-label { opacity: 1; }
        .queue { margin-top: 40px; }
        .queue-title { color: #fff; font-size: 18px; margin-bottom: 20px; text-align: center; }
        /* Section header: centered title with a "Clear" affordance pinned to the right. */
        .section-head { position: relative; margin-bottom: 20px; }
        .section-head .queue-title { margin-bottom: 0; }
        .clear-btn {
          position: absolute;
          right: 16px;
          top: 50%;
          transform: translateY(-50%);
          background: none;
          border: 1px solid #444;
          color: #aaa;
          border-radius: 14px;
          padding: 4px 12px;
          font-size: 12px;
          cursor: pointer;
        }
        @media (hover: hover) { .clear-btn:hover { color: #fff; border-color: #8000FF; } }
        .clear-btn.hidden { display: none; }
        .queue-list { max-height: 300px; overflow-y: auto; }
        .queue-list song-item, .history-list song-item {
          border-radius: 0;
        }
        .history-list { overflow-y: visible; }
        .history.expanded .history-list {
          max-height: 320px;
          overflow-y: auto;
        }
        .history-show-more {
          display: block;
          color: #8000FF;
          text-align: center;
          padding: 10px;
          cursor: pointer;
          font-size: 14px;
          background: none;
          border: none;
          width: 100%;
        }
        @media (hover: hover) { .history-show-more:hover { color: #9940FF; } }
        .feeders { margin-top: 40px; }
        .feeder-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding: 0 16px;
        }
        .feeder-hint {
          color: #aaa;
          text-align: center;
          font-size: 14px;
          padding: 0 24px;
        }
      </style>

      <div class="cover-hero ${this.currentSong?.cover ? 'has-cover' : ''}"${this.coverStyle()}>
        <div class="cover-placeholder">
          <svg viewBox="0 0 24 24" width="64" height="64" fill="#666">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-5-8h10v2H7v-2z"/>
          </svg>
        </div>
        <div class="cover-blur"></div>
        <div class="hero-stack">
          <div class="title-slot"></div>
          <liquid-glass class="glass-btn glass-prev" shape="prev" src="${this.currentSong?.cover || ''}">
            <button class="prev-btn" aria-label="Previous"></button>
          </liquid-glass>
          <liquid-glass class="glass-btn glass-play" shape="${this.isPlaying ? 'pause' : 'play'}" accent="#8000FF" src="${this.currentSong?.cover || ''}">
            <button class="play-pause-btn" aria-label="${this.isPlaying ? 'Pause' : 'Play'}"></button>
          </liquid-glass>
          <liquid-glass class="glass-btn glass-next" shape="next" src="${this.currentSong?.cover || ''}">
            <button class="next-btn" aria-label="Next"></button>
          </liquid-glass>
          <liquid-glass class="scrub-slab" shape="slab" blur="22" accent="#000000" fill-color="#8000FF" fill="${this.getProgressPercent() / 100}" src="${this.currentSong?.cover || ''}">
            <div class="progress-wrap" role="slider" aria-label="Seek"><span class="scrub-label"></span></div>
          </liquid-glass>
        </div>
      </div>

      <div class="pin-layer">
        <liquid-glass class="song-slab" shape="slab" blur="22" accent="#000000" src="${this.currentSong?.cover || ''}">
          <div class="song-info">
            <h2 class="song-title">${this.currentSong ? this.currentSong.title : 'No song selected'}</h2>
            <p class="song-artist">${this.currentSong ? this.currentSong.artist : 'Unknown artist'}</p>
          </div>
        </liquid-glass>
        <div class="button-slot"></div>
        <div class="scrub-slot"></div>
      </div>

      <div class="history ${this.historyExpanded ? 'expanded' : ''}">
        <div class="section-head">
          <h3 class="queue-title">Recently Played</h3>
          <button type="button" class="clear-btn clear-history-btn ${this.history && this.history.length ? '' : 'hidden'}">Clear</button>
        </div>
        <div class="history-list">
          ${this.renderHistoryItems()}
        </div>
      </div>

      <div class="queue">
        <div class="section-head">
          <h3 class="queue-title">Up Next</h3>
          <button type="button" class="clear-btn clear-queue-btn ${this.queue && this.queue.length ? '' : 'hidden'}">Clear</button>
        </div>
        <div class="queue-list">
          ${this.renderQueueItems()}
        </div>
      </div>

      <div class="feeders">
        <h3 class="queue-title">Feeders</h3>
        <div class="feeder-list">
          ${this.renderFeederItems()}
        </div>
      </div>
      <div class="nav-spacer"></div>
    `;

    requestAnimationFrame(() => {
      this.setSongItemAttributes(
        this.shadowRoot.querySelectorAll('.queue-list song-item'),
        this.queue || []
      );
      this.setSongItemAttributes(
        this.shadowRoot.querySelectorAll('.history-list song-item'),
        (this.history || []).slice(0, 10)
      );
    });
  }

  /**
   * Whether a pointer event landed on the title slab's visible glass.
   * @param {MouseEvent} event
   * @returns {boolean}
   */
  hitsSongSlab(event) {
    const slab = this.shadowRoot.querySelector('.song-slab');
    if (!slab || slab.style.visibility === 'hidden') return false;
    const r = slab.getBoundingClientRect();
    const inset = this.slabInset(r);
    return event.clientX >= r.left + inset && event.clientX <= r.right - inset
      && event.clientY >= r.top + inset && event.clientY <= r.bottom - inset;
  }

  /**
   * The slab shader draws its glass inset from the element edge (room for the shadow):
   * SLAB_INSET (0.25) shape units, a unit being half the short side; corners 0.45 units.
   * @param {DOMRect} rect - The slab's bounding box
   * @returns {number} inset in px
   */
  slabInset(rect) {
    return 0.25 * Math.min(rect.width, rect.height) / 2;
  }

  /** Ask the app to open the track editor for the current song, growing out of the slab. */
  openTrackEditor() {
    const song = this.currentSong;
    if (!song?.id) return;
    const slab = this.shadowRoot.querySelector('.song-slab');
    const rect = slab.getBoundingClientRect();
    const unit = Math.min(rect.width, rect.height) / 2;
    this.dispatchEvent(new CustomEvent('track-edit-request', {
      detail: { song, origin: { el: slab, inset: this.slabInset(rect), radius: 0.45 * unit } },
      bubbles: true,
      composed: true
    }));
  }

  /**
   * Inline style attribute that sets the current cover as the hero background.
   * @returns {string}
   */
  coverStyle() {
    const cover = this.currentSong?.cover;
    return cover ? ` style="--cover: url(&quot;${cover}&quot;)"` : '';
  }

  /**
   * Render current song info
   */
  renderCurrentSong() {
    const titleEl = this.shadowRoot.querySelector('.song-title');
    const artistEl = this.shadowRoot.querySelector('.song-artist');
    const hero = this.shadowRoot.querySelector('.cover-hero');

    if (titleEl) {
      titleEl.textContent = this.currentSong ? this.currentSong.title : 'No song selected';
    }

    if (artistEl) {
      artistEl.textContent = this.currentSong ? this.currentSong.artist : 'Unknown artist';
    }

    if (hero) {
      const cover = this.currentSong?.cover || '';
      hero.classList.toggle('has-cover', !!cover);
      if (cover) hero.style.setProperty('--cover', `url("${cover}")`);
      else hero.style.removeProperty('--cover');
    }

    const coverSrc = this.currentSong?.cover || '';
    this.shadowRoot.querySelectorAll('liquid-glass').forEach(el => {
      el.setAttribute('src', coverSrc);
    });
  }

  /**
   * Render play/pause button
   */
  renderPlayPause() {
    const glass = this.shadowRoot.querySelector('.glass-play');
    const btn = this.shadowRoot.querySelector('.play-pause-btn');
    if (glass) glass.setAttribute('shape', this.isPlaying ? 'pause' : 'play');
    if (btn) btn.setAttribute('aria-label', this.isPlaying ? 'Pause' : 'Play');
  }

  /**
   * Render queue items using song-item (matches curate track subtab style)
   */
  renderQueueItems() {
    if (!this.queue || this.queue.length === 0) {
      return '<p style="color: #aaa; text-align: center;">Queue is empty</p>';
    }
    return this.queue.map((song) =>
      `<song-item
        data-song-id="${song.id}"
        data-song='${JSON.stringify(song).replace(/'/g, '&#39;')}'
      ></song-item>`
    ).join('');
  }

  /**
   * Render queue
   */
  renderQueue() {
    const queueList = this.shadowRoot.querySelector('.queue-list');
    if (queueList) {
      queueList.innerHTML = this.renderQueueItems();
      this.setSongItemAttributes(queueList.querySelectorAll('song-item'), this.queue);
    }
    const clearBtn = this.shadowRoot.querySelector('.clear-queue-btn');
    if (clearBtn) clearBtn.classList.toggle('hidden', !(this.queue && this.queue.length));
  }

  /**
   * Render the feeder playlists (drawn from when the queue empties). Each is a
   * playlist-item with right-swipe enabled to remove it as a feeder. Feeder ids
   * are resolved to full playlist data; ids with no matching playlist are skipped.
   */
  renderFeederItems() {
    const ids = this.playFeeders || [];
    const byId = new Map((this.playlists || []).map(p => [p.id, p]));
    const items = ids.map(id => byId.get(id)).filter(Boolean);
    if (!items.length) {
      return '<p class="feeder-hint">No feeders yet. Swipe a playlist left in Curate to add one — when the queue empties, a random song from a random feeder plays.</p>';
    }
    return items.map(p =>
      `<playlist-item
        playlist-id="${p.id}"
        name="${(p.name || '').replace(/"/g, '&quot;')}"
        songs-count="${p.songs ? p.songs.length : 0}"
        playtime="${playlistPlaytime(p)}"
        feeder="true"
        icon="${(p.icon || '').replace(/"/g, '&quot;')}"
        covers="${playlistCoversAttr(p)}"
        swipe-left="remove as feeder"
      ></playlist-item>`
    ).join('');
  }

  /**
   * Re-render just the feeder list (on playFeeders / playlists change).
   */
  renderFeeders() {
    const list = this.shadowRoot.querySelector('.feeder-list');
    if (list) list.innerHTML = this.renderFeederItems();
  }

  /**
   * Render history items using song-item (matches curate track subtab style)
   * Collapsed: show first item + "show more". Expanded: show all in scrollable list.
   */
  renderHistoryItems() {
    if (!this.history || this.history.length === 0) {
      return '<p style="color: #aaa; text-align: center;">No recently played songs</p>';
    }
    const songs = this.history.slice(0, 10);
    if (!this.historyExpanded) {
      const first = songs[0];
      const showMore = songs.length > 1
        ? `<button type="button" class="history-show-more">Show more</button>`
        : '';
      return `<song-item
        data-song-id="${first.id}"
        data-song='${JSON.stringify(first).replace(/'/g, '&#39;')}'
      ></song-item>${showMore}`;
    }
    return songs.map((song) =>
      `<song-item
        data-song-id="${song.id}"
        data-song='${JSON.stringify(song).replace(/'/g, '&#39;')}'
      ></song-item>`
    ).join('');
  }

  /**
   * Render history
   */
  renderHistory() {
    const historyEl = this.shadowRoot.querySelector('.history');
    const historyList = this.shadowRoot.querySelector('.history-list');
    if (historyEl && historyList) {
      historyEl.classList.toggle('expanded', this.historyExpanded);
      historyList.innerHTML = this.renderHistoryItems();
      const items = historyList.querySelectorAll('song-item');
      const songs = (this.history || []).slice(0, this.historyExpanded ? 10 : 1);
      this.setSongItemAttributes(items, songs);
    }
    const clearBtn = this.shadowRoot.querySelector('.clear-history-btn');
    if (clearBtn) clearBtn.classList.toggle('hidden', !(this.history && this.history.length));
  }

  /**
   * Set title, artist, cover, source on song-item elements
   */
  setSongItemAttributes(items, songs) {
    items.forEach((item, i) => {
      const song = songs[i];
      if (song) {
        item.setAttribute('title', song.title || 'Unknown');
        item.setAttribute('artist', song.artist || 'Unknown');
        item.setAttribute('cover', song.cover || '');
        item.setAttribute('source', song.source || 'unknown');
      }
    });
  }

  /**
   * Get progress percentage
   */
  getProgressPercent() {
    if (!this.currentSong || !this.duration) return 0;
    return (this.currentTime / this.duration) * 100;
  }

  /**
   * Update the scrub slab's purple fill (the slab itself is the progress bar)
   * @param {number} percent - Progress percentage
   */
  updateProgressVisual(percent) {
    const slab = this.shadowRoot.querySelector('.scrub-slab');
    if (slab) slab.setAttribute('fill', (percent / 100).toFixed(4));
  }

  /**
   * Render progress bar
   */
  renderProgress() {
    // Don't update progress bar if currently dragging
    if (this.isDragging) return;

    this.updateProgressVisual(this.getProgressPercent());
  }

  /**
   * Start a scrub (pointerdown): jump to the finger and own the gesture.
   * Measures against the glass outline of the scrub slab, which the shader insets from
   * the element by 1/8 of its height on each side (SLAB_INSET in LiquidGlass).
   * @param {PointerEvent} event
   */
  handleProgressPointerDown(event) {
    if (!this.currentSong || !this.duration) return;

    const slab = this.shadowRoot.querySelector('.scrub-slab');
    if (!slab) return;

    if (event.cancelable) event.preventDefault();
    this.isDragging = true;
    this.scrubLastX = event.clientX;
    this.scrubStartY = event.clientY;
    const rect = slab.getBoundingClientRect();
    const inset = rect.height / 8;
    this.progressRect = { left: rect.left + inset, width: rect.width - 2 * inset };
    this.dragPosition = this.positionFromEvent(event);
    this.shadowRoot.querySelector('.progress-wrap')?.classList.add('dragging');
    this.showScrub(SCRUB_SPEEDS[0]);
  }

  /**
   * Track the finger/cursor during a scrub (pointermove). Horizontal movement advances
   * the position at the speed picked by how far below the grab point the finger is.
   * @param {PointerEvent} event
   */
  handleProgressPointerMove(event) {
    if (!this.isDragging || !this.progressRect) return;
    if (event.cancelable) event.preventDefault();

    const below = event.clientY - this.scrubStartY;
    const speed = SCRUB_SPEEDS.find(([maxDy]) => below < maxDy);
    const dx = event.clientX - this.scrubLastX;
    this.scrubLastX = event.clientX;
    this.dragPosition = Math.max(0, Math.min(1, this.dragPosition + (dx / this.progressRect.width) * speed[1]));
    this.showScrub(speed);
  }

  /**
   * Paint the drag position: slab fill plus the "time · speed" label.
   * @param {Array} speed - SCRUB_SPEEDS entry in effect
   */
  showScrub(speed) {
    this.updateProgressVisual(this.dragPosition * 100);
    const label = this.shadowRoot.querySelector('.scrub-label');
    if (!label) return;
    const time = this.formatTime(this.dragPosition * this.duration);
    label.textContent = speed[2] ? `${time} · ${speed[2]}` : time;
  }

  /**
   * Format seconds as m:ss.
   * @param {number} seconds
   * @returns {string}
   */
  formatTime(seconds) {
    const s = Math.floor(seconds);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  /**
   * Finish a scrub (pointerup) and emit the seek. A plain tap lands here too, so
   * tapping the slab seeks to that spot.
   */
  handleProgressPointerUp() {
    if (!this.isDragging) return;
    this.endScrub();

    const seekTime = this.dragPosition * this.duration;
    this.dispatchEvent(new CustomEvent('seek', {
      bubbles: true,
      composed: true,
      detail: { time: seekTime }
    }));
  }

  /**
   * Abort a scrub (pointercancel, e.g. a system gesture took over) — restore the bar to
   * the real playback position and emit NO seek.
   */
  handleProgressPointerCancel() {
    if (!this.isDragging) return;
    this.endScrub();
    this.renderProgress();
  }

  /** Clear drag state and the dragging visual. */
  endScrub() {
    this.shadowRoot.querySelector('.progress-wrap')?.classList.remove('dragging');
    this.isDragging = false;
    this.progressRect = null;
  }

  /**
   * Clamp a pointer event's X to a 0..1 fraction along the cached progress bar rect.
   * @param {PointerEvent} event
   * @returns {number}
   */
  positionFromEvent(event) {
    const x = event.clientX - this.progressRect.left;
    return Math.max(0, Math.min(1, x / this.progressRect.width));
  }

  disconnectedCallback() {
    if (this.unsubscribeState) {
      this.unsubscribeState();
    }
    if (this.pinObserver) this.pinObserver.disconnect();
    if (this.pinScroller) this.pinScroller.style.overscrollBehaviorY = '';
    cancelAnimationFrame(this._momentumRaf);
    if (this.boundFadeScroll) this.pinScroller.removeEventListener('scroll', this.boundFadeScroll);

    // Clean up drag event listeners
    document.removeEventListener('pointermove', this.boundPointerMove);
    document.removeEventListener('pointerup', this.boundPointerUp);
    document.removeEventListener('pointercancel', this.boundPointerCancel);
  }
}

customElements.define('play-tab', PlayTab);