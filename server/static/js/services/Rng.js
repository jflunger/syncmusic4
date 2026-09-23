/**
 * Rng - tiny seedable PRNG (mulberry32). No dependencies, no build step.
 *
 * The whole point of this class is a *peekable* random sequence: because the state is a single
 * 32-bit integer you can read it with getState(), run some draws on a fork, and only commit the
 * advanced state back if you decide to "keep" those draws. This lets NextTrack preview the exact
 * random song that will later play (peek == play) by resolving on a fork and committing on take.
 *
 * Usage:
 *   const rng = new Rng();                 // seeded from Date.now()
 *   const fork = Rng.from(rng.getState()); // independent copy at the same point in the sequence
 *   fork.int(n);                           // draw without touching `rng`
 *   rng.setState(fork.getState());         // later: commit the fork's draws onto `rng`
 */
class Rng {
  /**
   * @param {number} [seed] - 32-bit seed; defaults to a time-based seed.
   */
  constructor(seed) {
    this.state = (seed != null ? seed : Date.now()) >>> 0;
  }

  /**
   * Build an independent Rng positioned at a given state (a "fork" of an existing sequence).
   * @param {number} state
   * @returns {Rng}
   */
  static from(state) {
    return new Rng(state >>> 0);
  }

  /** @returns {number} The current internal state (a 32-bit uint). */
  getState() {
    return this.state >>> 0;
  }

  /** @param {number} state - State to restore (e.g. to commit a fork's draws). */
  setState(state) {
    this.state = state >>> 0;
  }

  /**
   * Advance the sequence and return a float in [0, 1). (mulberry32.)
   * @returns {number}
   */
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Draw an integer in [0, n). Returns 0 for n <= 0.
   * @param {number} n - Exclusive upper bound.
   * @returns {number}
   */
  int(n) {
    if (n <= 0) return 0;
    return Math.floor(this.next() * n);
  }
}

export default Rng;
