import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Interpreter } from '../src/interpreter.js';
import { parse } from '../src/parser.js';
import { analyze } from '../src/analysis.js';

// Capabilities, checked before the program runs.
//
// They were enforced only at the moment of the call, so a branch that reached
// the filesystem said nothing until something executed it. That is the wrong
// time to find out, and it is decidable in advance: a builtin knows what it
// needs, a function declares what it holds, and the requirement travels to the
// caller.
//
// The checker is built to stay quiet wherever it cannot be certain, and half of
// these tests are about the silence rather than the finding.

function builtinNeeds() {
  const interp = new Interpreter({ out: () => {} });
  const needs = new Map();
  for (const [name, slot] of interp.prelude.vars) {
    const v = slot.value;
    if (v && Array.isArray(v.needs) && v.needs.length > 0) needs.set(name, v.needs);
  }
  interp.devices.shutdown();
  return needs;
}

const NEEDS = builtinNeeds();
const findings = (source) => analyze(parse(source, 't.pedag'), { builtinNeeds: NEEDS })
  .filter((f) => f.kind === 'undeclared capability');

test('a function that reaches the filesystem without saying so is reported', () => {
  const f = findings('fn save(t) { write("out.txt", t) }');
  assert.equal(f.length, 1);
  assert.match(f[0].message, /`save` uses `fs` through `write`/);
  assert.match(f[0].hint, /needs fs/);
});

test('a function that declares what it uses is silent', () => {
  assert.equal(findings('fn save(t) needs fs { write("out.txt", t) }').length, 0);
});

test('the requirement travels to the caller', () => {
  // To call something that declares `needs fs`, the calling frame must hold
  // `fs` itself -- which is what the runtime enforces, so the checker has to
  // agree.
  const f = findings([
    'fn inner(t) needs fs { write("out.txt", t) }',
    'fn outer(t) { return inner(t) }',
  ].join('\n'));
  assert.equal(f.length, 1);
  assert.match(f[0].message, /`outer` uses `fs` through `inner`/);
});

test('a caller that declares the capability its callee needs is silent', () => {
  assert.equal(findings([
    'fn inner(t) needs fs { write("out.txt", t) }',
    'fn outer(t) needs fs { return inner(t) }',
  ].join('\n')).length, 0);
});

test('every missing capability is reported, not just the first', () => {
  const f = findings('fn both(t) { write("a.txt", t)\n  print(now()) }');
  assert.equal(f.length, 2);
  const caps = f.map((x) => x.message.match(/uses `([a-z_]+)`/)[1]).sort();
  assert.deepEqual(caps, ['clock', 'fs']);
});

test('the same capability twice is reported once', () => {
  const f = findings('fn twice(t) { write("a.txt", t)\n  write("b.txt", t) }');
  assert.equal(f.length, 1);
});

// ---------------------------------------------------------------------------
// where it must stay quiet
// ---------------------------------------------------------------------------

test('a capability held through `using` is not a missing declaration', () => {
  // `using` is exactly where authority is held that the signature does not
  // mention -- that is what it is for.
  assert.equal(findings('fn lent(t) {\n  using grant("fs") { write("b.txt", t) }\n}').length, 0);
});

test('a name rebound locally is not the builtin', () => {
  assert.equal(findings('fn shadowed(write) { return write("c.txt") }').length, 0);
  assert.equal(findings('fn local(t) { let write = t\n  return write }').length, 0);
});

test('a call through a value cannot be resolved, so nothing is claimed', () => {
  assert.equal(findings('fn indirect(f) { return f("d.txt") }').length, 0);
});

test('the top level is exempt, because --grant is not in the source', () => {
  assert.equal(findings('write("e.txt", "top level")').length, 0);
});

test('a nested function is judged on its own declaration', () => {
  // The inner function declares `fs`, so the outer one is not using it -- it is
  // only building a value.
  assert.equal(findings('fn outer() { return fn(t) needs fs { write("x", t) } }').length, 0);
});

test('a function calling something harmless is silent', () => {
  assert.equal(findings('fn pure(a, b) { return a + b }\nfn uses(a) { return pure(a, 1) }').length, 0);
});

// ---------------------------------------------------------------------------
// it agrees with what actually happens
// ---------------------------------------------------------------------------

test('what the checker reports is what the runtime refuses', () => {
  const source = 'fn save(t) { write("out.txt", t) }\nsave("x")';
  assert.equal(findings(source).length, 1, 'the checker did not report it');

  const interp = new Interpreter({ out: () => {}, caps: ['fs'] });
  try {
    assert.throws(
      () => interp.run(source, 't.pedag'),
      (e) => e.kind === 'CapabilityError',
      'the runtime did not refuse what the checker reported',
    );
  } finally {
    interp.devices.shutdown();
  }
});

test('what the checker passes, the runtime allows', () => {
  const source = 'fn save(t) needs fs { return t }\nprint(save("x"))';
  assert.equal(findings(source).length, 0);
  const out = [];
  const interp = new Interpreter({ out: (s) => out.push(s), caps: ['fs'] });
  try {
    interp.run(source, 't.pedag');
    assert.deepEqual(out, ['x']);
  } finally {
    interp.devices.shutdown();
  }
});
