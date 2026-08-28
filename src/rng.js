// Smarsh's probabilistic control flow is non-deterministic *in semantics* but
// reproducible *in execution*: every run with the same seed takes the same
// branches. Without this, a language with `maybe` in it would be untestable and
// undebuggable. mulberry32 -- small, fast, decent distribution, fully portable.

export class Rng {
  constructor(seed = 0) {
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Each forked reasoning path gets its own stream, derived from this one by
  // index. Paths diverge from each other, but the whole fan-out replays
  // identically on the next run.
  fork(index) {
    return new Rng((this.state ^ Math.imul(index + 1, 0x85ebca6b)) >>> 0);
  }

  // Box-Muller, for randn().
  normal() {
    const u = Math.max(this.next(), Number.MIN_VALUE);
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}
