/**
 * PlaybackController - the single interface for all playback transitions.
 *
 * It owns the two <audio> elements used for gapless playback (one "active" element the user
 * hears, one idle element pre-buffering the resolved next track) and is the ONLY place that
 * starts, stops, or switches a track. Every entry point routes here:
 *   - in-app controls (Play tab buttons, the now-playing vinyl tap/swipe)
 *   - OS / lock-screen controls (Media Session: play, pause, previoustrack, nexttrack, seekto)
 *   - automatic advance when a track ends or fails
 * Because there is exactly one code path per action, the lock screen and the in-app buttons
 * can never drift out of sync.
 *
 * State is published to the reactive store (`currentSong`, `isPlaying`, `currentTime`,
 * `duration`); the store stays the source of truth and the UI re-renders from it. The
 * controller never reaches into the DOM.
 *
 * Usage:
 *   import playback from './services/PlaybackController.js';
 *   playback.toggle();            // play/pause
 *   playback.next();              // skip forward (queue head, else random feeder)
 *   playback.previous();          // step back through history
 *   playback.playSong(song);      // play a specific library track now
 *   playback.seekTo(seconds);
 *   await playback.start();       // restore the resume point + register lifecycle flush
 */

import appState from '../state/appState.js';
import queueManager from './QueueManager.js';
import nextTrack from './NextTrack.js';
import { savePlaybackState as apiSavePlaybackState, loadPlaybackState, logListen, fetchEvergreens } from './api.js';

// A play counts as a "listen" (and is logged to the backend) once this much of the track has
// actually been played. Matches LISTEN_THRESHOLD_SECONDS in server/app.py.
const LISTEN_THRESHOLD_SECONDS = 30;

// Largest gap between two 'timeupdate' events that still counts as real listening. The event
// fires a few times a second, so anything larger is a seek, not time spent listening.
const MAX_LISTEN_TICK = 2;

// A one-sample silent WAV. Used only to give an <audio> element something playable so it can be
// unlocked by a user gesture before any real track is resolved (see unlockIdleElement).
const SILENT_CLIP =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

class PlaybackController {
  constructor() {
    this.audioElement = new Audio();   // the active element (drives state + audible)
    this.preloadEl = new Audio();      // the idle element, buffering the resolved next track
    this.preloadEl.preload = 'auto';
    this.audioElement.volume = this.preloadEl.volume = appState.get('volume');

    this._preloadedSong = null;   // song whose url is currently loaded into preloadEl
    this._suppressPreload = false; // guard so a mid-swap re-resolve doesn't clobber the buffered track
    this._mediaHandlersSet = false; // OS media-session handlers registered once (see setupMediaSession)
    this._unlocked = new WeakSet(); // elements iOS has granted a gesture to (see armAudioUnlock)
    this._advancing = false;      // mid track-to-track transition (see the 'ended' listener)
    this._advanceTimer = null;
    this.failedSongs = new Set(); // songs that errored — excluded from "what plays next"

    // Listen tracking (see trackListenProgress): how much of the current track has really
    // been played, and whether that play-through has already been reported.
    this._listenSongId = null;
    this._listenSeconds = 0;
    this._listenLastTime = 0;
    this._listenLogged = false;

    this.attachAudioListeners(this.audioElement);
    this.attachAudioListeners(this.preloadEl);
    this.armAudioUnlock();

    // NextTrack owns "what plays next". Teach it which songs are playable and keep the idle
    // element warmed with the resolved next track. The disk-preview UI also listens to
    // NextTrack independently — both subscribers are decoupled.
    nextTrack.setPlayable((song) => this.isPlayable(song));
    nextTrack.addEventListener('change', (e) => {
      // During a swap the buffered element is mid-flip; playSong re-warms it afterwards, so skip
      // the re-point here to avoid clobbering the track we're swapping to.
      if (!this._suppressPreload) this.preloadNext(e.detail.song);
    });
    this.preloadNext(nextTrack.peek());

    // The OS media controls mirror the store, and the store is the single source of truth, so
    // this subscriber is the ONE place that pushes changes to the media session. Metadata is
    // refreshed only when the track changes; the play/pause transport only when isPlaying flips.
    appState.subscribe((key) => {
      if (key === 'currentSong') this.updateMediaMetadata();
      else if (key === 'isPlaying') this.updatePlaybackState();
    });
  }

  /**
   * Whether a song is eligible to be played/queued as "next": it has a URL and hasn't failed.
   * @param {Object|null} song
   * @returns {boolean}
   */
  isPlayable(song) {
    return !!(song && song.url) && !this.failedSongs.has(song.id);
  }

  // ---------------------------------------------------------------------------
  // Public interface — every playback action goes through one of these.
  // ---------------------------------------------------------------------------

  /**
   * Toggle play/pause for the current track. With nothing loaded, starts the first library song.
   */
  toggle() {
    if (appState.get('isPlaying')) this.pause();
    else this.play();
  }

  /**
   * Resume (or begin) playback. Resumes the current track if one is loaded; otherwise starts
   * the first song in the library. Idempotent if already playing.
   *
   * `isPlaying` / the OS `playbackState` are NOT set here — they're driven by the element's own
   * 'play' event (see attachAudioListeners). Setting them optimistically would lie to iOS if
   * play() rejects, and a playbackState that disagrees with the element is exactly what makes
   * the lock-screen resume button work only once.
   */
  play() {
    const song = appState.get('currentSong');
    if (song) {
      const p = this.audioElement.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } else {
      const songs = appState.get('songs') || [];
      if (songs.length) this.playSong(songs[0]);
    }
  }

  /**
   * Pause playback and capture the resume point so a reload restarts exactly here. `isPlaying` /
   * `playbackState` follow from the element's 'pause' event.
   */
  pause() {
    this.endAdvance();   // an explicit pause outranks any in-flight transition
    this.audioElement.pause();
    this.persist(true);
  }

  /**
   * Play a specific song now.
   * @param {Object} song
   * @param {Object} [opts]
   * @param {boolean} [opts.canSwap=false] - True when `song` is the track the idle element has
   *   been pre-buffering (set by next()): swap to it for a gapless transition instead of re-fetching.
   * @param {boolean} [opts.recordHistory=true] - Push the outgoing track to history. False when
   *   stepping back, so going "previous" doesn't re-add what we're leaving.
   */
  playSong(song, opts = {}) {
    const { canSwap = false, recordHistory = true } = opts;
    if (!song || !song.url) {
      console.error('Cannot play song: invalid song or missing URL', song);
      return;
    }

    const current = appState.get('currentSong');
    if (current && current.id === song.id) {
      this.toggle();
      return;
    }

    if (recordHistory && current) {
      queueManager.addToHistory(current);
    }

    const swapped = canSwap && this._preloadedSong && this._preloadedSong.url === song.url;
    if (swapped) {
      // Gapless: the idle element already holds this buffered track — flip the roles. The old
      // active element becomes the preloader and is re-warmed at the end of this method.
      const previous = this.audioElement;
      this.audioElement = this.preloadEl;
      this.preloadEl = previous;
      this.preloadEl.pause();
      this.audioElement.volume = appState.get('volume');
    } else {
      this.audioElement.src = song.url;
    }
    this._preloadedSong = null;

    appState.set('currentSong', song);

    // Apply the custom start, then begin playback. CRITICAL: play() must be called synchronously
    // here. When this runs from an OS / lock-screen action handler (next/previous), the browser
    // grants only a transient user activation; deferring play() into an async callback (e.g.
    // waiting for 'loadedmetadata') drops that activation and iOS silently refuses to start the
    // track — the song changes on the lock screen but never plays. So we seek synchronously when
    // metadata is already known (a preloaded/swapped element: no audible blip), otherwise we let
    // play() start from the file's natural beginning and snap to start_time once metadata lands.
    const startTime = song.start_time ?? 0;
    if (startTime > 0) {
      const el = this.audioElement; // capture: a later swap can reassign this.audioElement
      if (el.readyState >= 1) {
        el.currentTime = startTime;
        appState.set('currentTime', startTime);
      } else {
        el.addEventListener('loadedmetadata', () => {
          el.currentTime = startTime;
          if (el === this.audioElement) appState.set('currentTime', startTime);
        }, { once: true });
      }
    }

    const started = this.audioElement;
    const p = started.play();
    if (p && typeof p.catch === 'function') {
      // Never swallow this. A rejection here is the browser refusing to start the element —
      // on iOS, almost always because that element has never been granted a user gesture
      // (see armAudioUnlock). It is silent and invisible otherwise: the lock screen already
      // shows the new track, so it just looks like the app died in the background.
      p.catch((err) => {
        console.warn('play() rejected for', song.title, '-', err?.name || err);
        if (swapped) this.recoverBlockedPlay(song, started);
      });
    }
    // isPlaying follows from the element's 'play' event.
    this.persist(true);
    // Re-warm the idle element with whatever now plays next (the swap freed it).
    this.preloadNext(nextTrack.peek());
  }

  /**
   * Advance to the next track. NextTrack is the single source of truth for the choice (queue
   * head, else a random feeder pick); peek() is what the preloader buffered, take() advances
   * the bookkeeping.
   */
  next() {
    const song = nextTrack.peek();
    if (!song) {
      // Queue exhausted and no playable feeders — playback simply stops. This is the one path
      // where "paused" is the truth, so end the transition before publishing it.
      this.endAdvance();
      this.audioElement.pause();
      appState.set('isPlaying', false);
      return;
    }

    // Is this exactly what the idle element pre-buffered? Decide before take() re-resolves.
    const canSwap = !!(this._preloadedSong && this._preloadedSong.url === song.url);

    // take() advances the queue/RNG and re-resolves the following track. Suppress the preload
    // re-point it triggers so the buffered element survives until playSong swaps to it.
    this._suppressPreload = true;
    nextTrack.take();
    this._suppressPreload = false;

    this.playSong(song, { canSwap });
  }

  /**
   * Step back to the previously played track (from history), else the prior library track. The
   * song being left is pushed to the FRONT of the queue so pressing next replays it — back and
   * forward then walk one continuous list. Does not record history (we're walking back through it).
   */
  previous() {
    const current = appState.get('currentSong');

    const previousFromHistory = queueManager.getPrevious();
    if (previousFromHistory && previousFromHistory.url) {
      // Remove it from history (shorten the trail), stash the current track at the head of the
      // queue, and play the previous one without re-recording history.
      queueManager.dropFromHistory(previousFromHistory.id);
      if (current) queueManager.prepend(current);
      this.playSong(previousFromHistory, { recordHistory: false });
      return;
    }

    // No history → fall back to the previous track in the library.
    const songs = appState.get('songs') || [];
    if (!songs.length || !current) return;
    const currentIndex = songs.findIndex((s) => s.id === current.id);
    const prevIndex = currentIndex > 0 ? currentIndex - 1 : songs.length - 1;
    queueManager.prepend(current);
    this.playSong(songs[prevIndex], { recordHistory: false });
  }

  /**
   * Seek the active element to a position (seconds) and publish it.
   * @param {number} time
   */
  seekTo(time) {
    if (!appState.get('currentSong')) return;
    this.audioElement.currentTime = time;
    appState.set('currentTime', time);
    this.updatePositionState();
  }

  // ---------------------------------------------------------------------------
  // Audio element wiring
  // ---------------------------------------------------------------------------

  /**
   * Bind the full set of playback listeners to one audio element. Every handler is a no-op
   * unless `el` is currently the active element, so the idle (preloading) element stays inert.
   * After a swap the roles flip with no re-binding.
   * @param {HTMLAudioElement} el
   */
  attachAudioListeners(el) {
    const isActive = () => el === this.audioElement;

    // The audio element is the source of truth for play/pause. Mirror its REAL state into the
    // store here — no matter who triggered the change (in-app button, lock screen, headset,
    // autoplay rejection). The store, in turn, drives the OS media-session playbackState via the
    // single subscriber above (updatePlaybackState). We do NOT write playbackState here too:
    // having one writer keeps it exactly in lockstep with the element, which is what lets iOS
    // reliably send the right action. The previous approach wrote it from several places and let
    // the lock screen drift (showing play while paused and vice-versa).
    el.addEventListener('play', () => {
      if (!isActive()) return;
      appState.set('isPlaying', true);
    });

    // Reaching the end of a track fires 'pause' immediately *before* 'ended'. That is a
    // transition, not a stop — swallow it. Publishing isPlaying=false here would push
    // playbackState='paused' to the OS at the exact moment we hand it the next track; in the
    // background iOS reads that as "this app is done making sound", tears the audio session
    // down and suspends the page, so the track we just announced never actually starts.
    el.addEventListener('pause', () => {
      if (!isActive()) return;
      if (el.ended || this._advancing) return;
      appState.set('isPlaying', false);
    });

    el.addEventListener('ended', () => {
      if (!isActive()) return;
      // Stay "playing" as far as the store and the OS are concerned until the next track is
      // actually rolling. next() publishes isPlaying=false itself if there is nothing to play.
      this.beginAdvance();
      this.next();
    });

    el.addEventListener('timeupdate', () => {
      if (!isActive()) return;
      const ct = el.currentTime;
      appState.set('currentTime', ct);
      this.trackListenProgress(ct);
      this.updatePositionState();
      this.persist();
      // Stop and advance when reaching a custom end_time.
      const song = appState.get('currentSong');
      if (song?.end_time != null && ct >= song.end_time) {
        this.beginAdvance();   // same transition as 'ended': don't report "paused" to the OS
        el.pause();
        this.next();
      }
    });

    el.addEventListener('loadedmetadata', () => {
      if (!isActive()) return;
      appState.set('duration', el.duration);
      this.updatePositionState();
    });

    // iOS only honors media-session action handlers when they're first registered while audio is
    // actively playing (setting them up front, before any playback, is silently ignored). So we
    // register on the first 'playing' event — but exactly once (setupMediaSession self-guards).
    // Re-registering the handlers on every 'playing' event is what made lock-screen *resume*
    // fail after the first time, so we don't.
    //
    // 'playing' is the definitive "audio is actually producing sound now" signal, so we treat it
    // as authoritative for isPlaying. iOS can fire a spurious 'pause' (audio interruption, a seek,
    // a buffer underrun) and then resume with ONLY a 'playing' event — no fresh 'play' event —
    // which would otherwise leave isPlaying (and so the lock-screen button) stuck on paused while
    // sound is coming out. Asserting it here, then refreshing metadata, keeps the controls correct.
    el.addEventListener('playing', () => {
      if (!isActive()) return;
      this.endAdvance();               // the new track is audible: the transition is over
      appState.set('isPlaying', true); // → updatePlaybackState via the store subscriber
      this.setupMediaSession();        // first 'playing' only: registers handlers + initial metadata
    });

    el.addEventListener('error', (e) => {
      if (!isActive()) return;
      const song = appState.get('currentSong');
      console.error('Audio playback error for', song?.title, ':', e);
      appState.set('isPlaying', false);

      // Mark this song failed so it's excluded going forward, and re-resolve the next track.
      if (song?.id) {
        this.failedSongs.add(song.id);
        nextTrack.invalidate();
      }
      // Auto-skip; small delay to avoid rapid-fire skipping on a run of bad files.
      setTimeout(() => this.next(), 500);
    });
  }

  // ---------------------------------------------------------------------------
  // Track-to-track transitions
  // ---------------------------------------------------------------------------

  /**
   * Mark the start of an automatic track change. While this is set, the old element's 'pause'
   * is ignored and the OS is still told 'playing', so the media session is never handed a
   * momentary "paused" between two tracks — iOS treats that as the app going idle and, when
   * we're backgrounded, suspends the page before the next track can start.
   * Self-clearing after 10s so a stalled transition can't wedge the transport state.
   */
  beginAdvance() {
    this._advancing = true;
    clearTimeout(this._advanceTimer);
    this._advanceTimer = setTimeout(() => {
      this._advancing = false;
      this.updatePlaybackState();
    }, 10000);
  }

  /** End the transition window (the next track is audible, or there is nothing to play). */
  endAdvance() {
    if (!this._advancing) return;
    this._advancing = false;
    clearTimeout(this._advanceTimer);
  }

  // ---------------------------------------------------------------------------
  // iOS gesture unlock
  // ---------------------------------------------------------------------------

  /**
   * iOS gates media per <audio> ELEMENT, not per page. An element that has never been started
   * from a user gesture may neither play programmatically nor buffer — `preload="auto"` and
   * `load()` are simply ignored on it. The user's taps only ever unlock whichever element is
   * active at the time, so the idle preload element stays locked for the life of the page: it
   * buffers nothing, and the instant a gapless swap makes it the active element iOS refuses to
   * start it. Foregrounded that mostly hides itself — the page is alive, the blocked element's
   * fetch still runs and playback catches up. Backgrounded it does not: the old track has
   * ended, so iOS suspends the page, the fetch never lands, and the next track never plays —
   * while the metadata we already published keeps the lock screen looking perfectly correct.
   *
   * So on the first user gesture we unlock the idle element too, by playing it muted for an
   * instant. The restriction is cleared permanently, which also makes `load()` genuinely
   * pre-buffer on iOS — so the next track is in memory before it's needed and the background
   * swap needs no network at all. The active element needs nothing: the user's own play tap
   * unlocks it. Listeners are capture-phase (they must run before the tap starts playback) and
   * stay armed until the unlock actually succeeds.
   */
  armAudioUnlock() {
    const events = ['pointerdown', 'touchend', 'click', 'keydown'];
    const onGesture = () => {
      this.unlockIdleElement(() => {
        events.forEach((t) => document.removeEventListener(t, onGesture, true));
      });
    };
    events.forEach((t) => document.addEventListener(t, onGesture, true));
  }

  /**
   * Play the idle element muted for one sample so the browser grants it the gesture, then put it
   * back exactly as it was. Uses a silent inline clip when nothing is preloaded yet.
   * @param {() => void} onUnlocked - called once the element is confirmed unlocked.
   */
  unlockIdleElement(onUnlocked) {
    const el = this.preloadEl;
    if (this._unlocked.has(el)) { onUnlocked(); return; }

    const hadSrc = !!el.getAttribute('src');
    const resumeAt = el.currentTime || 0;
    if (!hadSrc) el.src = SILENT_CLIP;
    el.muted = true;

    const restore = () => {
      el.pause();
      el.muted = false;
      if (!hadSrc) {
        // Drop the silent clip and point the element at the real next track, which can now
        // actually be buffered.
        this._preloadedSong = null;
        el.removeAttribute('src');
        el.load();
        this.preloadNext(nextTrack.peek());
      } else if (resumeAt) {
        try { el.currentTime = resumeAt; } catch (_) {}
      }
    };

    const p = el.play();
    if (p && typeof p.then === 'function') {
      p.then(() => { this._unlocked.add(el); restore(); onUnlocked(); })
       .catch(() => { restore(); });   // stay armed and retry on the next gesture
    } else {
      this._unlocked.add(el);
      restore();
      onUnlocked();
    }
  }

  /**
   * Last-resort recovery when the browser refused to start the element we swapped to. Fall back
   * to the element we swapped away from — it has already produced sound, so it is unlocked — by
   * loading the same track into it. Costs this one gapless transition; the track actually plays.
   * @param {Object} song
   * @param {HTMLAudioElement} blockedEl - the element whose play() was rejected.
   */
  recoverBlockedPlay(song, blockedEl) {
    if (blockedEl !== this.audioElement) return;                    // something else took over
    if (appState.get('currentSong')?.id !== song.id) return;        // we've moved on
    const fallback = this.preloadEl;
    if (fallback === blockedEl) return;

    console.warn('Falling back to the previously-playing element for', song.title);
    this.audioElement = fallback;
    this.preloadEl = blockedEl;
    this.preloadEl.pause();
    this.audioElement.volume = appState.get('volume');
    this.audioElement.src = song.url;
    this._preloadedSong = null;

    const start = song.start_time ?? 0;
    const el = this.audioElement;
    if (start > 0) {
      el.addEventListener('loadedmetadata', () => {
        el.currentTime = start;
        if (el === this.audioElement) appState.set('currentTime', start);
      }, { once: true });
    }
    const p = el.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => console.warn('Fallback play() also rejected:', err?.name || err));
    }
  }

  /**
   * Point the idle element at a song's audio so it's buffered before we need it. No-op if it
   * already holds that song (avoids restarting the fetch).
   * @param {Object|null} song
   */
  preloadNext(song) {
    if (!song || !song.url) {
      this._preloadedSong = null;
      return;
    }
    if (this._preloadedSong && this._preloadedSong.url === song.url) return;
    this._preloadedSong = song;
    // The two elements swap roles, so whichever one is idle right now may be the element that
    // started life as the active one — set preload on it every time rather than once in the
    // constructor. Without this, after the first swap the "preloader" only fetched metadata and
    // the next track had to be downloaded from scratch at the moment it was needed.
    this.preloadEl.preload = 'auto';
    this.preloadEl.src = song.url;
    this.preloadEl.load();
    // Pre-seek to the custom start so the swap begins exactly there with that region buffered.
    const start = song.start_time ?? 0;
    if (start > 0) {
      const seek = () => { this.preloadEl.currentTime = start; };
      if (this.preloadEl.readyState >= 1) seek();
      else this.preloadEl.addEventListener('loadedmetadata', seek, { once: true });
    }
  }

  // ---------------------------------------------------------------------------
  // Resume-point persistence
  // ---------------------------------------------------------------------------

  /**
   * Restore the resume point (saved song + position, left paused) and register the lifecycle
   * flush so the latest position is captured when the page is hidden/unloaded. Call once after
   * the user is authenticated.
   */
  async start() {
    await this.restore();
    const flush = () => this.persist(true);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }

  /**
   * Load the saved song + position, seek there, leave paused. Sets currentSong directly (not via
   * playSong) so history isn't disturbed.
   */
  async restore() {
    if (appState.get('currentSong')) return;
    const { song, position } = await loadPlaybackState();
    if (!song || !song.url) return;

    appState.set('currentSong', song);
    this.audioElement.src = song.url;

    const seekTarget = position || song.start_time || 0;
    if (seekTarget > 0) {
      const seek = () => {
        this.audioElement.currentTime = seekTarget;
        appState.set('currentTime', seekTarget);
      };
      if (this.audioElement.readyState >= 1) seek();
      else this.audioElement.addEventListener('loadedmetadata', seek, { once: true });
    }
    appState.set('isPlaying', false);
  }

  /**
   * Persist the resume point (current song id + position). Throttled to ~once every 4s unless
   * `force` is set (track change, pause, page hide).
   * @param {boolean} [force=false]
   */
  persist(force = false) {
    const now = Date.now();
    if (!force && now - (this._lastStateSave || 0) < 4000) return;
    this._lastStateSave = now;
    const song = appState.get('currentSong');
    const songId = song && Number.isInteger(song.id) ? song.id : null;
    const position = this.audioElement ? (this.audioElement.currentTime || 0) : 0;
    apiSavePlaybackState(songId, position).catch(() => {});
  }

  /**
   * Clear the current track (e.g. when the playing song is deleted) and persist the cleared state.
   */
  clearCurrent() {
    this.audioElement.pause();
    appState.set('currentSong', null);
    appState.set('isPlaying', false);
    this.persist(true);
  }

  // ---------------------------------------------------------------------------
  // Listen tracking — feeds the backend listen log, which the evergreens ranking reads.
  // ---------------------------------------------------------------------------

  /**
   * Accumulate real playback time for the current track and report a listen once it passes
   * LISTEN_THRESHOLD_SECONDS. Only forward progress of at most one tick counts, so seeking
   * ahead earns no credit and a paused track accumulates nothing. Each track gets one listen
   * per play-through; switching tracks starts a fresh accumulator.
   * @param {number} position - The active element's currentTime, in seconds
   */
  trackListenProgress(position) {
    const song = appState.get('currentSong');
    if (!song || song.id == null) return;

    if (song.id !== this._listenSongId) {
      this._listenSongId = song.id;
      this._listenSeconds = 0;
      this._listenLastTime = position;
      this._listenLogged = false;
      return;
    }

    const delta = position - this._listenLastTime;
    this._listenLastTime = position;
    if (delta > 0 && delta <= MAX_LISTEN_TICK) this._listenSeconds += delta;

    if (!this._listenLogged && this._listenSeconds > LISTEN_THRESHOLD_SECONDS) {
      this._listenLogged = true;   // set before the await so a burst of ticks can't double-post
      this.reportListen(song.id, this._listenSeconds);
    }
  }

  /**
   * Send a listen to the backend and refresh the evergreens the Curate tab shows.
   * Fire-and-forget: errors are swallowed by the api helpers.
   * @param {number} songId
   * @param {number} seconds - Seconds of the track actually played
   */
  async reportListen(songId, seconds) {
    const counted = await logListen(songId, seconds);
    if (!counted) return;
    appState.set('evergreens', await fetchEvergreens());
  }

  // ---------------------------------------------------------------------------
  // OS media controls (lock screen, notification shade, Control Center, headset buttons)
  // ---------------------------------------------------------------------------

  /**
   * Register OS-level media control handlers — once. Without these iOS shows no prev/next and no
   * scrubber. Every handler routes to the same public methods the in-app controls use, so the
   * lock screen behaves identically. Registered exactly once (the first time playback starts):
   * re-registering them churns iOS's internal state and breaks lock-screen resume after the
   * first toggle. Safe no-op where the Media Session API is unavailable.
   */
  setupMediaSession() {
    if (!('mediaSession' in navigator) || this._mediaHandlersSet) return;
    const ms = navigator.mediaSession;

    ms.setActionHandler('play', () => this.play());
    ms.setActionHandler('pause', () => this.pause());
    ms.setActionHandler('previoustrack', () => this.previous());
    ms.setActionHandler('nexttrack', () => this.next());

    ms.setActionHandler('seekto', (details) => {
      if (details.seekTime == null) return;
      if (details.fastSeek && 'fastSeek' in this.audioElement) {
        this.audioElement.fastSeek(details.seekTime);
        appState.set('currentTime', details.seekTime);
        this.updatePositionState();
        return;
      }
      this.seekTo(details.seekTime);
    });

    // Explicitly disable the ±10s skip handlers — iOS shows its built-in skip buttons in place
    // of next/previous-track unless these are actively nulled out.
    try { ms.setActionHandler('seekbackward', null); } catch (_) {}
    try { ms.setActionHandler('seekforward', null); } catch (_) {}

    this._mediaHandlersSet = true;

    // Push the current metadata + transport state now that the handlers exist. Per-track updates
    // thereafter flow from the store subscriber, so we don't rebuild metadata on every 'playing'.
    this.updateMediaMetadata();
  }

  /**
   * Push the current track's metadata to the OS media controls. Called only when the song
   * changes (via the store subscriber) — rebuilding MediaMetadata on every play/pause toggle
   * makes the iOS lock screen flicker and can desync its transport button.
   *
   * Assigning new MediaMetadata RESETS the OS transport state on iOS, so we MUST re-assert
   * playbackState immediately afterwards — i.e. playbackState is always the last media-session
   * write. Skipping this is exactly why most song transitions left the lock-screen button stuck
   * on "play" even though the new track was already audible.
   */
  updateMediaMetadata() {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    const song = appState.get('currentSong');
    if (!song) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title || 'Unknown',
      artist: song.artist || 'Unknown artist',
      album: song.album || '',
      artwork: song.cover
        ? [{ src: song.cover, sizes: '512x512', type: 'image/jpeg' }]
        : [],
    });
    this.updatePlaybackState();
  }

  /**
   * Mirror the play/pause state (and scrubber position) to the OS media controls. This is the
   * ONLY place that writes navigator.mediaSession.playbackState. It reads `isPlaying` from the
   * store, which is set exclusively from the audio element's own play/pause events, so the
   * lock-screen transport stays in lockstep with what's actually audible.
   */
  updatePlaybackState() {
    if (!('mediaSession' in navigator)) return;
    // `_advancing` holds the OS at "playing" across a track change — see beginAdvance().
    const playing = appState.get('isPlaying') || this._advancing;
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    this.updatePositionState();
  }

  /**
   * Publish playback position/duration so the lock-screen scrubber renders and tracks progress.
   * Skipped until a finite duration is known (live/seeking states throw).
   */
  updatePositionState() {
    if (!('mediaSession' in navigator) || !('setPositionState' in navigator.mediaSession)) return;
    const dur = this.audioElement.duration;
    if (!dur || !isFinite(dur)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: dur,
        playbackRate: this.audioElement.playbackRate || 1,
        position: Math.min(Math.max(0, this.audioElement.currentTime), dur),
      });
    } catch (_) {
      // setPositionState throws if position > duration mid-transition; ignore.
    }
  }
}

const playbackController = new PlaybackController();

export default playbackController;
