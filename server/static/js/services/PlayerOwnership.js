/**
 * PlayerOwnership - ensures only ONE copy of the app produces audio on a device.
 *
 * Why this exists: iOS sometimes relaunches the home-screen app on unlock, spinning up a
 * brand-new page while the previous page's <audio> keeps sounding in the background. The old
 * page's JS is suspended (its requests stop reaching the server), so the new page restores a
 * stale resume point and starts its own playback; when the old page thaws (typically on its
 * track's 'ended') it advances to its own next song, and two tracks play over each other.
 *
 * The fix is a per-device "owner" token in localStorage (shared by every copy of the app on the
 * device, and readable synchronously the moment a thawed page runs any JS):
 *   - whichever copy starts playback claims ownership (claim()),
 *   - every other copy yields — pauses — as soon as it notices (BroadcastChannel / 'storage'
 *     event while alive, or isOwner() checks on its own timeupdate/ended handlers after a thaw),
 *   - only the owner may auto-advance or write the resume point.
 * The owner also mirrors its resume point into localStorage, which keeps working when a
 * backgrounded page can no longer reach the network, so a relaunched page resumes from the
 * real position rather than the last one the server happened to receive.
 *
 * Usage:
 *   import ownership from './PlayerOwnership.js';
 *   ownership.onYield(() => pauseEverything());
 *   ownership.claim();               // before starting playback
 *   if (!ownership.isOwner()) return; // before auto-advancing / persisting
 *   ownership.saveLocalResume(songId, position);
 *   ownership.loadLocalResume();     // → { songId, position, at } | null
 */

const OWNER_KEY = 'sm4.playerOwner';
const RESUME_KEY = 'sm4.resumePoint';
const CHANNEL_NAME = 'sm4-player';

/**
 * Read a localStorage key, tolerating storage being unavailable.
 * @param {string} key
 * @returns {string|null}
 */
function read(key) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}

/**
 * Write a localStorage key, tolerating storage being unavailable.
 * @param {string} key
 * @param {string} value
 */
function write(key, value) {
  try { localStorage.setItem(key, value); } catch (_) {}
}

class PlayerOwnership {
  constructor() {
    this.id = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random()}`;
    this.channel = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL_NAME) : null;
  }

  /** Make this copy the device's player and tell any other live copy to stop. */
  claim() {
    if (read(OWNER_KEY) === this.id) return;
    write(OWNER_KEY, this.id);
    this.channel?.postMessage({ type: 'claim', id: this.id });
  }

  /**
   * Whether this copy may play / advance / persist. True when it holds the token, or when no
   * copy has claimed yet (fresh install, or storage unavailable).
   * @returns {boolean}
   */
  isOwner() {
    const owner = read(OWNER_KEY);
    return !owner || owner === this.id;
  }

  /**
   * Run `callback` whenever another copy claims ownership while this one is alive.
   * @param {() => void} callback
   */
  onYield(callback) {
    this.channel?.addEventListener('message', (e) => {
      if (e.data?.type === 'claim' && e.data.id !== this.id) callback();
    });
    window.addEventListener('storage', (e) => {
      if (e.key === OWNER_KEY && e.newValue && e.newValue !== this.id) callback();
    });
  }

  /**
   * Mirror the resume point locally (works even when the network is cut off in background).
   * @param {number|null} songId
   * @param {number} position - seconds
   */
  saveLocalResume(songId, position) {
    write(RESUME_KEY, JSON.stringify({ songId, position, at: Date.now() }));
  }

  /**
   * @returns {{songId: number|null, position: number, at: number}|null}
   */
  loadLocalResume() {
    try { return JSON.parse(read(RESUME_KEY)) || null; } catch (_) { return null; }
  }
}

const playerOwnership = new PlayerOwnership();

export default playerOwnership;
