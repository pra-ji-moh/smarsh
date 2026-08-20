import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Interpreter } from '../src/interpreter.js';
import { PedagError } from '../src/errors.js';
import { toJs, toPēdāg } from '../src/ffi.js';
import { unwrap } from '../src/values.js';
import { Tensor } from '../src/tensor.js';

// `ffi` says a program may cross the boundary at all; `--foreign` says
// where to. These tests exercise the crossing itself rather than the
// allowlist, so they open it wide -- tests/foreign.test.mjs is where the
// allowlist is checked.
const FFI = { caps: ['ffi'], foreign: ['*'] };

function run(src, opts = {}) {
  const out = [];
  const interp = new Interpreter({ ...opts, out: (s) => out.push(s) });
  try {
    return { value: interp.run(src, '<t>'), out, interp };
  } finally {
    interp.devices.shutdown();
  }
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

// ---------------------------------------------------------------------------
// the capability boundary
// ---------------------------------------------------------------------------

test('foreign code needs the ffi capability', () => {
  const e = fails('foreign("node:os")');
  assert.equal(e.kind, 'CapabilityError');
  assert.match(e.message, /needs the 'ffi' capability/);
});

test('a function that did not declare ffi cannot open the boundary', () => {
  // Even though the top level holds it: capabilities attenuate, and the
  // foreign boundary is the one where that matters most.
  const e = fails('fn sneaky() { return foreign("node:os") }\nsneaky()', FFI);
  assert.equal(e.kind, 'CapabilityError');
});

test('a function that declares ffi may open it', () => {
  const { value } = run('fn load() needs ffi { return foreign("node:os") }\ntype(load())', FFI);
  assert.equal(value, 'foreign');
});

test('a module that does not exist says so usefully', () => {
  const e = fails('foreign("node:definitely-not-a-module")', FFI);
  assert.equal(e.kind, 'ForeignError');
  assert.match(e.helps.join(' '), /CommonJS/);
});

// ---------------------------------------------------------------------------
// calling across
// ---------------------------------------------------------------------------

test('host functions are callable and return converted values', () => {
  const { value } = run(`
    let p = foreign("node:path")
    [p.join("a", "b"), p.extname("x.txt")]
  `, FFI);
  // Results arrive wrapped in their `untrusted` label; the value underneath is
  // what the host returned.
  assert.deepEqual(value.map(unwrap), [path.join('a', 'b'), '.txt']);
});

test('a module with self-referencing exports still loads', () => {
  // node:path refers to itself through path.posix.posix; eager conversion used
  // to blow up on it.
  const { value } = run('let p = foreign("node:path")\np.sep', FFI);
  assert.equal(String(value), path.sep);
});

test('a throwing host function becomes a Pēdāg failure, not a crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Pēdāg-ffi-'));
  fs.writeFileSync(path.join(dir, 'boom.cjs'), 'module.exports = { boom() { throw new Error("kaboom") } }');
  const e = fails('let m = foreign("./boom.cjs")\nm.boom()', { ...FFI, cwd: dir });
  assert.equal(e.kind, 'ForeignError');
  assert.match(e.message, /kaboom/);
});

test('a promise is refused rather than silently mishandled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Pēdāg-ffi-'));
  fs.writeFileSync(path.join(dir, 'async.cjs'), 'module.exports = { later: () => Promise.resolve(1) }');
  const e = fails('let m = foreign("./async.cjs")\nm.later()', { ...FFI, cwd: dir });
  assert.equal(e.kind, 'ForeignError');
  assert.match(e.message, /promise/);
});

test('a local CommonJS module loads by relative path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Pēdāg-ffi-'));
  fs.writeFileSync(path.join(dir, 'lib.cjs'),
    'module.exports = { double: (n) => n * 2, name: "lib", nested: { deep: [1, 2] } }');
  const { value } = run(`
    let lib = foreign("./lib.cjs")
    [lib.double(21), lib.name, lib.nested["deep"]]
  `, { ...FFI, cwd: dir });
  assert.equal(unwrap(value[0]), 42);
  assert.equal(unwrap(value[1]), 'lib');
  assert.deepEqual(unwrap(value[2]).map(unwrap), [1, 2]);
});

// ---------------------------------------------------------------------------
// values are converted, not shared
// ---------------------------------------------------------------------------

test('a list crosses as a copy, so the host cannot reach back in', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Pēdāg-ffi-'));
  fs.writeFileSync(path.join(dir, 'm.cjs'), 'module.exports = { wreck: (xs) => { xs.push(999); return xs.length } }');
  const { value } = run(`
    let m = foreign("./m.cjs")
    var xs = [1, 2]
    let n = m.wreck(xs)
    [xs.len(), n]
  `, { ...FFI, cwd: dir });
  assert.equal(value[0], 2, 'the original list must be untouched');
});

test('conversion handles every shape a program can hold', () => {
  assert.equal(toJs(5), 5);
  assert.equal(toJs('x'), 'x');
  assert.equal(toJs(null), null);
  assert.deepEqual(toJs([1, [2, 3]]), [1, [2, 3]]);
  assert.deepEqual(toJs(new Map([['a', 1]])), { a: 1 });
  assert.deepEqual(toJs(Tensor.fromNested([[1, 2], [3, 4]])), [[1, 2], [3, 4]]);
});

test('a self-containing value is refused rather than looping forever', () => {
  const xs = [1];
  xs.push(xs);
  assert.throws(() => toJs(xs), /contains itself/);
});

test('a value with no meaning in JavaScript is refused clearly', () => {
  const interp = new Interpreter({ out: () => {} });
  try {
    const secret = interp.prelude.get('secret_of').fn([{ }], 1, interp);
    assert.throws(() => toJs(secret), /cannot cross into JavaScript/);
  } finally {
    interp.devices.shutdown();
  }
});

test('host values convert back, including cycles and dates', () => {
  const interp = new Interpreter({ out: () => {} });
  try {
    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    const converted = toPēdāg(cyclic, interp, 1);
    assert.equal(converted.get('a'), 1);
    assert.equal(converted.get('self'), '<circular>');
    assert.match(toPēdāg(new Date(0), interp, 1), /^1970-01-01/);
    assert.equal(toPēdāg(10n, interp, 1), 10);
  } finally {
    interp.devices.shutdown();
  }
});

// ---------------------------------------------------------------------------
// what comes back is untrusted
// ---------------------------------------------------------------------------

test('a foreign result is labelled untrusted', () => {
  const { value } = run('let o = foreign("node:os")\nlabels(o.platform())', FFI);
  assert.deepEqual(value, ['untrusted']);
});

test('a foreign result cannot enter a grounded block unlaundered', () => {
  const e = fails(`
    let o = foreign("node:os")
    let p = o.platform()
    grounded { print(p) }
  `, FFI);
  assert.equal(e.kind, 'TaintError');
});

test('laundering a foreign result is explicit and recorded', () => {
  const { interp } = run(`
    let o = foreign("node:os")
    let p = trust(o.platform(), "a fixed enum from the host")
    grounded { print(p) }
  `, FFI);
  assert.equal(interp.trace.laundered.length, 1);
  assert.match(interp.trace.laundered[0].reason, /fixed enum/);
});

test('the run trace records that the boundary was crossed', () => {
  const { interp } = run(`
    let o = foreign("node:os")
    o.platform()
    o.arch()
  `, FFI);
  assert.deepEqual(interp.trace.foreignModules, ['node:os']);
  assert.equal(interp.trace.foreignCalls, 2);
});
