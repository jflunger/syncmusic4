/**
 * NextTrack - the single source of truth for "what plays next".
 *
 * It mirrors MusicApp.playNext exactly: the first playable song in the queue (pending tracks —
 * enqueued from search, still downloading — are skipped over, keeping their place), else a *random* song
 * from a random eligible feeder playlist, else nothing. The key difference from resolving at
 * play time is that the random feeder pick is computed up front on a fork of a seedable RNG
 * (see Rng.js), so peek() returns the very song that will play — and only when that song is
 * actually taken do we commit the RNG's advance. This makes the preview (disk slider) and the
 * audio preloader reliable, including for the random case.
 *
 * It extends EventTarget and dispatches a 'change' CustomEvent({ detail: { song } }) whenever
 * the resolved next track changes, so any number of listeners (the disk slider's "next" cover,
 * the dual-element audio preloader) can react without coupling to each other.
 *
 * Usage:
 *   import nextTrack from './services/NextTrack.js';
 *   nextTrack.setPlayable(song => !!song?.url && !failedSongs.has(song.id));
 *   nextTrack.addEventListener('change', e => preload(e.detail.song));
 *   const song = nextTrack.take(); // what playNext should play; advances internal bookkeeping
 *
 * Emits:
 *   'change' - detail: { song: Object|null } - the newly resolved next track (or null).
 */

import appState from '../state/appState.js';
import queueManager from './QueueManager.js';
import Rng from './Rng.js';

class NextTrack extends EventTarget {
  constructor() {
    super();
    this.rng = new Rng();
    this._next = null;          // cached resolved song (or null)
    this._source = null;        // 'queue' | 'feeder' | null
    this._pendingState = null;  // RNG state to commit if the current feeder pick is taken
    // Default predicate; MusicApp injects one that also excludes failed songs.
    this.isPlayable = (song) => !!(song && song.url);

    // Anything that can change "what's next" lives in the reactive store: the queue head, the
    // eligible feeders, the songs inside those feeders, and the current track (taking one
    // advances the queue/RNG). Recompute on each — recompute() is sticky and only dispatches
    // when the resolved track actually changes, so redundant notifications are cheap.
    appState.subscribe((key) => {
      if (key === 'queue' || key === 'playFeeders' || key === 'playlists' || key === 'currentSong') {
        this.recompute();
      }
    });

    this.recompute();
  }

  /**
   * Inject the playability predicate (MusicApp owns failedSongs). Re-resolves immediately.
   * @param {(song: Object) => boolean} fn
   */
  setPlayable(fn) {
    if (typeof fn === 'function') this.isPlayable = fn;
    this.invalidate();
  }

  /**
   * The track that would play next, without consuming it. Drives the disk preview + preloader.
   * @returns {Object|null}
   */
  peek() {
    return this._next;
  }

  /**
   * Return the next track AND do the bookkeeping so the following peek() is correct:
   * a queue pick is dequeued; a feeder pick commits the RNG advance that produced it (so the
   * peeked random song is exactly the one that played). playNext calls this.
   * @returns {Object|null}
   */
  take() {
    const song = this._next;
    if (!song) return null;

    if (this._source === 'queue') {
      queueManager.removeById(song.id);       // removes the entry we handed out (may sit behind pending ones)
    } else if (this._source === 'feeder' && this._pendingState != null) {
      this.rng.setState(this._pendingState);  // commit the draws → next fork starts fresh
    }

    this._next = null;
    this._source = null;
    this._pendingState = null;
    this.recompute();
    return song;
  }

  /**
   * Force a re-resolution that ignores the sticky cache (e.g. after a song was marked failed).
   */
  invalidate() {
    this._next = null;
    this._source = null;
    this._pendingState = null;
    this.recompute();
  }

  /**
   * Re-resolve the next track. The first playable queued song always wins and is deterministic,
   * so it is recomputed cheaply every time (an unplayable entry, e.g. a pending download, is
   * passed over rather than blocking the queue). When the queue is empty the next track is a *random*
   * feeder pick — we keep an existing valid pick rather than re-rolling on every unrelated
   * input change (e.g. a playlists refresh from a sync download), which would make the preview
   * flicker and thrash the preloader. Dispatches 'change' only when the resolved track changes.
   */
  recompute() {
    const head = queueManager.queue.find((s) => this.isPlayable(s));
    if (head) {
      this._set(head, 'queue', null);
      return;
    }

    // No playable queued song: hold the current feeder pick if it's still a valid choice.
    if (this._source === 'feeder' && this._next && this._stillEligibleFeeder(this._next)) {
      return;
    }

    const picked = this._resolveFeeder();
    this._set(picked.song, picked.song ? 'feeder' : null, picked.pendingState);
  }

  /**
   * Compute a random feeder pick on a fork of the RNG (does not advance the committed state).
   * Mirrors MusicApp.pickFeederSong: a random eligible feeder playlist, then a random playable
   * song within it.
   * @returns {{ song: Object|null, pendingState: number|null }}
   */
  _resolveFeeder() {
    const candidates = this._eligibleFeeders();
    if (!candidates.length) return { song: null, pendingState: null };

    const fork = Rng.from(this.rng.getState());
    const playlist = candidates[fork.int(candidates.length)];
    const playable = (playlist.songs || []).filter((s) => this.isPlayable(s));
    const song = playable[fork.int(playable.length)] || null;
    return { song, pendingState: fork.getState() };
  }

  /**
   * Feeder playlists that currently hold at least one playable song.
   * @returns {Array<Object>}
   */
  _eligibleFeeders() {
    const feederIds = appState.get('playFeeders') || [];
    if (!feederIds.length) return [];
    const playlists = appState.get('playlists') || [];
    return playlists.filter((p) =>
      feederIds.includes(p.id) && (p.songs || []).some((s) => this.isPlayable(s))
    );
  }

  /**
   * True if `song` is still playable and still lives in an eligible feeder playlist.
   * @param {Object} song
   * @returns {boolean}
   */
  _stillEligibleFeeder(song) {
    if (!this.isPlayable(song)) return false;
    return this._eligibleFeeders().some((p) => (p.songs || []).some((s) => s.id === song.id));
  }

  /**
   * Update the cache and notify listeners iff the resolved track id changed.
   * @param {Object|null} song
   * @param {'queue'|'feeder'|null} source
   * @param {number|null} pendingState
   */
  _set(song, source, pendingState) {
    const prevId = this._next ? this._next.id : null;
    const newId = song ? song.id : null;
    this._next = song;
    this._source = source;
    this._pendingState = pendingState;
    if (prevId !== newId) {
      this.dispatchEvent(new CustomEvent('change', { detail: { song } }));
    }
  }
}

const nextTrack = new NextTrack();

export default nextTrack;
