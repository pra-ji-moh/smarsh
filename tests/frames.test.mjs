import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Interpreter } from '../src/interpreter.js';

// Frames are reused between calls when nothing can capture them, and scopes
// reuse their storage between loop passes. Both are invisible when they work
// and produce wrong answers rather than crashes when they do not, so the shapes
// that broke while they were being built are pinned here.

function run(source, compiled) {
  const out = [];
  const interp = new Interpreter({ out: (s) => out.push(s), seed: 1 });
  interp.compiled = compiled;
  interp.stepLimit = 5000000;
  try {
    interp.run(source, 't.smarsh');
    return out;
  } finally {
    interp.devices.shutdown();
  }
}

// Both engines share callValue, so a bug in frame reuse shows up in both and
// the differential harness cannot see it. These assert the answer itself.
const bothEngines = (lines) => {
  const source = lines.join('\n');
  const fast = run(source, true);
  const tree = run(source, false);
  assert.deepEqual(fast, tree, 'the two engines disagree');
  return fast;
};

test("a reused frame does not leak the previous call's locals", () => {
  // Restoring a frame put back the declaration's short names array while the
  // slots array still had room from a previous call, so a local was written at
  // one index and named at another, and the function returned the previous
  // call's answer. The standard library's own tests caught it.
  assert.deepEqual(bothEngines([
    'fn zip(xs, ys) {',
    '  var out = []',
    '  var i = 0',
    '  let limit = min(xs.len(), ys.len())',
    '  while i < limit { out.push([xs[i], ys[i]])',
    '    i = i + 1 }',
    '  return out',
    '}',
    'print(zip([1, 2, 3], ["a", "b"]))',
    'print(zip([], [1, 2]))',
    'print(zip([1, 2, 3], ["a", "b"]))',
  ]), ['[[1, "a"], [2, "b"]]', '[]', '[[1, "a"], [2, "b"]]']);
});

test('closures made in a loop each keep their own iteration', () => {
  // A reused frame can be given a different parent, and compiled code caches
  // the slot a name resolved to keyed on the scope it looked through. Same
  // scope object, different parent, and every closure reported the first
  // iteration's value. Declarations whose function values close over different
  // scopes are no longer pooled.
  assert.deepEqual(bothEngines([
    'var fs = []',
    'for i in range(4) { fs.push(fn() { return i }) }',
    'print(fs[0]())',
    'print(fs[2]())',
    'print(fs[3]())',
  ]), ['0', '2', '3']);
});

test('a closure factory gives each closure its own captured value', () => {
  assert.deepEqual(bothEngines([
    'fn make(n) { return fn() { return n * 10 } }',
    'let a = make(1)',
    'let b = make(7)',
    'print(a())',
    'print(b())',
    'print(a())',
  ]), ['10', '70', '10']);
});

test("recursion sees its own arguments, not an outer frame's", () => {
  assert.deepEqual(bothEngines([
    'fn count(n, acc) {',
    '  if n == 0 { return acc }',
    '  let step = 1',
    '  return count(n - step, acc + n)',
    '}',
    'print(count(50, 0))',
    'print(count(3, 0))',
    'print(count(50, 0))',
  ]), ['1275', '6', '1275']);
});

test('mutual recursion keeps its frames apart', () => {
  assert.deepEqual(bothEngines([
    'fn even(n) { if n == 0 { return true }',
    '  let m = n - 1',
    '  return odd(m) }',
    'fn odd(n) { if n == 0 { return false }',
    '  let m = n - 1',
    '  return even(m) }',
    'print(even(20))',
    'print(odd(20))',
    'print(even(21))',
  ]), ['true', 'false', 'false']);
});

test('a loop scope does not leak between passes', () => {
  // Clearing a scope sets its live count to zero and leaves the storage in
  // place. Nothing past the count may be visible.
  assert.deepEqual(bothEngines([
    'var seen = []',
    'for i in range(3) {',
    '  let a = i * 2',
    '  seen.push(a)',
    '}',
    'print(seen)',
  ]), ['[0, 2, 4]']);
});

test('an outer binding stays visible when a pass declares another', () => {
  assert.deepEqual(bothEngines([
    'let g = 100',
    'var t = 0',
    'for i in range(3) { let d = g + i',
    '  t = t + d }',
    'print(t)',
  ]), ['303']);
});

test('shadowing inside a loop does not outlive the pass', () => {
  assert.deepEqual(bothEngines([
    'let g = 5',
    'var seen = []',
    'for i in range(3) { let g = i',
    '  seen.push(g) }',
    'seen.push(g)',
    'print(seen)',
  ]), ['[0, 1, 2, 5]']);
});

test('a frame that grows past the small-scope limit still works', () => {
  // Beyond eight bindings a scope converts to a Map. A frame that converted
  // must not then be reused as if it had not.
  const decls = Array.from({ length: 12 }, (_, i) => `  let v${i} = ${i} + n`);
  const sum = Array.from({ length: 12 }, (_, i) => `v${i}`).join(' + ');
  assert.deepEqual(bothEngines([
    'fn wide(n) {', ...decls, `  return ${sum}`, '}',
    'print(wide(0))',
    'print(wide(10))',
    'print(wide(0))',
  ]), ['66', '186', '66']);
});

test('a frame is not reused while a call is standing in it', () => {
  // The pool is indexed by depth, so a recursive call must never take the
  // frame its own caller is using.
  assert.deepEqual(bothEngines([
    'fn depth(n) {',
    '  if n == 0 { return 0 }',
    '  let here = n',
    '  let deeper = depth(n - 1)',
    '  return here + deeper',
    '}',
    'print(depth(30))',
  ]), ['465']);
});

test('a contracted function is correct across repeated calls', () => {
  assert.deepEqual(bothEngines([
    'fn step(x) requires x >= 0 ensures result > x { let one = 1',
    '  return x + one }',
    'print(step(0))',
    'print(step(41))',
    'print(step(0))',
  ]), ['1', '42', '1']);
});

// ---------------------------------------------------------------------------
// bound methods, remembered
//
// `xs.push(1)` built a fresh function and a closure over `xs` on every call.
// They are kept against the object now, which is only sound if a remembered
// method still sees the object as it is at the moment it is called.
// ---------------------------------------------------------------------------

test('a remembered method sees the object as it is now', () => {
  assert.deepEqual(bothEngines([
    'var xs = [1]',
    'xs.push(2)',
    'xs.push(3)',
    'print(xs)',
    'print(xs.len())',
    'var m = { }',
    'm.set("a", 1)',
    'm.set("b", 2)',
    'print(m.len())',
    'print(m.get("b"))',
  ]), ['[1, 2, 3]', '3', '2', '2']);
});

test('each object gets its own bound method', () => {
  assert.deepEqual(bothEngines([
    'var a = []',
    'var b = []',
    'for i in range(3) { a.push(i)',
    '  b.push(i * 10) }',
    'print(a)',
    'print(b)',
  ]), ['[0, 1, 2]', '[0, 10, 20]']);
});

test('a remembered method still refuses a value bound with let', () => {
  // The freeze is checked when the method runs, not when it was built, so a
  // method remembered while the value was mutable must still refuse later.
  const out = [];
  const interp = new Interpreter({ out: (s) => out.push(s), seed: 1 });
  try {
    assert.throws(
      () => interp.run([
        'var xs = []',
        'xs.push(1)',
        'let frozen = xs',
        'xs.push(2)',
      ].join('\n'), 't.smarsh'),
      (e) => e.kind === 'ImmutableError',
    );
  } finally {
    interp.devices.shutdown();
  }
});

test('a member that is a value is not remembered as if it were a method', () => {
  // `.tokens` changes as the context fills; caching it would freeze the answer.
  assert.deepEqual(bothEngines([
    'let c = context(500)',
    'print(c.tokens)',
    'c.push("some text here")',
    'print(c.tokens > 0)',
    'let t = tensor [[1, 2], [3, 4]]',
    'print(t.shape)',
  ]), ['0', 'true', '[2, 2]']);
});

test('record fields are read fresh, never remembered', () => {
  assert.deepEqual(bothEngines([
    'record P(x, y)',
    'let a = P(1, 2)',
    'let b = P(9, 8)',
    'print(a.x)',
    'print(b.x)',
    'print(a.x)',
    'print(a.with("x", 5).x)',
    'print(a.x)',
  ]), ['1', '9', '1', '5', '1']);
});

test('a tainted value still taints what its methods return', () => {
  // Method access through a tainted value wraps the result, and that wrapping
  // happens outside the cache -- so it must not be lost.
  assert.deepEqual(bothEngines([
    'let u = untrusted("abc")',
    'print(labels(u.upper()))',
    'print(labels(u.upper()))',
  ]), ['["untrusted"]', '["untrusted"]']);
});

// ---------------------------------------------------------------------------
// contracts, over a reused frame
//
// A contracted function reuses its frame like any other now, and the scope
// carrying `result` into the postcondition is reused with it. Both are only
// sound if each call sees its own values.
// ---------------------------------------------------------------------------

test("a postcondition sees this call's result, not the last one's", () => {
  assert.deepEqual(bothEngines([
    'fn bump(x) requires x >= 0 ensures result == x + 1 { return x + 1 }',
    'print(bump(0))',
    'print(bump(41))',
    'print(bump(0))',
  ]), ['1', '42', '1']);
});

test("old() captures this call's entry state", () => {
  assert.deepEqual(bothEngines([
    'record Acct(balance)',
    'fn charge(a, fee) requires fee >= 0 ensures result.balance == old(a.balance) - fee {',
    '  return a.with("balance", a.balance - fee)',
    '}',
    'print(charge(Acct(100), 10).balance)',
    'print(charge(Acct(50), 5).balance)',
    'print(charge(Acct(100), 10).balance)',
  ]), ['90', '45', '90']);
});

test('a broken postcondition still fails, after the same call has succeeded', () => {
  const interp = new Interpreter({ out: () => {}, seed: 1 });
  try {
    assert.throws(() => interp.run([
      'fn f(x) ensures result > x { if x == 3 { return x }',
      '  return x + 1 }',
      'print(f(1))',
      'print(f(2))',
      'print(f(3))',
    ].join('\n'), 't.smarsh'), (e) => e.kind === 'ContractError' && /promised/.test(e.message));
  } finally {
    interp.devices.shutdown();
  }
});

test('a broken precondition still fails on a later call', () => {
  const interp = new Interpreter({ out: () => {}, seed: 1 });
  try {
    assert.throws(() => interp.run([
      'fn f(x) requires x >= 0 { return x }',
      'print(f(1))',
      'print(f(2))',
      'print(f(0 - 1))',
    ].join('\n'), 't.smarsh'), (e) => e.kind === 'ContractError' && /requires/.test(e.message));
  } finally {
    interp.devices.shutdown();
  }
});

test('a record invariant holds across repeated construction', () => {
  assert.deepEqual(bothEngines([
    'record Pos(v) invariant v > 0',
    'var t = 0',
    'for i in range(5) { let p = Pos(i + 1)',
    '  t = t + p.v }',
    'print(t)',
  ]), ['15']);
});

test('a recursive contracted function keeps each depth separate', () => {
  assert.deepEqual(bothEngines([
    'fn down(n) requires n >= 0 ensures result >= 0 {',
    '  if n == 0 { return 0 }',
    '  let here = n',
    '  return here + down(n - 1)',
    '}',
    'print(down(10))',
    'print(down(3))',
    'print(down(10))',
  ]), ['55', '6', '55']);
});

// ---------------------------------------------------------------------------
// labels, on the paths that now skip the label machinery
//
// Member access, indexing and unary operators return early when nothing is
// tainted, which is almost always. The early return is only correct if every
// case that *is* tainted still goes the long way.
// ---------------------------------------------------------------------------

test('a label survives member access', () => {
  assert.deepEqual(bothEngines([
    'let u = untrusted("abc")',
    'print(labels(u.upper()))',
    'print(labels(u.len()))',
    'let clean = "abc"',
    'print(labels(clean.upper()))',
  ]), ['["untrusted"]', '["untrusted"]', '[]']);
});

test('a label survives indexing, from either side', () => {
  assert.deepEqual(bothEngines([
    'let xs = [untrusted("a"), "b"]',
    'print(labels(xs[0]))',
    'print(labels(xs[1]))',
    'var clean = ["a", "b"]',
    'let i = untrusted(1)',
    'print(labels(clean[i]))',
  ]), ['["untrusted"]', '[]', '["untrusted"]']);
});

test('a label survives a unary operator', () => {
  assert.deepEqual(bothEngines([
    'let n = untrusted(5)',
    'print(labels(0 - n))',
    'print(labels(not n))',
    'print(labels(0 - 5))',
  ]), ['["untrusted"]', '["untrusted"]', '[]']);
});

test('a grounded block still refuses a value that came through a method', () => {
  const interp = new Interpreter({ out: () => {}, seed: 1 });
  try {
    assert.throws(
      () => interp.run('let u = untrusted("abc")\ngrounded { print(u.upper()) }', 't.smarsh'),
      (e) => e.kind === 'TaintError',
    );
  } finally {
    interp.devices.shutdown();
  }
});

test('two labels from different sources are both carried', () => {
  assert.deepEqual(bothEngines([
    'let a = untrusted("x")',
    'let b = ungrounded("y")',
    'print(labels(a + b))',
  ]), ["[\"untrusted\", \"ungrounded\"]"]);
});
