import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Interpreter } from '../src/interpreter.js';
import { buildManifest, verifyManifest, summarise } from '../src/audit.js';
import { generateKeypair, verifyMessage } from '../src/crypto.js';
import { PedagError } from '../src/errors.js';

function record(src, opts = {}) {
  const out = [];
  const interp = new Interpreter({ ...opts, out: (s) => out.push(s) });
  let outcome = 'completed';
  try {
    interp.run(src, 'test.pedag');
  } catch (e) {
    outcome = e instanceof PedagError ? `failed: ${e.kind}` : 'failed';
  }
  const manifest = buildManifest(interp, {
    file: 'test.pedag', source: src, runtimeVersion: '0.3.0', outcome, ...opts.manifest,
  });
  interp.devices.shutdown();
  return { manifest, out };
}

const events = (m, kind) => m.events.filter((e) => e.event === kind);

// ---------------------------------------------------------------------------
// what the record contains
// ---------------------------------------------------------------------------

test('every capability actually exercised is recorded', () => {
  const { manifest } = record('fn save() needs fs { return write("a.txt", "x") }\nsave()',
    { caps: ['fs'], cwd: process.cwd() });
  assert.ok(manifest.authority.exercised.includes('fs'));
  assert.ok(events(manifest, 'capability.used').length > 0);
});

test('a refused capability is recorded, not just thrown', () => {
  // The run a reviewer most wants to see is the one that was stopped.
  const { manifest } = record('fn sneaky() { return write("a.txt", "x") }\nsneaky()', { caps: ['fs'] });
  assert.match(manifest.outcome, /failed: CapabilityError/);
  assert.equal(events(manifest, 'capability.refused').length, 1);
  assert.equal(manifest.authority.refused.fs, 1);
});

test('authority granted but never used is called out', () => {
  const { manifest } = record('print("nothing happens")', { caps: ['fs', 'clock'] });
  assert.deepEqual(manifest.authority.granted_but_unused.sort(), ['clock', 'fs']);
});

test('a refused data release is recorded with the label', () => {
  const { manifest } = record(`
    let s = classify(1, "hr", ["hr"])
    attempt { release_to "marketing" { print(s) } } rescue e { }
  `);
  const refused = events(manifest, 'data.release_refused');
  assert.equal(refused.length, 1);
  assert.equal(refused[0].to, 'marketing');
  assert.match(refused[0].label, /hr/);
});

test('declassification is recorded with its principal and stated reason', () => {
  const { manifest } = record(`
    let s = classify(1, "hr", [])
    authority "hr" { declassify(s, "hr", "approved for the annual report") }
  `, { principals: ['hr'] });
  const d = events(manifest, 'data.declassified');
  assert.equal(d.length, 1);
  assert.equal(d[0].principal, 'hr');
  assert.match(d[0].reason, /annual report/);
});

test('clearing a taint label records the reason given', () => {
  const { manifest } = record('let r = ungrounded("x")\ntrust(r, "checked by a human")');
  const cleared = events(manifest, 'taint.cleared');
  assert.equal(cleared.length, 1);
  assert.match(cleared[0].reason, /checked by a human/);
});

test('delegation and revocation are both recorded', () => {
  const { manifest } = record(`
    let pair = caretaker(grant("fs"))
    using pair["grant"] { }
    revoke(pair["revoker"])
  `, { caps: ['fs'] });
  assert.equal(events(manifest, 'authority.delegated').length, 1);
  assert.equal(events(manifest, 'authority.revoked').length, 1);
});

test('crossing the FFI boundary is recorded', () => {
  const { manifest } = record('let o = foreign("node:os")\no.platform()', { caps: ['ffi'], foreign: ['*'] });
  assert.deepEqual(manifest.data.foreign_modules, ['node:os']);
  assert.equal(events(manifest, 'boundary.crossed').length, 1);
});

test('a weak crypto parameter is recorded as a warning', () => {
  const { manifest } = record('paillier_keygen_insecure(512)', { caps: ['crypto', 'unaudited_crypto'] });
  const warnings = events(manifest, 'crypto.warning');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].detail, /2048 is the minimum/);
});

test('the record carries everything needed to replay the run', () => {
  const { manifest } = record('print(random())', { seed: 42, caps: ['fs'] });
  assert.equal(manifest.replay.seed, 42);
  assert.deepEqual(manifest.replay.capabilities, ['fs']);
  assert.match(manifest.program.sha256, /^[0-9a-f]{64}$/);
});

test('the program is identified by content, not by name', () => {
  const a = record('print(1)').manifest;
  const b = record('print(1)').manifest;
  const c = record('print(2)').manifest;
  assert.equal(a.program.sha256, b.program.sha256);
  assert.notEqual(a.program.sha256, c.program.sha256);
});

// ---------------------------------------------------------------------------
// the record cannot be quietly edited
// ---------------------------------------------------------------------------

test('an untouched record verifies', () => {
  const { manifest } = record('fn f() needs fs { return 1 }\nf()', { caps: ['fs'] });
  assert.equal(verifyManifest(manifest).ok, true);
});

test('deleting the inconvenient event breaks the chain', () => {
  const { manifest } = record(`
    let s = classify(1, "hr", ["hr"])
    attempt { release_to "marketing" { print(s) } } rescue e { }
    let g = grant("fs")
  `, { caps: ['fs'] });

  manifest.events = manifest.events.filter((e) => e.event !== 'data.release_refused');
  const { ok, problems } = verifyManifest(manifest);
  assert.equal(ok, false);
  assert.ok(problems.length > 0, 'a deletion must be reported, not merely fail silently');
  // Which problem is reported depends on where the deleted event sat: removing
  // one from the middle breaks the linkage, removing the last breaks the head.
  assert.ok(problems.some((p) => /does not follow|final hash|altered/.test(p)));
});

test('deleting the last event is caught by the head, not the linkage', () => {
  const { manifest } = record('let r = ungrounded("x")\ntrust(r, "why")');
  manifest.events.pop();
  const { ok, problems } = verifyManifest(manifest);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /final hash/.test(p)));
});

test('editing an event in place is caught', () => {
  const { manifest } = record(`
    let r = ungrounded("x")
    trust(r, "the real reason, which someone would rather not show")
  `);
  const target = manifest.events.find((e) => e.event === 'taint.cleared');
  target.reason = 'a more flattering reason';
  assert.equal(verifyManifest(manifest).ok, false);
});

test('reordering events is caught', () => {
  const { manifest } = record(`
    let pair = caretaker(grant("fs"))
    using pair["grant"] { }
    revoke(pair["revoker"])
  `, { caps: ['fs'] });
  if (manifest.events.length < 2) return;
  [manifest.events[0], manifest.events[1]] = [manifest.events[1], manifest.events[0]];
  assert.equal(verifyManifest(manifest).ok, false);
});

test('appending a flattering event is caught', () => {
  const { manifest } = record('print(1)');
  manifest.events.push({
    event: 'capability.used', capability: 'fs', by: 'write', line: 99, seq: manifest.events.length,
    prev: manifest.head, hash: 'f'.repeat(64),
  });
  assert.equal(verifyManifest(manifest).ok, false);
});

test('recomputing the head after an edit still fails, because the chain is checked', () => {
  // The obvious attack: edit an event and also rewrite `head`. Every
  // intermediate hash is re-derived, so it does not help.
  const { manifest } = record('let r = ungrounded("x")\ntrust(r, "original reason")');
  const target = manifest.events.find((e) => e.event === 'taint.cleared');
  target.reason = 'edited';
  manifest.head = manifest.events[manifest.events.length - 1].hash;
  assert.equal(verifyManifest(manifest).ok, false);
});

// ---------------------------------------------------------------------------
// signing
// ---------------------------------------------------------------------------

test('a signature binds a key to the head', () => {
  const key = generateKeypair();
  const { manifest } = record('fn f() needs fs { return 1 }\nf()',
    { caps: ['fs'], manifest: { signWith: key } });
  assert.equal(manifest.signature.algorithm, 'ed25519');
  assert.ok(verifyMessage(manifest.signature.public_key, manifest.head, manifest.signature.value));
});

test('a signature from another key does not verify', () => {
  const key = generateKeypair();
  const { manifest } = record('print(1)', { manifest: { signWith: key } });
  const other = generateKeypair();
  assert.equal(verifyMessage(other.publicHex, manifest.head, manifest.signature.value), false);
});

test('an unsigned record is still tamper-evident', () => {
  const { manifest } = record('let r = ungrounded("x")\ntrust(r, "why")');
  assert.equal(manifest.signature, undefined);
  manifest.events[0].reason = 'edited';
  assert.equal(verifyManifest(manifest).ok, false);
});

// ---------------------------------------------------------------------------
// the human-readable half
// ---------------------------------------------------------------------------

test('the summary states what a reviewer needs and nothing it cannot support', () => {
  const { manifest } = record(`
    let s = classify(1, "hr", ["hr"])
    attempt { release_to "marketing" { print(s) } } rescue e { }
  `, { caps: ['fs', 'clock'] });
  const text = summarise(manifest);
  assert.match(text, /replay with\s+--seed 0/);
  assert.match(text, /never used\s+clock, fs/);
  assert.match(text, /released\s+0 permitted, 1 refused/);
  assert.match(text, /unsigned/);
});

test('a rejected manifest version is refused rather than misread', () => {
  assert.equal(verifyManifest({ manifest: 99, events: [] }).ok, false);
  assert.equal(verifyManifest(null).ok, false);
});
