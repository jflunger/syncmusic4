/**
 * Main music app component with tab navigation.
 */

import appState from '../state/appState.js';
import { fetchSongs, fetchPlaylists, addSongToPlaylist, removeSongFromPlaylist, getCurrentUser, login,
  fetchPlayFeeders, addPlayFeeder, removePlayFeeder } from '../services/api.js';
import queueManager from '../services/QueueManager.js';
import nextTrack from '../services/NextTrack.js';
import playback from '../services/PlaybackController.js';
import './TrackEditor.js';

class MusicApp extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    this.currentTab = appState.get('currentTab');
    this.isPlaying = appState.get('isPlaying');
    this.currentSong = appState.get('currentSong');
    this.tabElements = {}; // Cache for tab components (mount once, show/hide on switch)

    // All audio/playback lives in the PlaybackController (the single interface for play/pause,
    // next/previous, seeking, the dual-element gapless swap and the OS lock-screen controls).
    // MusicApp only renders UI and forwards user gestures to it; it never touches <audio>.
    // Keep the disk-preview "next" cover live as the resolved next track changes.
    nextTrack.addEventListener('change', (e) => this.onNextTrackChange(e.detail.song));
  }

  async connectedCallback() {
    // Gate the whole app behind login. Until authenticated we show only the
    // login form and mount no tabs / load no data.
    const user = await getCurrentUser();
    if (!user) {
      this.renderLogin();
      return;
    }
    appState.set('currentUser', user);

    this.render();
    this.attachEvents();
    // OS media-session handlers are owned and registered by the PlaybackController (on the
    // audio 'playing' event — iOS ignores them unless set while playback is active).

    // Load initial data
    await this.loadSongs();
    await this.loadPlaylists();
    await this.loadPlayFeeders();
    // Restore the per-user resume point and register the lifecycle position-flush. The
    // controller owns both (it holds the <audio> element the position is read from).
    await playback.start();
  }

  /**
   * Render the login screen. On success the page reloads into the authed
   * bootstrap path above.
   */
  renderLogin() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .login-wrap {
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          background: #000;
          color: #fff;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          padding: 24px;
          box-sizing: border-box;
        }
        .login-card {
          width: 100%;
          max-width: 320px;
          display: flex;
          flex-direction: column;
          gap: 14px;
        }
        .login-card h1 { font-size: 1.6rem; margin: 0 0 8px; text-align: center; }
        .login-card input {
          -webkit-user-select: text;
          user-select: text;
          -webkit-touch-callout: default;
          padding: 12px 14px;
          border-radius: 10px;
          border: 1px solid #333;
          background: #111;
          color: #fff;
          font-size: 1rem;
        }
        .login-card input:focus { outline: none; border-color: #1db954; }
        .login-card button {
          padding: 12px 14px;
          border-radius: 10px;
          border: none;
          background: #1db954;
          color: #fff;
          font-size: 1rem;
          font-weight: 600;
          cursor: pointer;
        }
        .login-card button:disabled { opacity: 0.6; cursor: default; }
        .login-error { color: #f44336; font-size: 0.9rem; min-height: 1.1em; text-align: center; }
      </style>
      <div class="login-wrap">
        <form class="login-card">
          <h1>SyncMusic4</h1>
          <input type="text" name="username" placeholder="Username" autocomplete="username" autocapitalize="off" autocorrect="off" />
          <input type="password" name="password" placeholder="Password" autocomplete="current-password" />
          <button type="submit">Log in</button>
          <div class="login-error"></div>
        </form>
      </div>
    `;

    const form = this.shadowRoot.querySelector('.login-card');
    const errorEl = this.shadowRoot.querySelector('.login-error');
    const button = this.shadowRoot.querySelector('button');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = form.username.value.trim();
      const password = form.password.value;
      errorEl.textContent = '';
      button.disabled = true;
      try {
        await login(username, password);
        // Reload so the authed bootstrap path mounts the app cleanly.
        location.reload();
      } catch (err) {
        errorEl.textContent = err.message || 'Login failed';
        button.disabled = false;
      }
    });
  }

  /**
   * React to the resolved next track changing: live-update the disk slider's "next" cover.
   * (Audio preloading is handled inside the PlaybackController, which listens to NextTrack too.)
   * @param {Object|null} song
   */
  onNextTrackChange(song) {
    const orbit = this.shadowRoot?.querySelector('.np-vinyl-orbit');
    if (orbit) this.setSlotCover(orbit, 'next', song);
  }

  /**
   * Load songs from API
   */
  async loadSongs() {
    const songs = await fetchSongs();
    appState.set('songs', songs);
  }

  /**
   * Load playlists from API (placeholder)
   */
  async loadPlaylists() {
    const playlists = await fetchPlaylists();
    appState.set('playlists', playlists);
  }

  /**
   * Load the Play-tab feeder playlist ids (fallback sources when the queue empties).
   */
  async loadPlayFeeders() {
    const feeders = await fetchPlayFeeders();
    appState.set('playFeeders', feeders);
  }

  /**
   * Add a playlist to the Play-tab feeders. Optimistic: update state immediately,
   * roll back if the server rejects it.
   * @param {number} playlistId
   */
  async onFeederAdd(playlistId) {
    if (playlistId == null) return;
    const current = appState.get('playFeeders') || [];
    if (current.includes(playlistId)) return;
    appState.set('playFeeders', [...current, playlistId]);
    try {
      await addPlayFeeder(playlistId);
    } catch (err) {
      console.error('Failed to add feeder:', err);
      appState.set('playFeeders', (appState.get('playFeeders') || []).filter(id => id !== playlistId));
    }
  }

  /**
   * Remove a playlist from the Play-tab feeders (optimistic, with rollback).
   * @param {number} playlistId
   */
  async onFeederRemove(playlistId) {
    if (playlistId == null) return;
    const current = appState.get('playFeeders') || [];
    if (!current.includes(playlistId)) return;
    appState.set('playFeeders', current.filter(id => id !== playlistId));
    try {
      await removePlayFeeder(playlistId);
    } catch (err) {
      console.error('Failed to remove feeder:', err);
      if (!(appState.get('playFeeders') || []).includes(playlistId)) {
        appState.set('playFeeders', [...(appState.get('playFeeders') || []), playlistId]);
      }
    }
  }

  /**
   * Attach event listeners
   */
  attachEvents() {
    this.unsubscribeState = appState.subscribe((key, value) => {
      if (key === 'currentTab') {
        this.currentTab = value;
        this.renderTabs();
        // Only re-flag the active button — rebuilding the bar would recreate the vinyl
        // and reset its spin animation.
        this.updateTabBarActive();
        if (value === 'play') {
          const tabContent = this.shadowRoot.querySelector('.tab-content');
          if (tabContent) tabContent.scrollTop = 0;
        }
      }
      if (key === 'isPlaying' || key === 'currentSong') {
        this.isPlaying = appState.get('isPlaying');
        this.currentSong = appState.get('currentSong');
        this.updateNowPlayingVinyl();
        // (OS media-session metadata is updated by the PlaybackController, which subscribes too.)
      }
    });

    this.shadowRoot.addEventListener('click', this.handleClick.bind(this));
    this.shadowRoot.addEventListener('pointerdown', this.onDiskPointerDown.bind(this));

    // Remove from queue (tapping a track's queue indicator) — works in any tab.
    // Prefer removing by id so the track's live queue position is what's removed.
    this.addEventListener('remove-from-queue', (e) => {
      const { songId, index } = e.detail || {};
      if (songId != null && queueManager.removeById(songId)) return;
      if (typeof index === 'number' && index >= 0) queueManager.remove(index);
    });

    // Tap the spinning disc of the current track (any tab) → toggle play/pause.
    this.addEventListener('toggle-play-pause', () => playback.toggle());

    // Clear the queue / history (confirmed in the Play tab before dispatching).
    this.addEventListener('clear-queue', () => queueManager.clear());
    this.addEventListener('clear-history', () => queueManager.clearHistory());

    // Toggle working-playlist membership (swipe on a track) — works in any tab.
    this.addEventListener('add-to-playlist', (e) => this.togglePlaylistMembership(true, e.detail.song));
    this.addEventListener('remove-from-playlist', (e) => this.togglePlaylistMembership(false, e.detail.song));

    // Play-tab feeder add/remove (swipe on a playlist-item) — works in any tab.
    this.addEventListener('feeder-add', (e) => this.onFeederAdd(e.detail.playlistId));
    this.addEventListener('feeder-remove', (e) => this.onFeederRemove(e.detail.playlistId));

    this.addEventListener('track-edit-request', (e) => {
      const { song } = e.detail;
      const editor = document.createElement('track-editor');
      editor.setAttribute('song', JSON.stringify(song));
      editor.addEventListener('saved', async (ev) => {
        const updatedSong = ev.detail.song;
        await this.loadSongs();
        await this.loadPlaylists();
        queueManager.updateSong(updatedSong.id, updatedSong);
        if (this.currentSong?.id === updatedSong.id) {
          appState.set('currentSong', { ...this.currentSong, ...updatedSong });
        }
      });
      editor.addEventListener('deleted', async (ev) => {
        const { songId } = ev.detail;
        await this.loadSongs();
        await this.loadPlaylists();
        // Remove from queue if present
        queueManager.removeById(songId);
        // Stop playback if the deleted song is current, and clear the resume point
        if (this.currentSong?.id === songId) {
          playback.clearCurrent();
        }
      });
      editor.addEventListener('show-related', (ev) => this.showRelated(ev.detail.song));
      editor.addEventListener('close', () => {});
      this.shadowRoot.appendChild(editor);
    });
  }

  /**
   * Handle clicks within component
   * @param {Event} event
   */
  handleClick(event) {
    const target = event.target;

    const tabButton = target.closest('.tab-button');
    if (tabButton) {
      const tab = tabButton.dataset.tab;
      // Re-tapping the active tab takes it back to its default subtab.
      if (tab === this.currentTab) this.tabElements[tab]?.showDefaultSubtab?.();
      appState.set('currentTab', tab);
    }


    event.stopPropagation();
  }

  /**
   * Carry a track search over to the Discover tab, so a track the library doesn't
   * have can be found online and downloaded.
   * @param {string} query - The query typed on the Curate tab's Tracks subtab
   */
  searchOnline(query) {
    appState.set('currentTab', 'discover');
    this.tabElements.discover?.setSearchQuery(query);
  }

  /**
   * Switch to the Discover tab and list tracks related to a library song.
   * @param {Object} song - Library song (needs id, source)
   */
  showRelated(song) {
    appState.set('currentTab', 'discover');
    this.tabElements.discover?.showRelated(song);
  }

  /**
   * Enqueue a song (add to queue instead of playing immediately).
   * If song is already in queue: move to first position.
   * If song is already first in queue: play it immediately.
   * @param {Object} song
   */
  enqueueSong(song) {
    if (!song || !song.id) return;

    // Ignore re-enqueueing the song that's already playing
    if (this.currentSong && String(this.currentSong.id) === String(song.id)) return;

    // The action is decided solely by the track's actual position in the live queue.
    const index = queueManager.indexOf(song.id);

    if (index === -1) {
      // Not queued → add to the back.
      queueManager.enqueue(song);
    } else if (index > 0) {
      // Queued but not next up → jump it to the front.
      queueManager.moveToFirst(index);
    } else {
      // Already at the front → play it now (remove that exact track by id, not index 0).
      let songToPlay = queueManager.peek();
      if (songToPlay) {
        if (!songToPlay.url) {
          const librarySong = (appState.get('songs') || []).find(s => String(s.id) === String(songToPlay.id));
          if (librarySong?.url) songToPlay = { ...songToPlay, url: librarySong.url };
        }
        if (songToPlay.url) {
          queueManager.removeById(songToPlay.id);
          playback.playSong(songToPlay);
        }
      }
    }
  }

  /**
   * Add or remove a song from the working playlist and keep state in sync.
   * Drives the song-item membership swipe across every tab.
   * @param {boolean} add - true to add, false to remove
   * @param {Object} song
   */
  async togglePlaylistMembership(add, song) {
    const wp = appState.get('workingPlaylist');
    if (!wp || !song || song.id == null || this._togglingPlaylist) return;

    const playlists = appState.get('playlists') || [];
    const current = playlists.find(p => p.id === wp.id);
    const songs = (current?.songs) || wp.songs || [];
    const alreadyIn = songs.some(s => String(s.id) === String(song.id));
    if (add === alreadyIn) return; // nothing to do (already in / already out)

    this._togglingPlaylist = true;
    try {
      if (add) {
        await addSongToPlaylist(wp.id, song.id);
      } else {
        await removeSongFromPlaylist(wp.id, song.id);
      }

      const updatedPlaylists = playlists.map(p => {
        if (p.id !== wp.id) return p;
        const list = Array.isArray(p.songs) ? [...p.songs] : [];
        if (add) {
          if (!list.some(s => String(s.id) === String(song.id))) list.push(song);
        } else {
          return { ...p, songs: list.filter(s => String(s.id) !== String(song.id)) };
        }
        return { ...p, songs: list };
      });

      appState.set('playlists', updatedPlaylists);
      const updatedWp = updatedPlaylists.find(p => p.id === wp.id);
      appState.set('workingPlaylist', updatedWp ? { ...updatedWp } : wp);

      // Membership changed, so the server-maintained Orphans playlist may have too.
      fetchPlaylists().then(fresh => { if (fresh) appState.set('playlists', fresh); });
    } catch (err) {
      console.error('Playlist toggle failed:', err);
      alert(add ? 'Failed to add song to playlist' : 'Failed to remove song from playlist');
    } finally {
      this._togglingPlaylist = false;
    }
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block; height: 100%; background: #000; color: #fff; position: relative; overflow: hidden;
          /* Extra lift of the whole bottom nav off the screen bottom, on top of the
             home-indicator safe-area inset. Threaded into every bottom-anchored nav
             offset below so the bar, its fill strip, the buttons and the floating disc
             all move together. Only applied in the installed PWA (see media query
             below); 0 in a normal browser tab so that layout is unchanged. */
          --nav-lift: 0px;
        }
        /* Installed-PWA only: lift the nav bar slightly higher off the bottom. */
        @media (display-mode: standalone) {
          :host { --nav-lift: 10px; }
        }
        .tab-content {
          /* Don't pad the scroller for the notch — that just pushes the sticky tab
             headers down and leaves the status-bar inset black above them. Each tab's
             header absorbs the inset itself (padding-top: safe-area-inset-top) so its
             background reaches the screen top while its text stays clear of the notch. */
          /* Full height so content scrolls *under* the bar and shows through the
             transparent Play notch; padding clears the opaque Play panel. */
          padding-bottom: calc(56px + env(safe-area-inset-bottom, 0px) + var(--nav-lift));
          height: 100%;
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
          background: #000;
          box-sizing: border-box;
        }
        .content-area { padding: 0 20px; }

        .tab-bar {
          position: absolute;
          bottom: 0;
          left: 0;
          right: 0;
          /* The box is taller than the 70px visual bar on purpose: the now-playing disc
             pokes up out of the valley, and its box must stay *inside* the bar — if it
             overflows above into the scrolling .tab-content, mobile arbitrates the touch
             to scrolling and the disc can't be tapped/swiped. box-sizing:border-box keeps
             the safe-area padding within this height; the bar reaches the screen bottom so
             the background still extends down under the home indicator. */
          height: calc(100px + env(safe-area-inset-bottom, 0px) + var(--nav-lift));
          box-sizing: border-box;
          padding-bottom: calc(env(safe-area-inset-bottom, 0px) + var(--nav-lift));
          background: transparent;
          display: flex;
          justify-content: space-around;
          align-items: flex-end;
          /* Most of the box is empty headroom — let taps fall through to the content under
             it, and re-enable hit-testing only on the buttons and the disc (below). */
          pointer-events: none;
          z-index: 100;
        }
        /* Solid strip filling the home-indicator inset below the 70px bar, so the bar's
           background extends to the screen bottom. Colour = navFill's bottom stop, so it
           continues the bar fill seamlessly. */
        .tab-bar::after {
          content: '';
          position: absolute;
          left: 0;
          right: 0;
          bottom: 0;
          /* +1px so the strip overlaps the SVG's bottom edge — env() is fractional, so an
             exact meeting point rounds to a hairline gap. The SVG bottom row is the same
             #24262c, so the overlap is invisible. */
          height: calc(env(safe-area-inset-bottom, 0px) + var(--nav-lift) + 1px);
          background: #24262c;
          pointer-events: none;
        }
        /* Organic shape + glowing edge, drawn by an SVG pinned to the 70px visual band just
           above the safe-area inset. Fixed height (never stretched) keeps the valley and the
           glowing contour in shape regardless of the inset. */
        .tab-bar-bg {
          position: absolute;
          left: 0;
          right: 0;
          bottom: calc(env(safe-area-inset-bottom, 0px) + var(--nav-lift));
          width: 100%;
          height: 70px;
          pointer-events: none;
        }
        .tab-button {
          position: relative;
          z-index: 1;
          flex: 1;
          height: 70px;
          pointer-events: auto;
          background: none;
          border: none;
          color: #7a8190;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: flex-end;
          padding-bottom: 11px;
          font-size: 11px;
          letter-spacing: 0.3px;
          gap: 3px;
          transition: color 0.25s ease, transform 0.25s ease;
          cursor: pointer;
        }
        .tab-button svg { width: 24px; height: 24px; fill: #fff; transition: filter 0.25s ease; }
        /* Play button occupies only the lower valley (no label) so it never covers the
           floating record poking up above it — the record handles its own clicks. */
        .tab-button[data-tab="play"] {
          align-self: flex-end;
          height: 42px;
          justify-content: center;
          padding-top: 0;
          padding-bottom: 0;
        }
        .tab-button.active {
          color: #fff;
        }
        .tab-button.active svg {
          filter: drop-shadow(0 0 6px rgba(90, 200, 255, 0.9));
        }
        /* Now-playing record. Two nested elements so two independent rotations coexist:
           the OUTER orbit swings around a pivot near the screen-bottom centre (swiping
           rolls the disc along that "sphere rim"); the INNER disc keeps spinning on its
           own centre. Diameter = full bar height (70px). It paints behind the bar SVG so
           the opaque Play panel hides its lower half. Centre sits 2/3 of the bar height
           above the bottom while playing and rises to 5/6 when paused (via the bottom
           inset, not a transform). Mirrors SongItem's vinyl (circle + centre hole). */
        .np-vinyl-orbit {
          position: absolute;
          left: calc(50% - 35px);
          /* Offsets measured from the 70px band's bottom, which sits a safe-area inset above
             the screen bottom — so add the inset to keep the disc on the valley. */
          bottom: calc(23.3px + env(safe-area-inset-bottom, 0px) + var(--nav-lift)); /* paused → centre at 5/6 of bar height */
          width: 70px;
          height: 70px;
          transform-origin: 50% calc(100% + 125px); /* deep pivot → large rim radius (~160px) */
          transition: bottom 0.45s cubic-bezier(0.22, 1, 0.36, 1),
                      transform 0.4s cubic-bezier(0.22, 1, 0.36, 1);
          touch-action: none;                   /* swipe shouldn't scroll the page */
          pointer-events: auto;                 /* parent .tab-bar is pointer-events:none */
          cursor: pointer;
        }
        .np-vinyl-orbit.playing { bottom: calc(11.7px + env(safe-area-inset-bottom, 0px) + var(--nav-lift)); } /* playing → centre at 2/3 */
        .np-vinyl-orbit.empty { display: none; }
        /* While dragging / rebasing, only the transform is instant (finger-follow + seamless
           rebase); the bottom (play/pause height) keeps transitioning so it never snaps. */
        .np-vinyl-orbit.dragging {
          transition: bottom 0.45s cubic-bezier(0.22, 1, 0.36, 1), transform 0s;
        }
        /* Three records on the rim: prev/next wait at ±45° around the same pivot, hidden
           behind the bar at rest. Swiping rotates the orbit to bring one to centre. */
        .np-vinyl-slot {
          position: absolute;
          inset: 0;
          transform-origin: 50% calc(100% + 125px);
        }
        .np-vinyl-slot.prev { transform: rotate(-35deg); }
        .np-vinyl-slot.next { transform: rotate(35deg); }
        .np-vinyl-slot.current { transform: rotate(0deg); }
        .np-vinyl-float {
          width: 100%;
          height: 100%;
          border-radius: 50%;
          background: #444;
          overflow: hidden;
          pointer-events: none;                 /* the orbit owns clicks + drags */
          -webkit-mask: radial-gradient(circle at 50% 50%, transparent 0 6px, #000 7px);
          mask: radial-gradient(circle at 50% 50%, transparent 0 6px, #000 7px);
          animation: vinyl-spin 4s linear infinite;
          animation-play-state: paused;
        }
        .np-vinyl-orbit.playing .np-vinyl-float { animation-play-state: running; }
        .np-vinyl-float img { width: 100%; height: 100%; object-fit: cover; }
        @keyframes vinyl-spin { to { transform: rotate(360deg); } }

      </style>

      <div class="tab-content"></div>
      <div class="tab-bar"></div>
    `;

    this.renderTabs();
    this.renderTabBar();
  }

  /**
   * Render current tab content. Mounts all tabs once and toggles visibility to preserve state.
   */
  renderTabs() {
    const contentEl = this.shadowRoot.querySelector('.tab-content');
    const tabIds = ['discover', 'play', 'curate'];

    // Create and mount all tab elements on first run
    if (!this.tabElements.discover) {
      const discoverTab = document.createElement('discover-tab');
      discoverTab.addEventListener('enqueue-song', (e) => this.enqueueSong(e.detail.song));
      this.tabElements.discover = discoverTab;

      const playTab = document.createElement('play-tab');
      playTab.addEventListener('play-pause', () => playback.toggle());
      playTab.addEventListener('next', () => playback.next());
      playTab.addEventListener('previous', () => playback.previous());
      playTab.addEventListener('seek', (e) => playback.seekTo(e.detail.time));
      playTab.addEventListener('enqueue-song', (e) => this.enqueueSong(e.detail.song));
      this.tabElements.play = playTab;

      const curateTab = document.createElement('curate-tab');
      curateTab.addEventListener('enqueue-song', (e) => this.enqueueSong(e.detail.song));
      curateTab.addEventListener('search-online', (e) => this.searchOnline(e.detail.query));
      this.tabElements.curate = curateTab;

      contentEl.appendChild(this.tabElements.discover);
      contentEl.appendChild(this.tabElements.play);
      contentEl.appendChild(this.tabElements.curate);
    }

    // Toggle visibility only (preserves tab state)
    for (const id of tabIds) {
      this.tabElements[id].style.display = id === this.currentTab ? 'block' : 'none';
    }
  }

  /**
   * Render tab bar
   */
  renderTabBar() {
    const tabEl = this.shadowRoot.querySelector('.tab-bar');
    const tabs = [
      { id: 'discover', label: 'Discover', icon: '<svg viewBox="0 0 24 24"><path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z"/></svg>' },
      { id: 'play', label: 'Play', icon: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>' },
      { id: 'curate', label: 'Curate', icon: '<svg viewBox="0 0 24 24"><path d="M4 10.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zm0-6c-.83 0-1.5.67-1.5 1.5S3.17 7.5 4 7.5 5.5 6.83 5.5 6 4.83 4.5 4 4.5zm0 12c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zM7 19h14c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1z"/></svg>' }
    ];

    // Organic outline: tall Discover/Curate ends, a Play "valley" ~2/3 height in the
    // middle, joined by smooth S-curve slopes. Stretched to full width (aspect ignored).
    const topContour = 'M0,7 L300,7 C340,7 340,28 380,28 ' +
      'L620,28 C660,28 660,7 700,7 L1000,7';
    const bgSvg = `
      <svg class="tab-bar-bg" viewBox="0 0 1000 70" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="navFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#30323a"/>
            <stop offset="1" stop-color="#24262c"/>
          </linearGradient>
          <linearGradient id="navEdge" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#5ac8ff"/>
            <stop offset="0.5" stop-color="#8a7bff"/>
            <stop offset="1" stop-color="#5ac8ff"/>
          </linearGradient>
          <filter id="navGlow" x="-20%" y="-50%" width="140%" height="200%">
            <feGaussianBlur stdDeviation="3" result="b"/>
            <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>
        <path d="${topContour} L1000,70 L0,70 Z" fill="url(#navFill)"/>
        <path d="${topContour}" fill="none" stroke="url(#navEdge)" stroke-width="2"
              vector-effect="non-scaling-stroke" filter="url(#navGlow)"/>
      </svg>
    `;

    // Floating vinyl goes first so it paints *behind* the bar SVG (the Play panel hides
    // its lower half); buttons (incl. the always-present Play triangle) sit on top.
    tabEl.innerHTML = this.nowPlayingVinylHtml() + bgSvg + tabs.map(tab => `
      <button class="tab-button ${tab.id === this.currentTab ? 'active' : ''}" data-tab="${tab.id}" aria-label="${tab.label}">
        ${tab.icon}
        ${tab.id === 'play' ? '' : `<span>${tab.label}</span>`}
      </button>
    `).join('');

    // Remember which track the floating vinyl shows, so play/pause can skip rebuilding it.
    this._npSongId = this.currentSong?.id ?? null;
  }

  /**
   * Flip the active state on the tab buttons without rebuilding the bar (which would
   * recreate the vinyl and restart its spin).
   */
  updateTabBarActive() {
    const tabEl = this.shadowRoot.querySelector('.tab-bar');
    if (!tabEl) return;
    tabEl.querySelectorAll('.tab-button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === this.currentTab);
    });
  }

  /**
   * Markup for the now-playing vinyl that floats behind the nav bar, poking up out of the
   * Play valley. Hidden when nothing is loaded; spins while playing (toggled via .playing).
   * @returns {string}
   */
  nowPlayingVinylHtml() {
    const song = this.currentSong;
    const cls = `np-vinyl-orbit ${this.isPlaying ? 'playing' : ''} ${song ? '' : 'empty'}`;
    // DOM order prev, next, current so the current disc paints on top at rest.
    return `<div class="${cls}" aria-hidden="true">` +
      this.discSlotHtml('prev', this.peekPrevSong()) +
      this.discSlotHtml('next', this.peekNextSong()) +
      this.discSlotHtml('current', song) +
      `</div>`;
  }

  /**
   * One record on the carousel rim.
   * @param {string} role - 'prev' | 'current' | 'next'
   * @param {Object|null} s - song whose cover to show
   * @returns {string}
   */
  discSlotHtml(role, s) {
    const cover = s?.cover ? s.cover.replace(/"/g, '&quot;') : '';
    return `<div class="np-vinyl-slot ${role}">` +
      `<div class="np-vinyl-float">${cover ? `<img src="${cover}" alt="">` : ''}</div>` +
      `</div>`;
  }

  /**
   * The song that would play next, without consuming it. Delegates to NextTrack, which is the
   * single source of truth and resolves both the queue head and the otherwise-unpredictable
   * random feeder pick deterministically (peek == play), so the preview matches what plays.
   * @returns {Object|null}
   */
  peekNextSong() {
    return nextTrack.peek();
  }

  /**
   * The song that would play on "previous", without mutating history (mirrors
   * playPrevious): the most recent history entry, else the prior library track.
   * @returns {Object|null}
   */
  peekPrevSong() {
    const h = queueManager.history;
    if (Array.isArray(h) && h.length) return h[0];
    const songs = appState.get('songs') || [];
    const cur = this.currentSong;
    if (!songs.length || !cur) return null;
    const i = songs.findIndex(s => s.id === cur.id);
    if (i < 0) return null;
    return songs[i > 0 ? i - 1 : songs.length - 1];
  }

  /**
   * Update the floating vinyl in place. The cover is rebuilt only on a track change;
   * play/pause just toggles the spin so it resumes where it left off.
   */
  updateNowPlayingVinyl() {
    const orbit = this.shadowRoot.querySelector('.np-vinyl-orbit');
    if (!orbit) return;

    const song = this.currentSong;
    orbit.classList.toggle('empty', !song);
    orbit.classList.toggle('playing', !!this.isPlaying);

    const currentId = song?.id ?? null;
    if (currentId !== this._npSongId) {
      // Re-home the three covers for the new current track. Only the <img> is swapped
      // (the spinning .np-vinyl-float persists), so spin phase is never reset.
      this.setSlotCover(orbit, 'prev', this.peekPrevSong());
      this.setSlotCover(orbit, 'current', song);
      this.setSlotCover(orbit, 'next', this.peekNextSong());
      this._npSongId = currentId;
    }
  }

  /**
   * Swap just the cover image inside a slot's spinning disc.
   * @param {HTMLElement} orbit
   * @param {string} role
   * @param {Object|null} s
   */
  setSlotCover(orbit, role, s) {
    const disc = orbit.querySelector(`.np-vinyl-slot.${role} .np-vinyl-float`);
    if (!disc) return;
    const cover = s?.cover ? s.cover.replace(/"/g, '&quot;') : '';
    disc.innerHTML = cover ? `<img src="${cover}" alt="">` : '';
  }

  /**
   * Begin a drag on the now-playing record. A small move is treated as a tap (toggle
   * play/pause); a big enough horizontal swipe skips track on release.
   * @param {PointerEvent} event
   */
  onDiskPointerDown(event) {
    if (this._committing) return; // ignore input mid-switch
    const orbit = event.target.closest?.('.np-vinyl-orbit');
    if (!orbit || orbit.classList.contains('empty')) return;
    event.preventDefault();

    // Re-home the neighbour covers from the live queue/history so a queue change
    // since the last track switch is reflected on the disc the user is about to reveal.
    this.setSlotCover(orbit, 'prev', this.peekPrevSong());
    this.setSlotCover(orbit, 'next', this.peekNextSong());

    this._disk = { orbit, startX: event.clientX, dx: 0, moved: false, pointerId: event.pointerId };
    orbit.classList.add('dragging');
    orbit.setPointerCapture?.(event.pointerId);

    this._onDiskMove = this.onDiskPointerMove.bind(this);
    this._onDiskUp = this.onDiskPointerUp.bind(this);
    orbit.addEventListener('pointermove', this._onDiskMove);
    orbit.addEventListener('pointerup', this._onDiskUp);
    orbit.addEventListener('pointercancel', this._onDiskUp);
  }

  /**
   * Roll the record along the sphere rim as the finger moves: horizontal distance maps to
   * a rotation around the bottom-centre pivot (orbit's transform-origin).
   * @param {PointerEvent} event
   */
  onDiskPointerMove(event) {
    if (!this._disk) return;
    const dx = event.clientX - this._disk.startX;
    this._disk.dx = dx;
    if (Math.abs(dx) > 4) this._disk.moved = true;
    const angle = Math.max(-50, Math.min(50, dx * 0.3));
    this._disk.orbit.style.transform = `rotate(${angle}deg)`;
  }

  /**
   * Release the record: spring back to centre. A tap toggles play/pause; a swipe past the
   * threshold plays the next (swipe left) or previous (swipe right) track.
   * @param {PointerEvent} event
   */
  onDiskPointerUp(event) {
    const disk = this._disk;
    if (!disk) return;
    const { orbit, dx, moved } = disk;

    orbit.removeEventListener('pointermove', this._onDiskMove);
    orbit.removeEventListener('pointerup', this._onDiskUp);
    orbit.removeEventListener('pointercancel', this._onDiskUp);
    orbit.releasePointerCapture?.(event.pointerId);
    orbit.classList.remove('dragging');
    orbit.style.transform = ''; // animate back to rest (transition re-enabled)
    this._disk = null;

    const THRESHOLD = 90;
    if (dx <= -THRESHOLD) {
      this.commitSwipe(orbit, 'next');     // swipe left → next
    } else if (dx >= THRESHOLD) {
      this.commitSwipe(orbit, 'prev');     // swipe right → previous
    } else {
      orbit.style.transform = '';          // spring back to centre
      if (!moved) playback.toggle();  // a tap toggles play/pause
    }
  }

  /**
   * Finish a successful swipe: rotate the carousel until the incoming neighbour reaches
   * centre, then rebase to rest. The rebase resets the orbit to 0° AND re-homes the covers
   * in the same frame — because the neighbour disc and the 'current' slot share spin phase
   * and net transform at centre, swapping which one is centred is visually seamless.
   * @param {HTMLElement} orbit
   * @param {'next'|'prev'} dir
   */
  commitSwipe(orbit, dir) {
    const targetAngle = dir === 'next' ? -35 : 35; // bring that neighbour to centre (= slot spacing)
    this._committing = true;
    orbit.style.transform = `rotate(${targetAngle}deg)`; // animates (transition on)

    window.setTimeout(() => {
      orbit.classList.add('dragging');                  // disable transition
      orbit.style.transform = '';                       // orbit → 0°
      if (dir === 'next') playback.next(); else playback.previous(); // swaps covers to new roles
      void orbit.offsetWidth;                           // flush the 0° state without animating
      orbit.classList.remove('dragging');
      this._committing = false;
    }, 420); // ≳ the 0.4s transform transition, so the neighbour is centred before rebasing
  }

  disconnectedCallback() {
    if (this.unsubscribeState) {
      this.unsubscribeState();
    }
  }
}

customElements.define('music-app', MusicApp);