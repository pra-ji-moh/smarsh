import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parse } from '../src/parser.js';
import { verifyProgram } from '../src/verify.js';
import { proveSource } from '../src/prove.js';
import {
  Rat, Linear, atom, and, or, not, implies, isValid, isSatisfiable, satisfiable, TRUE, FALSE,
} from '../src/logic.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

const verify = (src) => verifyProgram(parse(src, '<t>'));
const outcome = (src, name = null) => {
  const results = verify(src);
  const chosen = name ? results.filter((r) => r.fn === name) : results;
  if (chosen.some((r) => r.result === false)) return 'refuted';
  if (chosen.some((r) => r.result === 'unknown')) return 'unknown';
  return chosen.length === 0 ? 'nothing' : 'proved';
};

// ---------------------------------------------------------------------------
// exact rationals
// ---------------------------------------------------------------------------

test('rationals are exact, and reduced', () => {
  assert.equal(new Rat(1n, 3n).add(new Rat(2n, 3n)).toString(), '1');
  assert.equal(new Rat(1n, 3n).mul(new Rat(3n, 1n)).toString(), '1');
  assert.equal(new Rat(2n, 4n).toString(), '1/2', 'rationals stay reduced');
  assert.equal(new Rat(1n, -2n).toString(), '-1/2', 'sign is normalised onto the numerator');
});

test('a float literal becomes the number the machine holds, not the one written', () => {
  // The distinction that stops the verifier proving `0.1 + 0.2 == 0.3`.
  const asWritten = Rat.ofDecimal('0.1');
  const asStored = Rat.ofDouble(0.1);
  assert.equal(asWritten.toString(), '1/10');
  assert.notEqual(asStored.toString(), '1/10');
  assert.equal(asStored.toString(), '3602879701896397/36028797018963968');

  // And so the sum of the stored values is not the stored 0.3.
  const sum = Rat.ofDouble(0.1).add(Rat.ofDouble(0.2));
  assert.notEqual(sum.cmp(Rat.ofDouble(0.3)), 0);

  // Exact decimals, meanwhile, really are exact.
  assert.equal(Rat.ofDecimal('0.1').add(Rat.ofDecimal('0.2')).cmp(Rat.ofDecimal('0.3')), 0);
});

test('the verifier does not prove a float identity that the runtime breaks', () => {
  assert.equal(isValid(atom('=', Linear.constant(Rat.ofDouble(0.1))
    .add(Linear.constant(Rat.ofDouble(0.2)))
    .sub(Linear.constant(Rat.ofDouble(0.3))))), false);
});

test('integers and subnormals round-trip', () => {
  assert.equal(Rat.of(42).toString(), '42');
  assert.equal(Rat.of(-7).toString(), '-7');
  assert.equal(Rat.of(0).toString(), '0');
  assert.equal(Rat.ofDouble(0.5).toString(), '1/2');
  assert.equal(Rat.ofDouble(-0.25).toString(), '-1/4');
  assert.ok(Rat.ofDouble(Number.MIN_VALUE).sign > 0, 'the smallest subnormal is positive');
});

test('rational comparison and division behave', () => {
  assert.equal(Rat.of(3).div(Rat.of(2)).toString(), '3/2');
  assert.equal(Rat.of(1).cmp(Rat.of(2)), -1);
  assert.equal(Rat.of(2).cmp(Rat.of(2)), 0);
  assert.throws(() => Rat.of(1).div(Rat.of(0)), /division by zero/);
});

// ---------------------------------------------------------------------------
// the decision procedure
// ---------------------------------------------------------------------------

const x = Linear.variable('x');
const y = Linear.variable('y');
const c = (n) => Linear.constant(n);

test('Fourier-Motzkin decides simple systems', () => {
  // x <= 5 and x >= 10 is a contradiction.
  assert.equal(satisfiable([
    { linear: x.sub(c(5)), strict: false },
    { linear: c(10).sub(x), strict: false },
  ]), false);

  // x <= 10 and x >= 5 is fine.
  assert.equal(satisfiable([
    { linear: x.sub(c(10)), strict: false },
    { linear: c(5).sub(x), strict: false },
  ]), true);
});

test('strictness is handled correctly', () => {
  // x < 0 and x >= 0
  assert.equal(satisfiable([
    { linear: x, strict: true },
    { linear: x.neg(), strict: false },
  ]), false);
  // x <= 0 and x >= 0 is satisfiable at zero.
  assert.equal(satisfiable([
    { linear: x, strict: false },
    { linear: x.neg(), strict: false },
  ]), true);
});

test('several variables are eliminated in turn', () => {
  // x + y <= 1, x >= 1, y >= 1 is a contradiction.
  assert.equal(satisfiable([
    { linear: x.add(y).sub(c(1)), strict: false },
    { linear: c(1).sub(x), strict: false },
    { linear: c(1).sub(y), strict: false },
  ]), false);
});

test('validity is decided over the boolean structure', () => {
  // x >= 0 implies 2x >= x
  assert.equal(isValid(implies(atom('<=', c(0).sub(x)), atom('<=', x.sub(x.scale(2))))), true);
  // x >= 0 does not imply x >= 1
  assert.equal(isValid(implies(atom('<=', c(0).sub(x)), atom('<=', c(1).sub(x)))), false);
});

test('disequalities are split rather than given up on', () => {
  // x == 5 implies x != 6
  assert.equal(isValid(implies(atom('=', x.sub(c(5))), not(atom('=', x.sub(c(6)))))), true);
  // a trivially true equality
  assert.equal(isValid(atom('=', c(0))), true);
});

test('constants and boolean shortcuts', () => {
  assert.equal(isValid(TRUE), true);
  assert.equal(isValid(FALSE), false);
  assert.equal(isValid(or(atom('<=', x), not(atom('<=', x)))), true, 'excluded middle');
  assert.equal(isSatisfiable(and(atom('<=', x), not(atom('<=', x)))), false);
});

// ---------------------------------------------------------------------------
// proving contracts
// ---------------------------------------------------------------------------

test('a true postcondition is proved for every input', () => {
  assert.equal(outcome('fn f(x) requires x >= 0 ensures result >= x { return x * 2 }'), 'proved');
  assert.equal(outcome('fn f(a, b) requires a > 0 requires b > 0 ensures result > a { return a + b }'), 'proved');
  assert.equal(outcome('fn f(x) ensures result == x + 10 { return x + 10 }'), 'proved');
});

test('a false postcondition in linear arithmetic is refuted', () => {
  assert.equal(outcome('fn f(x) ensures result > x { return x }'), 'refuted');
  assert.equal(outcome('fn f(x) requires x > 0 ensures result < 0 { return x }'), 'refuted');
});

test('a false postcondition beyond linear arithmetic is undecided, not refuted', () => {
  // `x * k` is non-linear, so the solver only knows an unconstrained value. It
  // must not claim a refutation it cannot justify -- even though this contract
  // really is false, which is exactly what `prove` is for.
  assert.equal(outcome('fn f(x, k) requires k > 0 ensures result >= x { return x * k }'), 'unknown');

  const counterexamples = proveSource(
    'fn f(x, k) requires k > 0 ensures result >= x { return x * k }', { trials: 120 },
  );
  assert.ok(counterexamples[0].violations.length > 0,
    'the tester should catch what the prover cannot decide');
});

test('both branches are verified separately', () => {
  const results = verify('fn f(x) ensures result >= 0 { if x < 0 { return -x } return x }');
  assert.equal(results.length, 2, 'one condition per path');
  assert.ok(results.every((r) => r.result === true));
});

test('a branch that breaks the promise is caught even when the other holds', () => {
  const results = verify('fn f(x) ensures result >= 0 { if x < 0 { return x } return x }');
  assert.equal(results.filter((r) => r.result === false).length, 1);
  assert.equal(results.filter((r) => r.result === true).length, 1);
});

test('the precondition is what makes a postcondition provable', () => {
  assert.equal(outcome('fn f(x) ensures result >= 0 { return x }'), 'refuted');
  assert.equal(outcome('fn f(x) requires x >= 0 ensures result >= 0 { return x }'), 'proved');
});

// ---------------------------------------------------------------------------
// proving loops
// ---------------------------------------------------------------------------

test('a well-annotated loop is proved on all four counts', () => {
  const results = verify(`
    fn countdown(from) requires from >= 0 {
      var i = from
      while i >= 1 invariant i >= 0 variant i { i = i - 1 }
      return i
    }
  `);
  assert.ok(results.length >= 4);
  assert.ok(results.every((r) => r.result === true), 'every obligation should be proved');
  const kinds = new Set(results.map((r) => r.kind));
  assert.ok(kinds.has('loop-established'));
  assert.ok(kinds.has('loop-preserved'));
  assert.ok(kinds.has('variant-decreases'));
  assert.ok(kinds.has('variant-nonnegative'));
});

test('a variant that grows is refuted', () => {
  const results = verify(`
    fn spin(n) requires n > 0 {
      var i = 0
      while i < n invariant i >= 0 variant n - i { i = i - 1 }
      return i
    }
  `);
  assert.ok(results.some((r) => r.kind === 'variant-decreases' && r.result === false));
});

test('an invariant that does not survive a pass is refuted', () => {
  const results = verify(`
    fn f(n) requires n > 0 {
      var i = 0
      while i < n invariant i < 1 variant n - i { i = i + 1 }
      return i
    }
  `);
  assert.ok(results.some((r) => r.kind === 'loop-preserved' && r.result === false));
});

test('an invariant false on entry is refuted', () => {
  const results = verify(`
    fn f() {
      var i = 0
      while i < 3 invariant i >= 5 variant 3 - i { i = i + 1 }
      return i
    }
  `);
  assert.ok(results.some((r) => r.kind === 'loop-established' && r.result === false));
});

test('the rational domain is respected, and that is not a bug', () => {
  // `i > 0` does not give `i - 1 >= 0` unless i is an integer, and Smarsh's `num`
  // is a float. Refuting this is correct: countdown(0.5) really does break it.
  const results = verify(`
    fn f(from) requires from >= 0 {
      var i = from
      while i > 0 invariant i >= 0 variant i { i = i - 1 }
      return i
    }
  `);
  assert.ok(results.some((r) => r.kind === 'loop-preserved' && r.result === false));
});

// ---------------------------------------------------------------------------
// honesty about the limits
// ---------------------------------------------------------------------------

test('what it cannot decide, it says it cannot decide', () => {
  // A non-linear postcondition: the solver has no theory for it.
  const results = verify('fn f(a, b) requires a > 1 requires b > 1 ensures result > a { return a * b }');
  assert.ok(results.every((r) => r.result !== false),
    'it must not claim a refutation it cannot justify');
});

test('an unannotated loop leaves the state unknown rather than assumed', () => {
  const results = verify(`
    fn f(n) ensures result >= 0 {
      var i = 0
      while i < n { i = i + 1 }
      return i
    }
  `);
  // Nothing is known about i after an unannotated loop, so the promise cannot
  // be proved -- and the verifier must not pretend otherwise.
  assert.ok(results.every((r) => r.result !== true) || results.length === 0);
});

test('a function with no contract produces no obligations', () => {
  assert.deepEqual(verify('fn f(x) { return x + 1 }'), []);
});

// ---------------------------------------------------------------------------
// the two tools must agree
// ---------------------------------------------------------------------------

test('verify and prove agree on the shipped contracts example', () => {
  const source = fs.readFileSync(path.join(ROOT, 'examples', 'contracts.smarsh'), 'utf8');
  const verified = verifyProgram(parse(source, 'contracts.smarsh'));
  const proved = proveSource(source, { trials: 120 });

  const refutedByVerify = new Set(verified.filter((r) => r.result === false).map((r) => r.fn));
  const brokenByProve = new Set(
    proved.filter((r) => r.violations && (r.violations.length > 0 || r.crashes.length > 0)).map((r) => r.name),
  );

  // Anything the verifier refutes, the tester should be able to break.
  for (const name of refutedByVerify) {
    assert.ok(brokenByProve.has(name),
      `verify refuted ${name} but prove could not find a counterexample`);
  }
  // And anything the tester broke must not have been claimed as proved.
  const provedNames = new Set(
    verified.filter((r) => r.result === true).map((r) => r.fn),
  );
  for (const name of brokenByProve) {
    assert.ok(!provedNames.has(name) || refutedByVerify.has(name),
      `verify claimed ${name} was proved but prove found a counterexample — the verifier is unsound`);
  }
});

test('soundness: nothing proved may have a counterexample', () => {
  // The property that matters most. If this ever fails, the verifier is lying.
  const cases = [
    'fn a(x) requires x >= 0 ensures result >= x { return x * 2 }',
    'fn b(x) ensures result >= 0 { if x < 0 { return -x } return x }',
    'fn c(x, y) requires x > y ensures result > 0 { return x - y }',
    'fn d(x) requires x >= 2 ensures result >= 4 { return x + 2 }',
  ];
  for (const src of cases) {
    const verified = verifyProgram(parse(src, '<t>'));
    if (!verified.every((r) => r.result === true)) continue;
    const proved = proveSource(src, { trials: 300 });
    for (const r of proved) {
      assert.equal(r.violations.length + r.crashes.length, 0,
        `verify proved ${r.name} but prove found a counterexample`);
    }
  }
});
