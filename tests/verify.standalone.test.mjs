import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// The standalone verifier, tested as an outsider would use it.
//
// The claim being defended: a Pedag audit record can be checked by someone who
// does not trust Pedag and will not install it. tools/verify-manifest.mjs
// imports nothing from src/, so these tests are also a guard against it
// quietly growing a dependency and the claim becoming false.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'pedag.mjs');
const VERIFY = path.join(ROOT, 'tools', 'verify-manifest.mjs');

let dir;
let keyFile;
let manifestFile;

function setup() {
  if (dir) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedag-verify-'));
  keyFile = path.join(dir, 'k.pem');
  manifestFile = path.join(dir, 'run.json');
  execFileSync(process.execPath, [CLI, 'keygen', '-o', keyFile], { encoding: 'utf8' });
  execFileSync(process.execPath, [
    CLI, 'run', path.join(ROOT, 'examples', 'demo.pedag'),
    '--grant', 'fs', '--principal', 'compliance',
    '--audit', manifestFile, '--key', keyFile,
  ], { encoding: 'utf8' });
}

function verify(file, expectedPub) {
  const args = [VERIFY, file];
  if (expectedPub) args.push(expectedPub);
  try {
    return { ok: true, out: execFileSync(process.execPath, args, { encoding: 'utf8' }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const tampered = (edit) => {
  setup();
  const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  edit(m);
  const p = path.join(dir, `t-${Math.abs(JSON.stringify(m).length)}-${process.hrtime.bigint()}.json`);
  fs.writeFileSync(p, JSON.stringify(m, null, 2));
  return p;
};

test('the standalone verifier imports nothing from the runtime it checks', () => {
  const source = fs.readFileSync(VERIFY, 'utf8');
  const imports = [...source.matchAll(/^import .*?from '([^']+)';/gm)].map((m) => m[1]);
  for (const i of imports) {
    assert.ok(i.startsWith('node:'),
      `verify-manifest.mjs imports ${i}; it must depend on nothing but node builtins`);
  }
});

test('a genuine record verifies, and names its signer', () => {
  setup();
  const r = verify(manifestFile, `${keyFile}.pub`);
  assert.ok(r.ok, r.out);
  assert.match(r.out, /INTACT/);
  assert.match(r.out, /matches the expected signer/);
});

test('a record signed by someone else is rejected', () => {
  setup();
  const other = path.join(dir, 'other.pem');
  execFileSync(process.execPath, [CLI, 'keygen', '-o', other], { encoding: 'utf8' });
  const r = verify(manifestFile, `${other}.pub`);
  assert.ok(!r.ok, 'a record signed by a different key was accepted');
  assert.match(r.out, /NOT the expected signer/);
  assert.doesNotMatch(r.out, /\(matches the expected signer\)/);
});

test('it rejects every edit, using only node crypto', () => {
  const edits = [
    ['the program hash', (m) => { m.program.sha256 = '0'.repeat(64); }],
    ['the seed', (m) => { m.replay.seed = 99; }],
    ['the granted capabilities', (m) => { m.replay.capabilities = ['fs', 'net']; }],
    ['the outcome', (m) => { m.outcome = 'failed'; }],
    ['a refusal turned into an approval', (m) => { m.events[0].event = 'data.release_allowed'; }],
    ['who the data went to', (m) => { m.events[0].to = 'compliance'; }],
    ['a deleted event', (m) => { m.events.splice(0, 1); }],
    ['a reordering', (m) => { const t = m.events[0]; m.events[0] = m.events[1]; m.events[1] = t; }],
    ['the signature', (m) => { m.signature.value = m.signature.value.replace(/^../, 'ff'); }],
  ];
  for (const [what, edit] of edits) {
    const r = verify(tampered(edit), `${keyFile}.pub`);
    assert.ok(!r.ok, `the verifier accepted a record with ${what} edited`);
    assert.match(r.out, /BROKEN/);
  }
});

test('it agrees with `pedag audit` on the same record', () => {
  setup();
  const standalone = verify(manifestFile);
  const own = execFileSync(process.execPath, [CLI, 'audit', manifestFile], { encoding: 'utf8' });
  assert.ok(standalone.ok);
  assert.match(own, /INTACT/);

  const broken = tampered((m) => { m.events[0].to = 'nobody'; });
  assert.ok(!verify(broken).ok, 'the standalone verifier accepted a tampered record');
  let ownRejected = false;
  try {
    execFileSync(process.execPath, [CLI, 'audit', broken], { encoding: 'utf8' });
  } catch {
    ownRejected = true;
  }
  assert.ok(ownRejected, '`pedag audit` accepted a record the standalone verifier rejected');
});

test('a kept key signs many runs with one identity', () => {
  setup();
  const second = path.join(dir, 'second.json');
  execFileSync(process.execPath, [
    CLI, 'run', path.join(ROOT, 'examples', 'money.pedag'),
    '--audit', second, '--key', keyFile,
  ], { encoding: 'utf8' });

  const a = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const b = JSON.parse(fs.readFileSync(second, 'utf8'));
  assert.equal(a.signature.public_key, b.signature.public_key, 'the same key produced two identities');
  assert.notEqual(a.head, b.head, 'two different programs produced the same record');
  assert.ok(verify(second, `${keyFile}.pub`).ok);
});
