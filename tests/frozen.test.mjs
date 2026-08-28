import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Interpreter } from '../src/interpreter.js';
import { parse } from '../src/parser.js';
import { analyze } from '../src/analysis.js';

// Mutating something bound with `let`.
//
// `let` freezes the value, all the way down, and it freezes the value rather
// than the binding -- so a `var` can become unchangeable because a `let`
// somewhere else names the same list. That guarantee is deliberate and worth
// keeping. Finding out at run time, on whichever branch happened to execute,
// is not.
//
// Half of these tests are about staying quiet. The first version of this check
// reported `let ctx = context(50)` followed by `ctx.push(...)`, which is
// correct code: a context window is a live handle and `freezeDeep` does not
// touch it. Real examples caught that, which is why they are tested here.

const findings = (source) => analyze(parse(source, 't.smarsh'))
  .filter((f) => f.kind === 'frozen value');

const runs = (source) => {
  const interp = new Interpreter({ out: () => {}, seed: 1 });
  try {
    interp.run(source, 't.smarsh');
    return null;
  } catch (e) {
    return e.kind ?? 'error';
  } finally {
    interp.devices.shutdown();
  }
};

test('pushing to a list bound with let is reported', () => {
  const f = findings('let xs = []\nxs.push(1)');
  assert.equal(f.length, 1);
  assert.match(f[0].message, /`xs` was bound with `let`/);
  assert.match(f[0].hint, /var/);
});

test('the surprising case: a var frozen through an alias', () => {
  const f = findings('var ys = [1, 2]\nlet alias = ys\nys.push(3)');
  assert.equal(f.length, 1);
  assert.match(f[0].message, /frozen by `let alias = ys`/);
  assert.match(f[0].hint, /freezes the value, not the binding/);
});

test('every mutating shape is covered', () => {
  assert.equal(findings('let xs = [1]\nxs.pop()').length, 1);
  assert.equal(findings('let m = { }\nm.set("k", 1)').length, 1);
  assert.equal(findings('let xs = [1]\nxs[0] = 2').length, 1);
  assert.equal(findings('let m = { }\nm.k = 1').length, 1);
});

test('a var is not reported', () => {
  assert.equal(findings('var xs = []\nxs.push(1)').length, 0);
});

test('reading a frozen value is fine', () => {
  assert.equal(findings('let xs = [1, 2]\nprint(xs.len())\nprint(xs[0])').length, 0);
});

// ---------------------------------------------------------------------------
// where it must stay quiet
// ---------------------------------------------------------------------------

test('a live handle is not frozen, so pushing to one is not an error', () => {
  // The false positive that real examples caught. `freezeDeep` leaves handles
  // alone -- freezing one would break the thing it refers to.
  assert.equal(findings('let ctx = context(50)\nctx.push("text")').length, 0);
  assert.equal(findings('let bk = ledger("l")\nbk.append("e")').length, 0);
  assert.equal(runs('let ctx = context(50)\nctx.push("text")'), null,
    'the runtime allows it, so the checker must too');
});

test('a value whose type is not known from the source is left alone', () => {
  assert.equal(findings('fn make() { return [] }\nlet xs = make()\nxs.push(1)').length, 0);
  assert.equal(findings('fn f(xs) { xs.push(1) }').length, 0);
});

test('a name declared more than once is left alone', () => {
  // Two bindings of one name may be a `let` and a `var` in different scopes,
  // and this pass does not resolve scopes.
  assert.equal(findings('let xs = []\nfn f() { var xs = []\n  xs.push(1) }').length, 0);
});

test('an alias of something that is not a collection is left alone', () => {
  assert.equal(findings('var c = context(50)\nlet alias = c\nc.push("x")').length, 0);
});

// ---------------------------------------------------------------------------
// the checker and the runtime agree
// ---------------------------------------------------------------------------

test('what the checker reports, the runtime refuses', () => {
  for (const source of [
    'let xs = []\nxs.push(1)',
    'var ys = [1]\nlet alias = ys\nys.push(2)',
    'let m = { }\nm.set("k", 1)',
    'let xs = [1]\nxs[0] = 2',
  ]) {
    assert.ok(findings(source).length > 0, `not reported: ${source}`);
    assert.equal(runs(source), 'ImmutableError', `not refused at run time: ${source}`);
  }
});

test('what the checker passes, the runtime allows', () => {
  for (const source of [
    'var xs = []\nxs.push(1)',
    'let xs = [1, 2]\nprint(xs[0])',
    'let ctx = context(50)\nctx.push("x")',
  ]) {
    assert.equal(findings(source).length, 0, `wrongly reported: ${source}`);
    assert.equal(runs(source), null, `refused at run time: ${source}`);
  }
});
