import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { Interpreter } from '../src/interpreter.js';
import { buildManifest, verifyManifest } from '../src/audit.js';
import { generateKeypair, verifyMessage } from '../src/crypto.js';

// `pedag demo` is the front door: one command, no arguments, no file to write.
// It makes a falsifiable claim -- "edit any line of this record and the chain
// breaks" -- so the claim is tested rather than asserted.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'pedag.mjs');

const runDemo = () => execFileSync(process.execPath, [CLI, 'demo'], { encoding: 'utf8' });

test('the demo runs, and every refusal it claims actually happens', () => {
  const out = runDemo();
  // Each of these is a refusal the runtime enforced, not a line the program
  // chose to print. If the enforcement regresses, the demo goes quiet here.
  assert.match(out, /may not read this interpolated value/, 'the release to marketing was not refused');
  assert.match(out, /a checked context will not read an unverified claim/, 'the ungrounded claim was not refused');
  assert.match(out, /the invariant will not let the balance go negative/, 'the record invariant did not hold');
  assert.match(out, /the grant was revoked/, 'the revoked capability was still usable');
  assert.match(out, /1250\.00 - 12\.50 = 1237\.50/, 'the decimal arithmetic is not exact');
});

test('the demo ends with a signed, intact record', () => {
  const out = runDemo();
  assert.match(out, /INTACT -- every event hashes onto the one before it/);
  assert.match(out, /and the head is signed by [0-9a-f]{16}/);
  assert.doesNotMatch(out, /unsigned/, 'the demo claims a signature; it must produce one');
  assert.doesNotMatch(out, /undefined/, 'the demo printed an undefined value');
  assert.doesNotMatch(out, /0\.0\.0/, 'the manifest carries no runtime version');
});

// --- the claim the demo makes about tampering -------------------------------

function freshManifest() {
  const source = fs.readFileSync(path.join(ROOT, 'examples', 'demo.pedag'), 'utf8');
  const interp = new Interpreter({
    out: () => {}, caps: ['fs'], principals: ['compliance'], seed: 0,
    cwd: path.join(ROOT, 'examples'),
  });
  interp.entryPath = path.join(ROOT, 'examples', 'demo.pedag');
  try {
    interp.run(source, 'demo.pedag');
  } finally {
    interp.devices.shutdown();
  }
  const key = generateKeypair();
  return {
    manifest: buildManifest(interp, {
      file: 'demo.pedag', source, runtimeVersion: '0.3.0', signWith: key, outcome: 'completed',
    }),
    key,
  };
}

test('an untouched record verifies', () => {
  const { manifest, key } = freshManifest();
  const { ok, problems } = verifyManifest(manifest);
  assert.ok(ok, `an unmodified manifest did not verify: ${problems.join('; ')}`);
  assert.ok(verifyMessage(manifest.signature.public_key, manifest.head, manifest.signature.value));
  assert.equal(manifest.signature.public_key, key.publicHex);
});

test('the record refuses every edit an interested party would want to make', () => {
  // Each of these is what someone would actually do to a compliance record:
  // turn a refusal into an approval, change where data went, delete the
  // inconvenient line, or rewrite the reason a restriction was lifted.
  const edits = [
    ['turn a refusal into an approval', (m) => { m.events[0].event = 'data.release_allowed'; }],
    ['change who the data went to', (m) => { m.events[0].to = 'compliance'; }],
    ['delete the inconvenient event', (m) => { m.events.splice(0, 1); }],
    ['rewrite the stated reason', (m) => { m.events[1].reason = 'approved'; }],
    ['reorder two events', (m) => { const t = m.events[0]; m.events[0] = m.events[1]; m.events[1] = t; }],
    ['append an event that never happened', (m) => {
      m.events.push({ event: 'data.release_allowed', to: 'marketing', line: 1, seq: m.events.length, prev: m.head, hash: m.head });
    }],
    ['claim a different program produced it', (m) => { m.program.sha256 = '0'.repeat(64); }],
  ];

  for (const [what, edit] of edits) {
    const { manifest } = freshManifest();
    edit(manifest);
    const { ok } = verifyManifest(manifest);
    const signed = verifyMessage(manifest.signature.public_key, manifest.head, manifest.signature.value);
    assert.ok(!(ok && signed), `a tampered record still verified: ${what}`);
  }
});

test('two runs of the same program produce the same record, by design', () => {
  // This is determinism, not a flaw: same program, same seed, same evidence.
  // It is also the honest boundary of what the signature proves. The manifest
  // carries no timestamp and no nonce, so it attests to *what ran* and cannot
  // attest to *when* or *how many times*. A deployment that needs those must
  // add them outside -- countersign the record with a timestamping service, or
  // record the receipt against an external log.
  const a = freshManifest();
  const b = freshManifest();
  assert.equal(a.manifest.head, b.manifest.head, 'the same run produced different evidence');
  assert.equal(a.manifest.genesis, b.manifest.genesis);
  assert.deepEqual(a.manifest.events, b.manifest.events);
});

test('the header is inside the chain, not beside it', () => {
  // The hole this closed: the program hash, seed, granted capabilities and
  // outcome used to sit outside the chain and outside the signature, so a
  // record could be lifted from a benign run and attached to a different
  // program while `pedag audit` still reported INTACT.
  for (const [what, edit] of [
    ['the program hash', (m) => { m.program.sha256 = '0'.repeat(64); }],
    ['the file it claims to be', (m) => { m.program.file = 'something-else.pedag'; }],
    ['the seed it claims to replay from', (m) => { m.replay.seed = 999; }],
    ['the capabilities it says were granted', (m) => { m.replay.capabilities = []; }],
    ['the outcome', (m) => { m.outcome = 'failed: CapabilityError'; }],
    ['the runtime version', (m) => { m.runtime = 'pedag 99.0.0'; }],
  ]) {
    const { manifest } = freshManifest();
    edit(manifest);
    const { ok } = verifyManifest(manifest);
    assert.ok(!ok, `the header was edited and the record still verified: ${what}`);
  }
});
