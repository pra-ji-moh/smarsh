import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Interpreter } from '../src/interpreter.js';
import { PedagError } from '../src/errors.js';
import { parse } from '../src/parser.js';
import { formatSource } from '../src/format.js';
import { typecheck } from '../src/types.js';

// `19.99d` -- a decimal literal, and negation of a decimal.
//
// Money is the language's flagship type and had neither. Every amount was
// `dec("19.99")`, and negating one -- a refund, a credit, a reversal -- was a
// TypeError that forced `dec("0") - amount`.
//
// The literal exists so that the digits never pass through a float. `dec(0.1)`
// would have lost the value before `dec` saw it, which is why `dec` takes a
// string; `0.1d` is read straight from the source text for the same reason.

function run(source, compiled = true) {
  const out = [];
  const interp = new Interpreter({ out: (s) => out.push(s), seed: 1 });
  interp.compiled = compiled;
  try {
    interp.run(source, 't.pedag');
    return { out, error: null };
  } catch (e) {
    return { out, error: e.kind ?? 'error' };
  } finally {
    interp.devices.shutdown();
  }
}

const both = (source) => {
  const fast = run(source, true);
  const tree = run(source, false);
  assert.deepEqual(fast, tree, 'the two engines disagree');
  return fast;
};

test('a decimal literal is exact, and is a dec', () => {
  assert.deepEqual(both('print(19.99d)').out, ['19.99']);
  assert.deepEqual(both('print(type(19.99d))').out, ['dec']);
  assert.deepEqual(both('print(0.1d + 0.2d == 0.3d)').out, ['true']);
  // The same value written the long way, to show nothing is lost on the way.
  assert.deepEqual(both('print(19.99d == dec("19.99"))').out, ['true']);
});

test('the digits never pass through a float', () => {
  // 0.1 cannot be held by a `num`; if the literal were parsed as one first and
  // then converted, this would not be exact.
  assert.deepEqual(both('print(0.1d)').out, ['0.1']);
  assert.deepEqual(both('var t = 0.00d\nfor i in range(1000) { t = t + 0.01d }\nprint(t)').out, ['10.00']);
  assert.deepEqual(both('print(0.1 + 0.2 == 0.3)').out, ['false'], 'floats are still floats');
});

test('scale is kept as written', () => {
  assert.deepEqual(both('print(1.50d)').out, ['1.50']);
  assert.deepEqual(both('print(1.5d)').out, ['1.5']);
  assert.deepEqual(both('print(10.00d - 1.00d)').out, ['9.00']);
});

test('a whole number can be a decimal too', () => {
  assert.deepEqual(both('print(2d + 3d)').out, ['5']);
  assert.deepEqual(both('print(type(2d))').out, ['dec']);
});

test('negating a decimal works, on both engines', () => {
  assert.deepEqual(both('print(-19.99d)').out, ['-19.99']);
  assert.deepEqual(both('let a = 3.50d\nprint(-a)').out, ['-3.50']);
  assert.deepEqual(both('print(-dec("2.25"))').out, ['-2.25']);
  assert.deepEqual(both('let a = 5.00d\nprint(-(-a))').out, ['5.00']);
});

test('the refusal to mix with floats is unchanged', () => {
  assert.equal(both('print(19.99d + 0.1)').error, 'TypeError');
  assert.equal(both('print(19.99d * 3)').error, null, 'a whole number is still allowed');
  assert.deepEqual(both('print(19.99d * 3)').out, ['59.97']);
});

// ---------------------------------------------------------------------------
// the lexer has to get the boundary right
// ---------------------------------------------------------------------------

test('`d` is still an ordinary name', () => {
  assert.deepEqual(both('var d = 5\nprint(d)').out, ['5']);
  assert.deepEqual(both('fn d(x) { return x }\nprint(d(1))').out, ['1']);
  assert.deepEqual(both('var d = 1\nd = d + 1\nprint(d)').out, ['2']);
});

test('a number followed by a name is not a decimal literal', () => {
  // `2 dozen` is two tokens; only `d` immediately after digits, and not itself
  // the start of a longer name, makes a decimal.
  assert.doesNotThrow(() => parse('let dozen = 12\nprint(2 * dozen)', 't.pedag'));
  assert.deepEqual(both('let dozen = 12\nprint(2 * dozen)').out, ['24']);
  assert.deepEqual(both('let data = [1]\nprint(len(data))').out, ['1']);
});

test('an exponent cannot be a decimal literal', () => {
  // `1e3d` would be a value that came through a float, which is the thing the
  // literal exists to avoid. It is refused rather than quietly converted.
  assert.throws(() => parse('print(1e3d)', 't.pedag'),
    (e) => e instanceof PedagError && /exponent/.test(e.message));
});

test('a decimal literal works everywhere a value does', () => {
  assert.deepEqual(both('print([1.5d, 2.5d])').out, ['[1.5, 2.5]']);
  assert.deepEqual(both('print({ "k": 1.5d }["k"])').out, ['1.5']);
  assert.deepEqual(both('fn f(x) { return x + 1.00d }\nprint(f(2.00d))').out, ['3.00']);
  assert.deepEqual(both('record M(amount)\nprint(M(9.99d).amount)').out, ['9.99']);
  assert.deepEqual(both('print("cost ${4.20d}")').out, ['cost 4.20']);
});

// ---------------------------------------------------------------------------
// the tools have to know about it
// ---------------------------------------------------------------------------

test('the formatter round-trips it without rounding', () => {
  for (const source of ['let a = 19.99d\n', 'let a = 0.10d\n', 'let a = 2d\n', 'let a = -1.5d\n']) {
    const once = formatSource(source, 't.pedag');
    assert.equal(formatSource(once, 't.pedag'), once, 'formatting is not stable');
    assert.doesNotThrow(() => parse(once, 't.pedag'));
    assert.match(once, /d$/m, `the suffix was lost: ${once}`);
  }
  // The digits themselves must survive exactly.
  assert.match(formatSource('let a = 1.50d\n', 't.pedag'), /1\.50d/);
});

test('the type checker sees a dec', () => {
  const interp = new Interpreter({ out: () => {} });
  const builtins = [...interp.prelude.vars.keys()];
  interp.devices.shutdown();
  const messages = (source) => typecheck(parse(source, 't.pedag'), { builtins }).map((d) => d.message);

  // Annotated as dec and initialised with a literal: consistent, so silent.
  assert.deepEqual(messages('let a: dec = 19.99d'), []);
  // Annotated as num: caught, because a literal is a dec and not a float.
  assert.ok(messages('let a: num = 19.99d').length > 0,
    'a decimal literal bound to a num was not reported');
});
