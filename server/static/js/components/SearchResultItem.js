/**
 * Search / related result row — a <song-item> for an online track. It inherits everything a
 * library row does (queue wedge with position, vinyl cover while queued/playing, tap and
 * swipe-right to enqueue → play next → play now, tap the wedge to remove, long-press to edit
 * once the track is in the library) and adds what we know about the online track: a
 * duration tag on the cover, a metrics line (plays, likes, year, genre) and a round download
 * button that tracks the download's progress (queued → downloading → done, or "in library").
 *
 * A track that isn't downloaded yet is enqueued as a "pending" entry: the player skips it
 * until the download lands (the enqueue starts the download if needed).
 *
 * Usage: <search-result-item title="…" artist="…" source="youtube" cover="…" url="…"
 *          data-track='{"duration":215000,"metrics":{…},"library_song_id":12}'></search-result-item>
 *        data-track is optional; without it the row shows title/artist/source only.
 * Emits: 'download-track' { track } (bubbles) when the download button is tapped.
 *        'enqueue-track' { track, librarySongId } (bubbles) on a tap or committed swipe.
 *        Plus <song-item>'s 'remove-from-queue', 'toggle-play-pause', 'track-edit-request'.
 */

import appState from '../state/appState.js';
import { icon } from '../icons.js';
import { pendingSong } from '../services/QueueManager.js';
import SongItem from './SongItem.js';

const compactNumber = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** Escape text for use inside HTML content or a double-quoted attribute. */
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Milliseconds → "m:ss" (or "h:mm:ss" for long mixes).
 * @param {number} ms
 * @returns {string}
 */
const formatDuration = (ms) => {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};

/** Button face and label per download state. */
const BUTTON_STATES = {
  idle:        { icon: 'downloading',        label: 'Download' },
  queued:      { icon: 'download-queued',    label: 'In download queue' },
  downloading: { icon: 'downloading',        label: 'Downloading' },
  completed:   { icon: 'download-completed', label: 'Downloaded' },
  library:     { icon: 'in-library',         label: 'Already in library' },
  failed:      { icon: 're-download',        label: 'Download failed — tap to retry' },
};

/* Additions on top of <song-item>'s shared sheet, shared by every result row. */
const STYLE = `
  /* Taller than a library row: the metrics line adds one more line of text */
  :host { contain-intrinsic-size: 0 86px; }

  /* Duration tag in the cover's corner, like a video thumbnail; hidden once the cover
     turns into a vinyl (queued / playing) since the corner is gone */
  .duration {
    position: absolute;
    right: 2px;
    bottom: 2px;
    padding: 1px 4px;
    border-radius: 3px;
    background: rgba(0, 0, 0, 0.78);
    color: #fff;
    font-size: 10px;
    font-weight: 600;
    line-height: 1.3;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
    transition: opacity 0.25s;
  }
  .cover.vinyl ~ .duration { opacity: 0; }

  .meta {
    display: flex;
    gap: 10px;
    margin-top: 3px;
    color: #707070;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
  }
  .meta span { display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0; }
  .meta .in-library { color: #1db954; font-weight: 600; }

  /* Round download button; its ring/colour follows the download state */
  .dl {
    position: relative;
    flex-shrink: 0;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: 1.5px solid #3a3a3a;
    background: #141414;
    color: #ddd;
    font-size: 19px;
    display: grid;
    place-items: center;
    padding: 0;
    cursor: pointer;
    transition: background 0.2s, border-color 0.2s, color 0.2s, transform 0.15s;
  }
  .dl:active:not(:disabled) { transform: scale(0.9); }
  @media (hover: hover) { .dl:hover:not(:disabled) { border-color: #1db954; color: #1db954; } }
  .dl:disabled { cursor: default; }
  .dl .face { display: grid; place-items: center; animation: face-in 0.3s ease-out both; }
  @keyframes face-in { from { opacity: 0; transform: scale(0.5); } to { opacity: 1; transform: none; } }

  .dl.queued { color: #ffb74d; border-color: #5a4422; }
  .dl.downloading { color: #64b5f6; border-color: #1f3550; }
  .dl.completed, .dl.library { color: #1db954; border-color: #1a4d2c; background: #0d1f14; }
  .dl.failed { color: #ff6b6b; border-color: #5a2323; }
  /* Spinning arc while the download is waiting or running */
  .dl.queued::after, .dl.downloading::after {
    content: '';
    position: absolute;
    inset: -1.5px;
    border-radius: 50%;
    border: 2px solid transparent;
    border-top-color: currentColor;
    animation: spin 1s linear infinite;
  }
  .dl.queued::after { animation-duration: 2.2s; }
  .dl.downloading .face { animation: face-in 0.3s ease-out both, nudge 1.2s ease-in-out 0.3s infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes nudge { 50% { transform: translateY(2px); } }
  @media (prefers-reduced-motion: reduce) {
    .dl::after, .dl .face { animation: none !important; }
  }
`;

const sheet = new CSSStyleSheet();
sheet.replaceSync(STYLE);

class SearchResultItem extends SongItem {
  constructor() {
    super();
    this.shadowRoot.adoptedStyleSheets = [...this.shadowRoot.adoptedStyleSheets, sheet];
    this.currentStatus = null;
    // The download button: handled here and kept from bubbling into the enqueue tap.
    this.shadowRoot.addEventListener('click', (e) => {
      if (e.target.closest('.dl')) {
        e.stopPropagation();
        if (!this.isSwipe) this.requestDownload();
      }
    });
    // A plain tap on the row enqueues. <song-item> stops the click inside its shadow root
    // for swipes, the queue wedge and the now-playing disc, so only real row taps get here.
    this.addEventListener('click', () => {
      if (this.isLongPress) {
        this.isLongPress = false;
        return;
      }
      this.requestEnqueue();
    });
  }

  static get observedAttributes() {
    return [...super.observedAttributes, 'url', 'data-track'];
  }

  connectedCallback() {
    // Pick up a download that started before this row was (re)rendered.
    this.currentStatus = (appState.get('downloadStatuses') || {})[this.getAttribute('url')] || null;
    super.connectedCallback();
    this.unsubscribeDownloads = appState.subscribe((key, value) => {
      if (key !== 'downloadStatuses') return;
      const status = value[this.getAttribute('url')] || null;
      if (status !== this.currentStatus) {
        this.currentStatus = status;
        this.updateButton();
      }
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.unsubscribeDownloads) this.unsubscribeDownloads();
  }

  /* ---------- identity ---------- */

  /** @returns {Object} Extra track info from data-track (duration, metrics, library_song_id). */
  get extra() {
    try {
      return JSON.parse(this.getAttribute('data-track') || '{}') || {};
    } catch {
      return {};
    }
  }

  /** @returns {Object} The track as the download/enqueue events carry it. */
  get track() {
    return {
      title: this.getAttribute('title') || 'Unknown',
      artist: this.getAttribute('artist') || 'Unknown',
      source: this.getAttribute('source') || 'unknown',
      url: this.getAttribute('url') || '',
      cover: this.getAttribute('cover') || '',
    };
  }

  /**
   * The library song for this result, if we have it (by library_song_id, else by link).
   * Cached per songs-array so queue changes across a result list stay cheap.
   * @returns {Object|null}
   */
  get librarySong() {
    const songs = appState.get('songs') || [];
    if (this._songsRef !== songs) {
      const id = this.extra.library_song_id;
      const url = this.getAttribute('url');
      this._songsRef = songs;
      this._librarySong = songs.find(s => (id ? s.id === id : s.download_link === url) && s.url) || null;
    }
    return this._librarySong;
  }

  /**
   * What <song-item> sees as this row's song: its queue entry if queued (pending or
   * downloaded), else the library song, else a pending song. Its id drives the queue wedge,
   * the vinyl cover and the enqueue label exactly as for a library row.
   * @returns {Object}
   */
  get songData() {
    const url = this.getAttribute('url');
    if (!url) return {};
    const queued = (appState.get('queue') || []).find(s => s.download_link === url);
    return queued || this.librarySong || pendingSong(this.track);
  }

  /** The download button already shows progress, so don't dim the row like a queued pending entry. */
  get isPending() {
    return false;
  }

  /* ---------- actions ---------- */

  /** Ask the host to enqueue this track (it handles pending vs. library + starting the download). */
  requestEnqueue() {
    if (!this.getAttribute('url')) return;
    this.dispatchEvent(new CustomEvent('enqueue-track', {
      detail: { track: this.track, librarySongId: this.librarySong?.id ?? null },
      bubbles: true
    }));
  }

  /** A committed swipe does exactly what a tap does. */
  enqueueFromSwipe() {
    this.requestEnqueue();
  }

  /** @returns {string} Key into BUTTON_STATES for the current download state. */
  get buttonState() {
    if (this.currentStatus && BUTTON_STATES[this.currentStatus]) return this.currentStatus;
    return this.extra.library_song_id ? 'library' : 'idle';
  }

  /** Dispatch the download request (ignored while queued/running/done). */
  requestDownload() {
    if (!['idle', 'failed'].includes(this.buttonState)) return;
    this.dispatchEvent(new CustomEvent('download-track', {
      detail: { track: this.track },
      bubbles: true
    }));
  }

  /* ---------- render hooks ---------- */

  /** @returns {string} Button markup for the current download state. */
  buttonHtml() {
    const state = this.buttonState;
    const { icon: name, label } = BUTTON_STATES[state];
    const busy = state !== 'idle' && state !== 'failed';
    return `<button class="dl ${state}" aria-label="${label}" title="${label}" ${busy ? 'disabled' : ''}><span class="face">${icon(name)}</span></button>`;
  }

  /** Swap just the button (keeps the row and cover image from re-rendering). */
  updateButton() {
    const btn = this.shadowRoot.querySelector('.dl');
    if (btn) btn.outerHTML = this.buttonHtml();
  }

  coverExtraHtml() {
    const { duration } = this.extra;
    return duration ? `<span class="duration">${formatDuration(duration)}</span>` : '';
  }

  /** Metric chips for the line under the artist. */
  detailsExtraHtml() {
    const extra = this.extra;
    const m = extra.metrics || {};
    const chips = [];
    if (extra.library_song_id) chips.push(`<span class="in-library">${icon('in-library')} In library</span>`);
    if (m.plays != null) chips.push(`<span title="Plays">${icon('play-count')} ${compactNumber.format(m.plays)}</span>`);
    if (m.likes != null) chips.push(`<span title="Likes">${icon('like-count')} ${compactNumber.format(m.likes)}</span>`);
    if (m.uploaded_at) chips.push(`<span title="Uploaded">${esc(String(m.uploaded_at).slice(0, 4))}</span>`);
    if (m.genre && m.genre !== 'Music') chips.push(`<span>${esc(m.genre)}</span>`);
    return chips.length ? `<div class="meta">${chips.join('')}</div>` : '';
  }

  trailingHtml() {
    return this.getAttribute('url') ? this.buttonHtml() : '';
  }
}

customElements.define('search-result-item', SearchResultItem);
