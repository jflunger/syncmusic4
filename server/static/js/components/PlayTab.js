/**
 * Play tab - Focused music player interface.
 * Usage: <play-tab></play-tab>
 * Emits: 'play-pause', 'next', 'previous', 'seek', 'enqueue-song', 'clear-queue', 'clear-history' events
 */

import appState from '../state/appState.js';
import './LiquidGlass.js';
import './PlaylistItem.js';

/**
 * Cover-collapse tuning.
 *
 * As the user scrolls, the square album cover shrinks to `minHeight`. The
 * title + artist live *between* the cover and the (sticky) scrub bar, so they
 * scroll up and disappear behind the cover while the scrub bar stays pinned
 * just under it.
 *
 * `collapseScrollDistance` is the scroll distance (px) over which the cover
 * finishes collapsing. Tune it so the cover finishes shrinking right as the
 * title + artist have slid behind it — smaller = collapses sooner.
 */
const COVER_COLLAPSE = {
  minHeight: 96,              // collapsed cover height (keeps scaled buttons visible)
  collapseScrollDistance: 220, // scroll px to fully collapse the cover
};

// Movement (px) before a scrub gesture locks its axis. Below this we don't know yet
// whether the finger is scrubbing (horizontal) or scrolling the page (vertical).
const SCRUB_AXIS_LOCK = 6;

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

    // Drag state. A scrub doesn't commit to "I'm a drag" until the finger has moved
    // enough to lock the axis to horizontal — a vertical move releases the gesture so the
    // page scrolls (the scrub strip is full-width and lives under the cover, so swipes
    // routinely begin on it).
    this.isDragging = false;
    this.dragPosition = 0;
    this.progressRect = null;
    this.scrubAxis = null; // null until locked, then 'x' (scrub) or 'y' (scroll)
    this.scrubStartX = 0;
    this.scrubStartY = 0;

    // History list expanded state
    this.historyExpanded = false;

    // Sticky cover scroll state
    this.boundScroll = this.handleScroll.bind(this);
    this._scrollRaf = null;

    // Bound event handlers for cleanup. Pointer events cover mouse *and* touch, so the
    // scrubber drags identically on desktop and mobile.
    this.boundPointerMove = this.handleProgressPointerMove.bind(this);
    this.boundPointerUp = this.handleProgressPointerUp.bind(this);
    // A cancel (browser claimed the gesture for scrolling) must abort the scrub WITHOUT
    // emitting a seek, unlike a normal pointerup.
    this.boundPointerCancel = this.handleProgressPointerCancel.bind(this);
  }

  connectedCallback() {
    this.render();
    this.attachEvents();
    this.loadState();
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

    // Sticky cover scroll handling
    this.setupStickyCover();
  }

  /**
   * Setup scroll listener for sticky cover shrink behavior
   */
  setupStickyCover() {
    const scrollParent = this.getScrollParent();
    if (scrollParent) {
      scrollParent.addEventListener('scroll', this.boundScroll, { passive: true });
      this._scrollParent = scrollParent;
      // Recompute the square side / collapse distance when the viewport resizes.
      window.addEventListener('resize', this.boundScroll, { passive: true });
      // Initial check in case we're already scrolled
      this.handleScroll();
    }
  }

  /**
   * Find the scrollable ancestor (tab-content in MusicApp)
   */
  getScrollParent() {
    let el = this.parentElement;
    while (el) {
      const style = getComputedStyle(el);
      const overflow = style.overflowY || style.overflow;
      if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  /**
   * Handle scroll - shrink the cover proportionally with scroll.
   *
   * The cover is square at rest and collapses to COVER_COLLAPSE.minHeight over
   * COVER_COLLAPSE.collapseScrollDistance px of scroll. Height is driven directly
   * (width is fixed at 100%), so the cover image is only cropped vertically
   * (centered, equal top/bottom) and never squished. An ease (smoothstep) tapers
   * the shrink rate to zero at both ends so the content below transitions
   * smoothly — no velocity "kink".
   *
   * The scrub bar (.progress-wrap) is sticky; we set its `top` to the cover's
   * current height each frame so it stays glued just under the collapsing cover
   * and remains visible at max contraction. The title/artist sit between the
   * cover and the scrub bar, so they scroll up behind the sticky cover.
   *
   * To avoid scroll jitter, the height removed from the sticky cover is added
   * back as host padding-bottom, keeping total scroll height constant.
   */
  handleScroll() {
    if (this.style.display === 'none') return;
    if (this._scrollRaf) return;
    this._scrollRaf = requestAnimationFrame(() => {
      this._scrollRaf = null;
      const scrollParent = this._scrollParent || this.getScrollParent();
      if (!scrollParent) return;

      const coverInner = this.shadowRoot?.querySelector('.cover-inner');
      if (!coverInner) return;

      const minHeight = COVER_COLLAPSE.minHeight;
      const maxHeight = coverInner.offsetWidth; // square side (width is fixed)
      if (!maxHeight) return;
      const distance = Math.max(1, COVER_COLLAPSE.collapseScrollDistance);

      const rawProgress = Math.min(1, Math.max(0, scrollParent.scrollTop / distance));
      const progress = rawProgress * rawProgress * (3 - 2 * rawProgress); // smoothstep
      const height = maxHeight - (maxHeight - minHeight) * progress;

      // Skip redundant layout writes (e.g. resize ticks, or scrolling past full collapse):
      // mutating geometry inside the scroller every frame can stall iOS momentum scrolling.
      if (height === this._lastCoverHeight) return;
      this._lastCoverHeight = height;

      coverInner.style.height = `${height}px`;
      coverInner.style.setProperty('--shrink-progress', String(progress));

      // Glue the sticky scrub bar to the cover's current bottom edge so it pins
      // just below the cover (never behind it) as the cover collapses.
      const progressWrap = this.shadowRoot.querySelector('.progress-wrap');
      if (progressWrap) progressWrap.style.top = `${height}px`;

      // Reclaim the collapsed height so the page's scrollable range is stable.
      this.style.paddingBottom = `${maxHeight - height}px`;
    });
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; height: 100%; margin: 0; padding: 0; box-sizing: content-box; }
        /* Spacer as tall as the bottom nav bar (70px) so the last item can be
           scrolled clear of the bar instead of hiding behind it. */
        .nav-spacer {
          height: calc(70px + env(safe-area-inset-bottom, 0px));
          flex: none;
        }
        .cover-inner {
          --shrink-progress: 0;
          width: 100%;
          /* Square by default; JS overrides height during scroll-collapse.
             Height is driven directly (not aspect-ratio) so width never changes
             and the image is only cropped vertically, never squished. */
          aspect-ratio: 1;
          position: sticky;
          top: 0;
          margin-top: 0;
          z-index: 10;
          overflow: hidden;
          background: #333;
          will-change: height;
        }
        .cover-content {
          width: 100%;
          height: 100%;
          position: relative;
        }
        /* Every cover is normalized to a full-width SQUARE (object-fit: cover
           crops any source aspect ratio into it), centered vertically. The
           square keeps its size as the container collapses, so overflow:hidden
           just clips it equally top/bottom — identical behavior for all covers
           regardless of their original dimensions. */
        .cover-inner .cover-image,
        .cover-inner .cover-placeholder {
          position: absolute;
          left: 0;
          right: 0;
          top: 50%;
          transform: translateY(-50%);
          width: 100%;
          aspect-ratio: 1;
          height: auto;
        }
        .cover-inner .cover-image {
          object-fit: cover;
          object-position: center;
        }
        .cover-inner .cover-placeholder {
          display: flex;
          align-items: center;
          justify-content: center;
          color: #666;
        }
        .control-buttons {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 20px;
        }
        .control-buttons button {
          background: none;
          border: none;
          color: #fff;
          width: 48px;
          height: 48px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          filter: drop-shadow(0 2px 8px rgba(0,0,0,0.5));
        }
        .control-buttons .play-pause-btn { background: transparent; width: 64px; height: 64px; }
        /* Title + artist sit between the cover and the sticky scrub bar, so they
           scroll up behind the sticky cover as it collapses. */
        .song-info { color: #fff; text-align: center; padding: 16px 20px 12px; }
        /* Always a single line so the cover-collapse geometry stays predictable. */
        .song-title {
          font-size: 24px;
          margin: 0 0 8px 0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .song-artist {
          color: #aaa;
          margin: 0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        /* The scrub bar stays pinned just under the cover (JS sets 'top' to the
           cover's current height) so it remains visible at max contraction. */
        .progress-wrap {
          position: sticky;
          top: 96px;
          z-index: 5;
          background: #000;
          /* Generous vertical padding makes the full strip a drag target — the bar
             itself is only 4px tall, too thin to grab on touch. touch-action:pan-y lets
             the browser keep vertical swipes as page scrolls (the strip spans the full
             width under the cover, so scrolls routinely start here) while horizontal
             drags are delivered to the scrubber. */
          padding: 16px 20px;
          display: flex;
          align-items: center;
          justify-content: center;
          touch-action: pan-y;
        }
        .progress { width: 100%; height: 4px; background: #333; border-radius: 2px; position: relative; cursor: pointer; touch-action: pan-y; }
        .progress.dragging { cursor: grabbing; }
        .progress.dragging .progress-bar { background: #8000FF; box-shadow: 0 0 4px rgba(128, 0, 255, 0.5); }
        .progress-bar { height: 100%; background: #8000FF; border-radius: 2px; width: 0%; }
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

      <div class="cover-inner">
        <div class="cover-content">
        ${this.currentSong && this.currentSong.cover ?
          `<img class="cover-image" src="${this.currentSong.cover}" alt="Album cover">` :
          `<div class="cover-placeholder">
            <svg viewBox="0 0 24 24" width="64" height="64" fill="#666">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-5-8h10v2H7v-2z"/>
            </svg>
          </div>`
        }
        <div class="control-buttons">
          <liquid-glass class="glass-prev" src="${this.currentSong?.cover || ''}" style="width:60px;height:60px">
            <button class="prev-btn">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
                <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/>
              </svg>
            </button>
          </liquid-glass>

          <liquid-glass class="glass-play" accent="#8000FF" src="${this.currentSong?.cover || ''}" style="width:88px;height:88px">
            <button class="play-pause-btn">
              ${this.renderPlayPauseIcon()}
            </button>
          </liquid-glass>

          <liquid-glass class="glass-next" src="${this.currentSong?.cover || ''}" style="width:60px;height:60px">
            <button class="next-btn">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
                <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>
              </svg>
            </button>
          </liquid-glass>
        </div>
        </div>
      </div>

      <div class="song-info">
        <h2 class="song-title">${this.currentSong ? this.currentSong.title : 'No song selected'}</h2>
        <p class="song-artist">${this.currentSong ? this.currentSong.artist : 'Unknown artist'}</p>
      </div>

      <div class="progress-wrap">
        <div class="progress">
          <div class="progress-bar" style="width: ${this.getProgressPercent()}%"></div>
        </div>
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
      // Re-sync sticky shrink state after DOM replaced
      this.handleScroll();
    });
  }

  /**
   * Render current song info
   */
  renderCurrentSong() {
    const titleEl = this.shadowRoot.querySelector('.song-title');
    const artistEl = this.shadowRoot.querySelector('.song-artist');
    const coverContent = this.shadowRoot.querySelector('.cover-content');

    if (titleEl) {
      titleEl.textContent = this.currentSong ? this.currentSong.title : 'No song selected';
    }

    if (artistEl) {
      artistEl.textContent = this.currentSong ? this.currentSong.artist : 'Unknown artist';
    }

    if (coverContent) {
      const oldCover = coverContent.querySelector('.cover-image, .cover-placeholder');
      const newCover = this.currentSong && this.currentSong.cover
        ? `<img class="cover-image" src="${this.currentSong.cover}" alt="Album cover">`
        : `<div class="cover-placeholder">
            <svg viewBox="0 0 24 24" width="64" height="64" fill="#666">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-5-8h10v2H7v-2z"/>
            </svg>
          </div>`;
      if (oldCover) oldCover.remove();
      coverContent.insertAdjacentHTML('afterbegin', newCover);
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
    const btn = this.shadowRoot.querySelector('.play-pause-btn');
    if (btn) {
      btn.innerHTML = this.renderPlayPauseIcon();
    }
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
        icon="${(p.icon || '').replace(/"/g, '&quot;')}"
        swipe-right="remove as feeder"
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
   * Update progress bar visual (used during dragging)
   * @param {number} percent - Progress percentage
   */
  updateProgressVisual(percent) {
    const bar = this.shadowRoot.querySelector('.progress-bar');
    if (bar) {
      bar.style.width = `${percent}%`;
    }
  }

  /**
   * Render progress bar
   */
  renderProgress() {
    // Don't update progress bar if currently dragging
    if (this.isDragging) return;

    const bar = this.shadowRoot.querySelector('.progress-bar');
    if (bar) {
      bar.style.width = `${this.getProgressPercent()}%`;
    }
  }

  /**
   * Arm a scrub gesture (pointerdown). We DON'T preventDefault or mark a drag yet — the
   * axis isn't locked, so a vertical swipe that begins here must still scroll the page.
   * Measures against the thin .progress bar even though the pointerdown can land anywhere
   * on the padded .progress-wrap strip.
   * @param {PointerEvent} event
   */
  handleProgressPointerDown(event) {
    if (!this.currentSong || !this.duration) return;

    const progressBar = this.shadowRoot.querySelector('.progress');
    if (!progressBar) return;

    this.isDragging = true;
    this.scrubAxis = null;
    this.scrubStartX = event.clientX;
    this.scrubStartY = event.clientY;
    this.progressRect = progressBar.getBoundingClientRect();
    // Position for the tap-to-seek case (release with no axis lock).
    this.dragPosition = this.positionFromEvent(event);
  }

  /**
   * Track the finger/cursor during a scrub (pointermove). Locks the axis on first
   * meaningful movement: horizontal becomes a scrub (we then preventDefault to own the
   * gesture); vertical releases the drag so the browser scrolls the page.
   * @param {PointerEvent} event
   */
  handleProgressPointerMove(event) {
    if (!this.isDragging || !this.progressRect) return;

    if (!this.scrubAxis) {
      const dx = event.clientX - this.scrubStartX;
      const dy = event.clientY - this.scrubStartY;
      if (Math.abs(dx) < SCRUB_AXIS_LOCK && Math.abs(dy) < SCRUB_AXIS_LOCK) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        // Vertical intent → it's a scroll. Bail; the page keeps scrolling untouched.
        this.isDragging = false;
        this.progressRect = null;
        return;
      }
      this.scrubAxis = 'x';
      this.shadowRoot.querySelector('.progress')?.classList.add('dragging');
    }

    if (event.cancelable) event.preventDefault(); // own the horizontal gesture
    this.dragPosition = this.positionFromEvent(event);
    this.updateProgressVisual(this.dragPosition * 100);
  }

  /**
   * Finish a scrub (pointerup) and emit the seek. A tap with no axis lock lands here too,
   * so tapping the bar seeks just like a drag-release; a gesture that locked to vertical
   * has already released and won't reach here as a drag.
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
   * Abort a scrub (pointercancel) — the browser took the gesture over for scrolling, so
   * restore the bar to the real playback position and emit NO seek.
   */
  handleProgressPointerCancel() {
    if (!this.isDragging) return;
    this.endScrub();
    this.renderProgress();
  }

  /** Clear drag state and the dragging visual. */
  endScrub() {
    const progressBar = this.shadowRoot.querySelector('.progress');
    if (progressBar) progressBar.classList.remove('dragging');
    this.isDragging = false;
    this.scrubAxis = null;
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

  /**
   * Render play/pause icon
   */
  renderPlayPauseIcon() {
    // Explicit width/height + fill are required: iOS Safari collapses an inline SVG
    // that has only a viewBox inside a flex container, hiding the icon entirely.
    return this.isPlaying
      ? '<svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'
      : '<svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  }

  disconnectedCallback() {
    if (this.unsubscribeState) {
      this.unsubscribeState();
    }

    // Clean up drag event listeners
    document.removeEventListener('pointermove', this.boundPointerMove);
    document.removeEventListener('pointerup', this.boundPointerUp);
    document.removeEventListener('pointercancel', this.boundPointerCancel);

    // Clean up sticky cover scroll listener
    if (this._scrollParent) {
      this._scrollParent.removeEventListener('scroll', this.boundScroll);
      this._scrollParent = null;
    }
    window.removeEventListener('resize', this.boundScroll);
  }
}

customElements.define('play-tab', PlayTab);