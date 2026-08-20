import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Interpreter } from '../src/interpreter.js';
import { parse } from '../src/parser.js';
import { analyze } from '../src/analysis.js';

// docs/for-llms.md is the whole language on one page, written to be handed to a
// program that has to emit correct Pēdāg. A reference that has drifted from the
// language is worse than none: the reader cannot tell, and every mistake it
// teaches is one the model will make confidently.
//
// So it is tested rather than proofread. Every builtin and method it names must
// exist, every example marked correct must run, and every example marked as an
// error must actually be refused -- for the reason claimed.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'for-llms.md'), 'utf8');

const surface = () => {
  const interp = new Interpreter({ out: () => {} });
  const names = new Set(interp.prelude.vars.keys());
  const needs = new Map();
  for (const [name, slot] of interp.prelude.vars) {
    const v = slot.value;
    if (v && Array.isArray(v.needs) && v.needs.length > 0) needs.set(name, v.needs.join(','));
  }
  interp.devices.shutdown();
  return { names, needs };
};

const { names: BUILTINS, needs: NEEDS } = surface();

function run(source, caps = []) {
  const out = [];
  const interp = new Interpreter({ out: (s) => out.push(s), caps, seed: 1 });
  try {
    interp.run(source, 'doc.pedag');
    return { out, error: null };
  } catch (e) {
    return { out, error: e.kind ?? 'error' };
  } finally {
    interp.devices.shutdown();
  }
}

// ---------------------------------------------------------------------------
// what it names must exist
// ---------------------------------------------------------------------------

test('every builtin the page names exists', () => {
  // Taken from the backticked runs of names in the Builtins section, which is
  // where a model will look for what it may call.
  const section = DOC.slice(DOC.indexOf('## Builtins'), DOC.indexOf('## A whole program'));
  const claimed = new Set();
  for (const m of section.matchAll(/`([^`]+)`/g)) {
    for (const word of m[1].split(/[\s,]+/)) {
      // Methods are written `.name`; builtins are bare.
      if (/^[a-z_][a-z0-9_]*$/.test(word)) claimed.add(word);
    }
  }
  // Not builtins: the `tensor` keyword, parameter names in the signatures the
  // page shows, capability names, and the name of the command itself.
  const notBuiltins = [
    'tensor', 'f', 'init', 'd', 'scale', 'a', 'b',
    'fs', 'clock', 'crypto', 'unaudited_crypto', 'ffi', 'net',
    'pedag', 'explain',
  ];
  for (const w of notBuiltins) claimed.delete(w);

  const missing = [...claimed].filter((n) => !BUILTINS.has(n));
  assert.deepEqual(missing, [], `the page names builtins that do not exist: ${missing.join(', ')}`);
});

test('every method the page names resolves on the type it is listed under', () => {
  const cases = [
    ['[1, 2, 3]', ['len', 'push', 'pop', 'slice', 'contains', 'join', 'map',
      'filter', 'reduce', 'sort', 'reverse', 'sum']],
    ['"abc"', ['len', 'upper', 'lower', 'trim', 'split', 'replace', 'slice',
      'contains', 'starts', 'ends', 'tokens']],
    ['{ "k": 1 }', ['len', 'get', 'set', 'has', 'remove', 'keys', 'values']],
    ['tensor [[1, 2], [3, 4]]', ['T', 'shape', 'rank', 'size', 'sum', 'mean',
      'max', 'min', 'norm', 'reshape', 'map', 'tolist']],
  ];
  for (const [literal, methods] of cases) {
    // A fresh interpreter per case: one shared across them redeclares the name.
    const interp = new Interpreter({ out: () => {} });
    try {
      const value = interp.run(`var v = ${literal}\nv`, 'doc.pedag');
      for (const m of methods) {
        assert.doesNotThrow(
          () => interp.member(value, m, 1),
          `${literal} has no \`.${m}\`, but the page says it does`,
        );
      }
    } finally {
      interp.devices.shutdown();
    }
  }
});

test('the capability table on the page is the one the runtime enforces', () => {
  // The page tells a model which builtins cost authority. If that list drifts,
  // generated code declares the wrong thing.
  const claimed = {
    read: 'fs', write: 'fs', weights: 'fs', now: 'clock', foreign: 'ffi',
    keypair: 'crypto', random_secret: 'crypto',
  };
  for (const [name, cap] of Object.entries(claimed)) {
    assert.equal(NEEDS.get(name), cap, `\`${name}\` needs ${NEEDS.get(name)}, not ${cap}`);
  }
  // And nothing else quietly acquired a requirement the page does not mention.
  const unmentioned = [...NEEDS.keys()].filter((n) => !(n in claimed) && !DOC.includes(n));
  assert.deepEqual(unmentioned, [],
    `these need a capability and the page never mentions them: ${unmentioned.join(', ')}`);
});

// ---------------------------------------------------------------------------
// what it shows must behave as shown
// ---------------------------------------------------------------------------

test('the complete program at the end runs and prints what it should', () => {
  const blocks = [...DOC.matchAll(/```pedag\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 8, 'the page lost its examples');
  const whole = blocks[blocks.length - 1];

  assert.deepEqual(analyze(parse(whole, 'doc.pedag')), [], 'the whole program does not check clean');
  const { out, error } = run(whole);
  assert.equal(error, null, `the whole program failed: ${error}`);
  assert.deepEqual(out, ['A: balanced  |  B: short by 1.50']);
});

test('trap 1 is real: let freezes, var does not', () => {
  assert.equal(run('let xs = []\nxs.push(1)').error, 'ImmutableError');
  assert.equal(run('var xs = []\nxs.push(1)').error, null);
  // And through an alias, which is the half people do not expect.
  assert.equal(run('var ys = [1]\nlet a = ys\nys.push(2)').error, 'ImmutableError');
  assert.equal(run('var ys = [1]\nlet a = ys.slice(0, ys.len())\nys.push(2)').error, null,
    'the copy the page recommends does not work');
});

test('trap 2 is real: authority must be declared', () => {
  assert.equal(run('fn save(t) { write("out.txt", t) }\nsave("x")', ['fs']).error, 'CapabilityError');
  // Declared, it gets as far as actually writing -- which needs a real path, so
  // the check here is only that authority is no longer the objection.
  const declared = run('fn save(t) needs fs { return t }\nprint(save("x"))', ['fs']);
  assert.equal(declared.error, null);
  assert.deepEqual(declared.out, ['x']);
});

test('trap 3 is real: dec is exact and refuses floats', () => {
  assert.deepEqual(run('print(0.1 + 0.2 == 0.3)').out, ['false']);
  assert.deepEqual(run('print(dec("0.1") + dec("0.2") == dec("0.3"))').out, ['true']);
  assert.deepEqual(run('print(dec("19.99") * 3)').out, ['59.97']);
  assert.equal(run('print(dec("19.99") + 0.1)').error, 'TypeError');
  assert.deepEqual(run('print(dec("10.00").div(dec("3"), 2))').out, ['3.33']);
});

test('trap 4 is real: a missing variant is caught before running', () => {
  const source = 'choice S { A  B }\nfn f(s) { return match s { A => 1 } }';
  const found = analyze(parse(source, 'doc.pedag')).filter((f) => f.kind === 'inexhaustive match');
  assert.equal(found.length, 1, 'the missing arm was not reported');
  // And `_` closes it, as the page says.
  assert.equal(
    analyze(parse('choice S { A  B }\nfn f(s) { return match s { A => 1, _ => 0 } }', 'doc.pedag'))
      .filter((f) => f.kind === 'inexhaustive match').length,
    0,
  );
});

test('the syntax the page shows parses', () => {
  // Every construct in the Syntax and Blocks sections, in one program, so a
  // shape that stops parsing cannot sit in the page unnoticed.
  const source = [
    'let x = 1',
    'var y = 2',
    'let n: num = 3',
    'fn add(a, b) { return a + b }',
    'fn area(w: num, h: num) -> num { return w * h }',
    'let double = fn(v) { return v * 2 }',
    'if x > 0 { print(1) } else if x == 0 { print(2) } else { print(3) }',
    'var i = 0',
    'while i < 2 { i = i + 1 }',
    'for item in [1, 2, 3] { print(item) }',
    'for k in range(2) { print(k) }',
    'attempt { print(1 / 0) } rescue e { print(e["kind"]) }',
    'print("text ${x} more")',
    'print([1, 2, 3])',
    'print({ "k": 1 })',
    'print(nil)',
    'print(true and not false or false)',
    'budget steps 5000 { print(1) }',
    'atomic { print(1) }',
    'secret { let s = 1 }',
    'fork 4 { _ }',
    'maybe 0.3 { print(1) } else { print(2) }',
    'region "eu" { print(1) }',
    'grounded { print(1) }',
    'using grant("fs") { print(1) }',
  ].join('\n');
  assert.doesNotThrow(() => parse(source, 'doc.pedag'), 'the page shows syntax that does not parse');
  assert.equal(run(source, ['fs']).error, null);
});

test('the page fits in a context window', () => {
  // The point of this file is that a model can hold the whole language at once.
  // Roughly 1.35 tokens per word is close enough to notice it doubling.
  const words = DOC.split(/\s+/).filter(Boolean).length;
  assert.ok(words < 2400, `the page has grown to ${words} words; it is meant to stay under ~2400`);
});
