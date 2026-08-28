import { NativeFunction, unwrap } from './values.js';
import { smarshError } from './errors.js';

const nf = (name, arity, fn) => new NativeFunction(name, arity, fn);

// ---------------------------------------------------------------------------
// Distributed ordering
// ---------------------------------------------------------------------------
//
// Two machines cannot agree on "now" to the nanosecond: clocks drift, and no
// synchronisation protocol removes that. So this does not try. A Lamport clock
// with a node-id tiebreak gives what ordering actually needs -- a deterministic
// total order, identical on every node, consistent with causality -- precisely
// because it never reads a wall clock. There is nothing to drift.
//
// If you need to correlate with human time, stamp events with `now()` under the
// `clock` capability and accept that those readings drift. Ordering stays here.

export class Stamp {
  constructor(counter, node) {
    this.counter = counter;
    this.node = node;
  }
  get smarshType() { return 'stamp'; }

  // Total order: counter first, node id as the tiebreak.
  compare(other) {
    if (this.counter !== other.counter) return this.counter < other.counter ? -1 : 1;
    if (this.node === other.node) return 0;
    return this.node < other.node ? -1 : 1;
  }

  toString() { return `<stamp ${this.counter}@${this.node}>`; }
  smarshMembers() {
    return { counter: this.counter, node: this.node };
  }
}

export class LogicalClock {
  constructor(node) {
    this.node = node;
    this.counter = 0;
  }
  get smarshType() { return 'clock'; }

  // A local event.
  tick() {
    this.counter += 1;
    return new Stamp(this.counter, this.node);
  }

  // Receiving a message: adopt the sender's knowledge, then stamp the receipt.
  merge(stamp) {
    this.counter = Math.max(this.counter, stamp.counter) + 1;
    return new Stamp(this.counter, this.node);
  }

  // Learning of an event without treating it as one.
  observe(stamp) {
    this.counter = Math.max(this.counter, stamp.counter);
    return this.counter;
  }

  toString() { return `<clock ${this.node} at ${this.counter}>`; }
  smarshMembers(interp, line) {
    return {
      node: this.node,
      counter: this.counter,
      tick: nf('tick', 0, () => this.tick()),
      merge: nf('merge', 1, (a, l) => this.merge(expectStamp(a[0], l))),
      observe: nf('observe', 1, (a, l) => this.observe(expectStamp(a[0], l))),
    };
  }
}

function expectStamp(v, line) {
  const u = unwrap(v);
  if (!(u instanceof Stamp)) {
    throw smarshError('TypeError', 'this needs a stamp from another clock', line);
  }
  return u;
}

// ---------------------------------------------------------------------------
// Decaying values
// ---------------------------------------------------------------------------
//
// A quantity that is worth less the longer it sits: an order's edge, a quote,
// a cached belief. It is not a float that someone remembers to discount -- the
// discount is the type. Arithmetic on it uses its value at the current logical
// time, so it behaves like a float that keeps moving as time advances.
//
// Time here is the interpreter's logical tick, advanced by `advance(n)`, not a
// wall clock -- so a decay schedule replays identically.

export class Liquid {
  constructor(initial, halflife, anchor = 0) {
    this.initial = initial;
    this.halflife = halflife;
    this.anchor = anchor;
  }
  get smarshType() { return 'liquid'; }

  at(t) {
    return this.initial * (0.5 ** ((t - this.anchor) / this.halflife));
  }

  // Time until the value falls to `target`, or nil if it never does.
  timeTo(target, from) {
    if (target <= 0 || this.initial <= 0 || target >= this.initial) return null;
    return this.anchor + this.halflife * (Math.log(target / this.initial) / Math.log(0.5)) - from;
  }

  toString() { return `<liquid ${this.initial} halving every ${this.halflife}>`; }

  smarshMembers(interp) {
    const now = interp.logicalTime;
    return {
      initial: this.initial,
      halflife: this.halflife,
      anchor: this.anchor,
      now: nf('now', 0, () => this.at(interp.logicalTime)),
      at: nf('at', 1, (a, line) => this.at(interp.asNumber(a[0], 'a time', line))),
      decayed: nf('decayed', 0, () => this.initial - this.at(interp.logicalTime)),
      time_to: nf('time_to', 1, (a, line) =>
        this.timeTo(interp.asNumber(a[0], 'a target value', line), interp.logicalTime)),
      value: this.at(now),
    };
  }
}
