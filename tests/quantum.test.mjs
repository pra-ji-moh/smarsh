import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Interpreter } from '../src/interpreter.js';
import { PedagError } from '../src/errors.js';
import { QubitRegister, GATES, rx, ry, rz } from '../src/quantum.js';
import { LogicalClock, Stamp, Liquid } from '../src/temporal.js';
import { Rng } from '../src/rng.js';

function run(src, opts = {}) {
  const out = [];
  const interp = new Interpreter({ ...opts, out: (s) => out.push(s) });
  const value = interp.run(src, '<test>');
  return { value, out, interp };
}

function fails(src, opts = {}) {
  try {
    run(src, opts);
  } catch (e) {
    if (e instanceof PedagError) return e;
    throw e;
  }
  throw new Error('expected the program to fail, but it ran cleanly');
}

const close = (a, b, tol = 1e-12) => Math.abs(a - b) < tol;

// ---------------------------------------------------------------------------
// quantum simulator
// ---------------------------------------------------------------------------

test('a fresh register is |0...0>', () => {
  const q = new QubitRegister(3);
  assert.equal(q.probabilities()[0], 1);
  assert.ok(close(q.norm(), 1));
});

test('X flips a qubit', () => {
  const q = new QubitRegister(1);
  q.apply(GATES.x, 0);
  assert.ok(close(q.probabilityOf(0), 1));
});

test('H creates an even superposition, and is its own inverse', () => {
  const q = new QubitRegister(1);
  q.apply(GATES.h, 0);
  assert.ok(close(q.probabilityOf(0), 0.5));
  q.apply(GATES.h, 0);
  assert.ok(close(q.probabilityOf(0), 0), 'H twice returns to |0>');
});

test('unitary gates preserve the norm', () => {
  const q = new QubitRegister(3);
  q.apply(GATES.h, 0);
  q.apply(rx(0.7), 1);
  q.apply(ry(1.3), 2);
  q.apply(rz(2.1), 0);
  q.applyControlled(GATES.x, 0, 1);
  q.applyControlled(GATES.z, 1, 2);
  q.swap(0, 2);
  assert.ok(close(q.norm(), 1, 1e-10), `norm drifted to ${q.norm()}`);
});

test('a Bell pair is genuinely entangled', () => {
  const q = new QubitRegister(2);
  q.apply(GATES.h, 0);
  q.applyControlled(GATES.x, 0, 1);
  const p = q.probabilities();
  assert.ok(close(p[0], 0.5), '|00> should hold half the amplitude');
  assert.ok(close(p[3], 0.5), '|11> should hold half the amplitude');
  assert.ok(close(p[1], 0) && close(p[2], 0), '|01> and |10> must be impossible');
});

test('measuring one half of a Bell pair determines the other', () => {
  for (let seed = 0; seed < 12; seed++) {
    const q = new QubitRegister(2);
    q.apply(GATES.h, 0);
    q.applyControlled(GATES.x, 0, 1);
    const rng = new Rng(seed);
    const first = q.measure(0, rng);
    const second = q.measure(1, rng);
    assert.equal(first, second, `seed ${seed}: entangled qubits disagreed`);
  }
});

test('measurement collapses: measuring twice gives the same answer', () => {
  const q = new QubitRegister(1);
  q.apply(GATES.h, 0);
  const rng = new Rng(5);
  const a = q.measure(0, rng);
  assert.equal(q.measure(0, rng), a);
  assert.equal(q.measure(0, rng), a);
});

test('measurement statistics match the amplitudes', () => {
  let ones = 0;
  const trials = 4000;
  for (let i = 0; i < trials; i++) {
    const q = new QubitRegister(1);
    q.apply(ry(2 * Math.acos(Math.sqrt(0.25))), 0);   // P(1) = 0.75
    ones += q.measure(0, new Rng(i));
  }
  const observed = ones / trials;
  assert.ok(Math.abs(observed - 0.75) < 0.03, `expected about 0.75, saw ${observed}`);
});

test('interference is real: H-Z-H turns |0> into |1>', () => {
  const q = new QubitRegister(1);
  q.apply(GATES.h, 0);
  q.apply(GATES.z, 0);
  q.apply(GATES.h, 0);
  assert.ok(close(q.probabilityOf(0), 1, 1e-12));
});

test('the register rejects nonsense', () => {
  assert.throws(() => new QubitRegister(0), /at least one qubit/);
  assert.throws(() => new QubitRegister(64), /stops at/);
  const q = new QubitRegister(2);
  assert.throws(() => q.apply(GATES.x, 5), /outside a register/);
  assert.throws(() => q.applyControlled(GATES.x, 1, 1), /two different qubits/);
});

test('quantum programs replay exactly under a seed', () => {
  const src = `
    let q = qubits(3)
    qh(q, 0)
    cnot(q, 0, 1)
    cnot(q, 1, 2)
    measure_all(q)
  `;
  assert.deepEqual(run(src, { seed: 11 }).value, run(src, { seed: 11 }).value);
});

test('a Bell pair measured from the language always agrees', () => {
  for (let seed = 0; seed < 8; seed++) {
    const { value } = run(`
      let q = qubits(2)
      qh(q, 0)
      cnot(q, 0, 1)
      measure_all(q)
    `, { seed });
    assert.equal(value[0], value[1], `seed ${seed}`);
  }
});

test('gates reach the language and report their register', () => {
  const { value } = run(`
    let q = qubits(2)
    qh(q, 0)
    qrx(q, 1, 0.5)
    [q.n, q.gates, q.norm() > 0.999]
  `);
  assert.deepEqual(value, [2, 2, true]);
});

test('measuring a qubit outside the register is an error', () => {
  assert.equal(fails('let q = qubits(2)\nmeasure(q, 7)').kind, 'IndexError');
});

// ---------------------------------------------------------------------------
// logical clocks
// ---------------------------------------------------------------------------

test('a clock advances on each local event', () => {
  const c = new LogicalClock('a');
  assert.equal(c.tick().counter, 1);
  assert.equal(c.tick().counter, 2);
});

test('merging adopts the sender knowledge and moves past it', () => {
  const a = new LogicalClock('a');
  const b = new LogicalClock('b');
  a.tick(); a.tick(); a.tick();          // a is at 3
  const fromA = a.tick();                // 4
  const atB = b.merge(fromA);
  assert.equal(atB.counter, 5);
  assert.ok(fromA.compare(atB) < 0, 'the receipt must order after the send');
});

test('the order is total and identical on every node', () => {
  const stamps = [new Stamp(2, 'b'), new Stamp(1, 'z'), new Stamp(2, 'a'), new Stamp(3, 'a')];
  const sortedOnce = [...stamps].sort((x, y) => x.compare(y));
  const sortedAgain = [...stamps].reverse().sort((x, y) => x.compare(y));
  assert.deepEqual(sortedOnce.map(String), sortedAgain.map(String));
  assert.deepEqual(sortedOnce.map((s) => `${s.counter}@${s.node}`), ['1@z', '2@a', '2@b', '3@a']);
});

test('concurrent events on different nodes still get a stable order', () => {
  const a = new LogicalClock('a');
  const b = new LogicalClock('b');
  const ea = a.tick();
  const eb = b.tick();
  assert.equal(ea.counter, eb.counter);
  assert.ok(ea.compare(eb) < 0, 'the node id breaks the tie deterministically');
  assert.equal(eb.compare(ea) > 0, true);
});

test('causality reaches the language', () => {
  const { value } = run(`
    let a = clock("node-a")
    let b = clock("node-b")
    let sent = a.tick()
    let got = b.merge(sent)
    [before(sent, got), before(got, sent), got.counter]
  `);
  assert.deepEqual(value, [true, false, 2]);
});

test('before() insists on stamps', () => {
  assert.equal(fails('before(1, 2)').kind, 'TypeError');
});

// ---------------------------------------------------------------------------
// decaying values
// ---------------------------------------------------------------------------

test('a liquid value halves over its half-life', () => {
  const l = new Liquid(1000, 30, 0);
  assert.equal(l.at(0), 1000);
  assert.ok(close(l.at(30), 500));
  assert.ok(close(l.at(60), 250));
});

test('time_to inverts the decay', () => {
  const l = new Liquid(1000, 30, 0);
  assert.ok(close(l.timeTo(250, 0), 60, 1e-9));
  assert.equal(l.timeTo(2000, 0), null, 'it never rises to above its start');
});

test('arithmetic on a liquid value uses its worth now', () => {
  const { value } = run(`
    let edge = liquid(1000, 10)
    let a = edge + 0
    advance(10)
    let b = edge + 0
    advance(10)
    [a, b, edge + 0, edge.initial]
  `);
  assert.ok(close(value[0], 1000));
  assert.ok(close(value[1], 500));
  assert.ok(close(value[2], 250));
  assert.equal(value[3], 1000, '.initial stays put');
});

test('comparisons see the decayed value', () => {
  const { value } = run(`
    let quote = liquid(100, 5)
    let fresh = quote > 90
    advance(10)
    [fresh, quote > 90, quote > 20]
  `);
  assert.deepEqual(value, [true, false, true]);
});

test('logical time only moves when the program moves it', () => {
  const { value } = run('let t0 = time()\nadvance(7)\n[t0, time()]');
  assert.deepEqual(value, [0, 7]);
  assert.equal(fails('advance(-1)').kind, 'ValueError');
});

test('a decay schedule replays identically', () => {
  const src = 'let l = liquid(500, 12)\nadvance(6)\nl + 0';
  assert.equal(run(src, { seed: 1 }).value, run(src, { seed: 99 }).value);
});

test('a half-life must be positive', () => {
  assert.equal(fails('liquid(100, 0)').kind, 'ValueError');
});
