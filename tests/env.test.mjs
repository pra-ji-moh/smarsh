import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Env, versionOf } from '../src/env.js';
import { Interpreter } from '../src/interpreter.js';
import { SmarshError } from '../src/errors.js';

// `Env` carries six interacting fields and two representations, and the rules
// between them are not obvious. One of them has already been broken in a way
// that produced a wrong answer rather than a crash: a slot written at index 5
// while its name went to index 2, which made a function return the previous
// call's result.
//
// `assertInvariants` states those rules as code. These tests run it after every
// operation that could break one, so a violation is caught where it happens
// rather than three layers away when something reads the wrong slot.

const check = (env, where) => { env.assertInvariants(where); return env; };

test('a fresh scope is consistent, and holds nothing', () => {
  const env = check(new Env(), 'fresh');
  assert.equal(env.slot('x'), null);
  assert.equal(env.has('x'), false);
  assert.equal(env.own('x'), undefined);
});

test('declaring, reading and assigning keep it consistent', () => {
  const env = new Env();
  env.declare('a', 1, false, 1);
  check(env, 'after one declare');
  env.declare('b', 2, true, 1);
  check(env, 'after two');

  assert.equal(env.slot('a').value, 1);
  assert.equal(env.get('b', 1), 2);
  env.assign('b', 9, 1);
  assert.equal(env.get('b', 1), 9);
  check(env, 'after assign');

  assert.throws(() => env.assign('a', 5, 1), (e) => e.kind === 'ImmutableError');
  assert.throws(() => env.declare('a', 3, false, 1), (e) => e.kind === 'NameError');
  check(env, 'after refusals');
});

test('clearing leaves the storage but hides everything', () => {
  // The rule that makes a loop cheap: the count goes to zero, the arrays stay.
  const env = new Env();
  env.declare('a', 1, false, 1);
  env.declare('b', 2, false, 1);
  env.clearVars();
  check(env, 'after clear');
  assert.equal(env.slot('a'), null, 'a cleared binding is still visible');
  assert.equal(env.has('b'), false);

  // And refilling reuses that storage without confusing the three arrays.
  env.declare('a', 10, false, 1);
  check(env, 'after refill');
  assert.equal(env.get('a', 1), 10);
  assert.equal(env.slot('b'), null);
});

test('many clear/refill passes stay consistent', () => {
  // A loop body doing this ten thousand times is the actual workload.
  const env = new Env();
  for (let i = 0; i < 200; i++) {
    env.clearVars();
    env.declare('i', i, false, 1);
    env.declare('d', i * 2, false, 1);
    assert.equal(env.get('d', 1), i * 2);
  }
  check(env, 'after 200 passes');
  assert.equal(env._count, 2, 'the scope grew across passes');
});

test('a borrowed names array is copied before it is written', () => {
  // `adoptFrame` shares the declaration's params array across every call. A
  // frame that then declares a local must not write into it.
  const params = ['x', 'y'];
  const env = new Env();
  env.adoptFrame(params, [{ value: 1, mutable: false }, { value: 2, mutable: false }]);
  check(env, 'after adoptFrame');
  assert.equal(env.get('x', 1), 1);

  env.declare('local', 3, false, 1);
  check(env, 'after declaring into a borrowed frame');
  assert.deepEqual(params, ['x', 'y'], 'the shared params array was written to');
  assert.equal(env.get('local', 1), 3);
});

test('reusing a frame drops the last call locals and keeps the parameters', () => {
  const params = ['x'];
  const env = new Env();
  env.adoptFrame(params, [{ value: 1, mutable: false }]);
  env.declare('local', 99, false, 1);
  check(env, 'before reuse');

  env.reuseFrame(params, [7]);
  check(env, 'after reuse');
  assert.equal(env.get('x', 1), 7);
  assert.equal(env.slot('local'), null, "the previous call's local survived");
  assert.deepEqual(params, ['x'], 'the shared params array was written to');
});

test('positional reuse behaves the same as the array form', () => {
  const params = ['a', 'b'];
  const env = new Env();
  env.adoptFrame(params, [{ value: 0, mutable: false }, { value: 0, mutable: false }]);
  env.reuseFrameArgs(params, 2, 5, 6);
  check(env, 'after positional reuse');
  assert.equal(env.get('a', 1), 5);
  assert.equal(env.get('b', 1), 6);
});

test('growing past the small limit converts, and stays consistent', () => {
  const env = new Env();
  for (let i = 0; i < 12; i++) env.declare(`n${i}`, i, false, 1);
  check(env, 'after growing past SMALL');
  assert.notEqual(env._map, null, 'it should have converted to a map');
  for (let i = 0; i < 12; i++) assert.equal(env.get(`n${i}`, 1), i);
});

test('asking for the map view converts, and the arrays go', () => {
  const env = new Env();
  env.declare('a', 1, false, 1);
  assert.equal(env.vars.get('a').value, 1);
  check(env, 'after the map view');
  assert.equal(env._names, null);
  assert.equal(env._count, 0);
  // And it still works as a scope afterwards.
  env.declare('b', 2, false, 1);
  check(env, 'after declaring in map mode');
  assert.equal(env.get('b', 1), 2);
});

test('deleting a binding keeps the three arrays in step', () => {
  const env = new Env();
  for (const n of ['a', 'b', 'c']) env.declare(n, n, false, 1);
  env.deleteVar('b');
  check(env, 'after delete');
  assert.equal(env.slot('b'), null);
  assert.equal(env.get('a', 1), 'a');
  assert.equal(env.get('c', 1), 'c');
  assert.equal(env._count, 2);
});

test('lookup walks to the parent, and the nearest binding wins', () => {
  const outer = new Env();
  outer.declare('x', 'outer', false, 1);
  outer.declare('only', 'outer', false, 1);
  const inner = new Env(outer);
  inner.declare('x', 'inner', false, 1);
  check(outer, 'outer');
  check(inner, 'inner');

  assert.equal(inner.get('x', 1), 'inner');
  assert.equal(inner.get('only', 1), 'outer');
  assert.equal(inner.ownerOf('only'), outer);
  assert.equal(inner.ownerOf('x'), inner);
});

// ---------------------------------------------------------------------------
// the rule that is not about representation
// ---------------------------------------------------------------------------

test('a structural change bumps the version for the name it affects', () => {
  const env = new Env();
  const before = versionOf('a').v;
  env.declare('a', 1, false, 1);
  assert.ok(versionOf('a').v > before, 'declaring did not invalidate caches for that name');

  const other = versionOf('unrelated').v;
  env.declare('b', 2, false, 1);
  assert.equal(versionOf('unrelated').v, other, 'an unrelated name was invalidated');

  const beforeClear = versionOf('a').v;
  env.clearVars();
  assert.ok(versionOf('a').v > beforeClear, 'clearing did not invalidate the names it removed');
});

test('building a frame does not invalidate anything', () => {
  // The deliberate exception: nothing can have looked through a frame that did
  // not exist a moment ago, so populating it cannot make a cache stale.
  const before = versionOf('p').v;
  const env = new Env();
  env.adoptFrame(['p'], [{ value: 1, mutable: false }]);
  assert.equal(versionOf('p').v, before, 'building a frame invalidated every cache for `p`');
  check(env, 'adoptFrame');
});

// ---------------------------------------------------------------------------
// and the whole thing, driven by real programs
// ---------------------------------------------------------------------------

test('scopes stay consistent across a program that exercises all of it', () => {
  const source = [
    'fn outer(a, b) {',
    '  let local = a + b',
    '  var acc = 0',
    '  for i in range(5) { let step = i * 2',
    '    acc = acc + step }',
    '  return acc + local',
    '}',
    'fn wide(n) {',
    Array.from({ length: 12 }, (_, i) => `  let v${i} = ${i} + n`).join('\n'),
    `  return ${Array.from({ length: 12 }, (_, i) => `v${i}`).join(' + ')}`,
    '}',
    'var fs = []',
    'for i in range(3) { fs.push(fn() { return i }) }',
    'print(outer(1, 2))',
    'print(wide(0))',
    'print(fs[2]())',
  ].join('\n');

  const out = [];
  const interp = new Interpreter({ out: (s) => out.push(s), seed: 1 });
  try {
    interp.run(source, 't.smarsh');
    assert.deepEqual(out, ['23', '66', '2']);
    // Every scope the run left behind, checked.
    interp.globals.assertInvariants('globals');
    interp.prelude.assertInvariants('prelude');
  } finally {
    interp.devices.shutdown();
  }
});

test('a scope survives being used after a failure inside it', () => {
  const interp = new Interpreter({ out: () => {}, seed: 1 });
  try {
    assert.throws(
      () => interp.run('fn f() { let a = 1\n  return nope }\nf()', 't.smarsh'),
      (e) => e instanceof SmarshError,
    );
    interp.globals.assertInvariants('globals after a failure');
  } finally {
    interp.devices.shutdown();
  }
});
