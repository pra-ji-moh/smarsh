import { test } from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../src/index.js';
import { verifyManifest } from '../src/audit.js';
import { generateKeypair } from '../src/crypto.js';

// Attempts to make the runtime say something false.
//
// The rest of the suite asks whether things work. This asks whether they can be
// made to lie, which is the only failure mode that matters for a system whose
// product is evidence. Everything here was written by trying to break a claim
// the README makes, and one of them succeeded.
//
// The one that succeeded: a signed record could have `authority.granted` edited
// from ["fs","net"] to [] and still verify as intact, because the anchor covered
// five named header fields and the summary sections had been added underneath
// it later. `smarsh audit` would then print the false value to a reviewer. The
// summary could lie while the signature held.

const KEY = generateKeypair();

// ---------------------------------------------------------------------------
// the record
// ---------------------------------------------------------------------------

test('no field outside the chain can be edited without detection', () => {
  // The anchor names what it EXCLUDES rather than what it covers, so a section
  // added later is protected by default. This asserts that property directly:
  // every top-level key except the chain itself must be tamper-evident.
  const r = run([
    'let v = classify(1, "a", ["a"])',
    'attempt { release_to "b" { print(str(v)) } } rescue e {}',
    'attempt { read("x") } rescue e {}',
    'let boom = nope',
  ].join('\n'), { grant: ['fs', 'net'], sign: KEY });

  assert.equal(verifyManifest(r.manifest).ok, true, 'an honest record does not verify');

  const CHAIN = new Set(['genesis', 'events', 'head', 'signature']);
  const keys = Object.keys(r.manifest).filter((k) => !CHAIN.has(k));
  assert.ok(keys.length >= 8, `only ${keys.length} anchored sections found`);

  for (const key of keys) {
    const tampered = JSON.parse(JSON.stringify(r.manifest));
    // A change that is definitely a change, whatever the field holds.
    tampered[key] = Array.isArray(tampered[key]) ? ['tampered']
      : (tampered[key] !== null && typeof tampered[key] === 'object')
        ? { tampered: true } : 'tampered';
    assert.equal(verifyManifest(tampered).ok, false,
      `\`${key}\` can be edited and the record still verifies`);
  }
});

test('the specific lie that used to work is caught', () => {
  // A run that held the filesystem and the network, presented as one that held
  // nothing. This verified as INTACT, and `smarsh audit` printed the lie.
  const r = run('print(1)', { grant: ['fs', 'net'], sign: KEY });
  assert.deepEqual(r.manifest.authority.granted, ['fs', 'net']);

  const lying = JSON.parse(JSON.stringify(r.manifest));
  lying.authority.granted = [];
  lying.authority.exercised = [];

  const v = verifyManifest(lying);
  assert.equal(v.ok, false, 'the granted capabilities can still be erased');
  assert.ok(v.problems.length > 0);
});

test('a refusal cannot be removed from the summary', () => {
  const r = run('attempt { read("x") } rescue e { print("fine") }', { grant: [], sign: KEY });
  assert.equal(r.manifest.authority.refused.fs, 1);

  const lying = JSON.parse(JSON.stringify(r.manifest));
  lying.authority.refused = {};
  assert.equal(verifyManifest(lying).ok, false, 'a refusal can be erased from the summary');
});

test('events cannot be swapped between records signed by the same key', () => {
  const a = run('attempt { read("secret") } rescue e {}', { grant: [], sign: KEY });
  const b = run('print("innocent")', { grant: [], sign: KEY });

  const grafted = JSON.parse(JSON.stringify(a.manifest));
  grafted.events = JSON.parse(JSON.stringify(b.manifest.events));
  assert.equal(verifyManifest(grafted).ok, false);
});

test('reordering or dropping an event breaks the chain', () => {
  const r = run('attempt { read("a") } rescue e {}\nattempt { now() } rescue e {}', { grant: [] });
  assert.ok(r.manifest.events.length >= 2);

  const swapped = JSON.parse(JSON.stringify(r.manifest));
  [swapped.events[0], swapped.events[1]] = [swapped.events[1], swapped.events[0]];
  assert.equal(verifyManifest(swapped).ok, false, 'events can be reordered');

  const dropped = JSON.parse(JSON.stringify(r.manifest));
  dropped.events.pop();
  assert.equal(verifyManifest(dropped).ok, false, 'the last event can be dropped');
});

test('a program cannot forge an event by printing one', () => {
  const r = run('print("line 1    data.released    marketing")', { grant: [] });
  assert.ok(!(r.manifest.events ?? []).some((e) => String(e.to) === 'marketing'));
});

test('every refusal is recorded, not sampled', () => {
  // A program that refuses three hundred times must produce three hundred
  // refusals. Anything that summarises or caps them is a place to hide one.
  const r = run('var i = 0\nwhile i < 300 { attempt { read("x") } rescue e { i = i + 1 } }',
    { grant: [], steps: 5_000_000 });
  assert.equal(r.refused.length, 300, `${r.refused.length} of 300 refusals recorded`);
});

test('a failed run still produces a verifiable record with its refusals', () => {
  const r = run('attempt { read("x") } rescue e { print("caught") }\nlet boom = nope', { grant: [] });
  assert.equal(r.ok, false);
  assert.equal(verifyManifest(r.manifest).ok, true);
  assert.equal(r.refused.length, 1, 'the refusal was lost when the run failed');
});

// ---------------------------------------------------------------------------
// authority, and the places it usually leaks
// ---------------------------------------------------------------------------

test('a callback cannot borrow authority from the builtin that calls it', () => {
  // The classic capability leak: user code handed to a privileged builtin,
  // running with the builtin's authority instead of its own.
  for (const [how, code] of [
    ['map', 'let xs = [1]\nxs.map(fn(x) { return read("secret") })'],
    ['filter', 'let xs = [1]\nxs.filter(fn(x) { return read("secret") != nil })'],
    ['reduce', 'let xs = [1]\nxs.reduce(fn(a, b) { return read("secret") }, 0)'],
    ['a requires clause', 'fn f(n) requires read("secret") != nil { return n }\nf(1)'],
  ]) {
    const r = run(code, { grant: [] });
    assert.equal(r.error?.kind, 'CapabilityError', `a callback through ${how} reached the disk`);
    assert.ok(r.refused.some((x) => x.capability === 'fs'),
      `a callback through ${how} was stopped but not recorded`);
  }
});

test('a classified value cannot be carried out of its policy', () => {
  // Putting it in something and taking it out again is the obvious attack.
  for (const [how, code] of [
    ['a list', 'let box = [v]\nrelease_to "bob" { print(str(box[0])) }'],
    ['a map', 'let m = { "k": v }\nrelease_to "bob" { print(str(m["k"])) }'],
    ['a record', 'record R(x)\nrelease_to "bob" { print(str(R(v).x)) }'],
    ['a closure', 'let f = fn() { return v }\nrelease_to "bob" { print(str(f())) }'],
    ['concatenation', 'release_to "bob" { print("x" + str(v)) }'],
    ['interpolation', 'release_to "bob" { print("${v}") }'],
  ]) {
    const r = run(`let v = classify("s", "alice", ["alice"])\n${code}`, { grant: [] });
    assert.equal(r.error?.kind, 'LabelError', `a classified value escaped through ${how}`);
  }
});

test('declassifying needs the owner, a reason, and cannot be faked', () => {
  assert.equal(run('declassify(classify(1, "alice"), "alice", "why")').ok, false);
  assert.equal(run('authority "bob" { declassify(classify(1, "alice"), "alice", "why") }',
    { principals: ['bob'] }).ok, false);
  assert.equal(run('authority "alice" { declassify(classify(1, "alice"), "alice", "") }',
    { principals: ['alice'] }).ok, false);
});

// ---------------------------------------------------------------------------
// bounds
// ---------------------------------------------------------------------------

test('nothing a program can write takes the host down', () => {
  for (const [what, code, steps] of [
    ['unbounded recursion', 'fn f() { return f() }\nf()', 1_000_000],
    ['unbounded allocation', 'var s = ""\nwhile true { s = s + "aaaaaaaaaaaaaaaa" }', 200_000],
    ['an empty infinite loop', 'while true { }', 100_000],
  ]) {
    const started = Date.now();
    const r = run(code, { steps });
    assert.equal(r.ok, false, `${what} completed, which it should not`);
    assert.ok(Date.now() - started < 20_000, `${what} took too long to stop`);
  }
});

test('a catastrophic pattern stays linear from inside the language', () => {
  const started = Date.now();
  const r = run(`print(str(re_test(r"(a+)+b", "${'a'.repeat(60)}")))`, { steps: 5_000_000 });
  assert.equal(r.ok, true);
  assert.ok(Date.now() - started < 5000, 'the linear bound is gone');
});

test('deeply nested input is refused rather than overflowing the host', () => {
  const r = run(`attempt { json_parse("${'['.repeat(400)}") } rescue e { print(e["kind"]) }`);
  assert.equal(r.ok, true);
  assert.deepEqual(r.output, ['JsonError']);
});

// ---------------------------------------------------------------------------
// provenance
// ---------------------------------------------------------------------------

test('taint cannot be laundered by moving a value through anything', () => {
  // Ten routes out. If any of them drops the label, every provenance check in
  // the language can be bypassed by taking that route.
  for (const [how, code] of [
    ['JSON', 'let d = json_parse(untrusted("{\\"a\\":1}"))\nprint(str(is_tainted(d["a"])))'],
    ['str()', 'print(str(is_tainted(str(untrusted("x")))))'],
    ['a list', 'let xs = [untrusted("x")]\nprint(str(is_tainted(xs[0])))'],
    ['a map', 'let m = { "k": untrusted("x") }\nprint(str(is_tainted(m["k"])))'],
    ['a record', 'record R(v)\nprint(str(is_tainted(R(untrusted("x")).v)))'],
    ['arithmetic', 'print(str(is_tainted(untrusted(1) + 1)))'],
    ['a closure', 'let f = fn() { return untrusted("x") }\nprint(str(is_tainted(f())))'],
    ['regex', 'print(str(is_tainted(re_replace(r"x", untrusted("x"), "y"))))'],
    ['a string method', 'print(str(is_tainted(untrusted("abc").upper())))'],
    ['interpolation', 'let u = untrusted("x")\nprint(str(is_tainted("${u}")))'],
  ]) {
    const r = run(code, { grant: [] });
    assert.deepEqual(r.output, ['true'], `taint was laundered through ${how}`);
  }
});

// ---------------------------------------------------------------------------
// replay, which is what makes a record worth checking
// ---------------------------------------------------------------------------

test('the same program and seed produce the same record', () => {
  const src = 'var t = 0\nfor i in range(30) { t = t + randint(1, 9) }\nprint(str(t))';
  const a = run(src, { seed: 5 });
  const b = run(src, { seed: 5 });
  assert.deepEqual(a.output, b.output);
  assert.equal(a.manifest.head, b.manifest.head, 'two identical runs disagree');
});
