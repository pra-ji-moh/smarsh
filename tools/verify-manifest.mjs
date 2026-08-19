#!/usr/bin/env node
// Verify a Pedag audit record. Standalone, on purpose.
//
// This file imports nothing from Pedag. It uses only `node:crypto`, and it is
// short enough to read in full before you trust it -- which is the point.
// Evidence that can only be checked by the tool that produced it is not
// evidence, it is a claim.
//
//     node verify-manifest.mjs run.json [expected-signer.pem]
//
// It checks three things, in order:
//
//   1. the header anchor  -- the program hash, seed, granted capabilities and
//                            outcome are folded into a digest that every event
//                            hashes back to, so none of them can be edited
//   2. the chain          -- each event hashes onto the one before it, so no
//                            event can be altered, deleted, reordered or added
//   3. the signature      -- Ed25519 over the final hash, in SPKI DER, which
//                            openssl and every other library already reads
//
// Exit 0 if the record is intact, 1 if it is not.

import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const [, , file, expectedKeyFile] = process.argv;
if (!file) {
  console.error('usage: node verify-manifest.mjs <run.json> [expected-signer.pem]');
  process.exit(2);
}

const m = JSON.parse(readFileSync(file, 'utf8'));
const problems = [];

// 1. The header. Recompute the anchor from the fields as they stand now; if any
//    of them was edited, this will not match what the events were built on.
const { manifest, runtime, program, replay, outcome } = m;
const genesis = sha256(JSON.stringify({ manifest, runtime, program, replay, outcome }));
if (m.genesis !== undefined && genesis !== m.genesis) {
  problems.push('the header has been altered (program, seed, capabilities or outcome)');
}

// 2. The chain.
let head = m.genesis ?? '0'.repeat(64);
m.events.forEach((e, i) => {
  const { seq, prev, hash, ...payload } = e;
  if (seq !== i) problems.push(`event ${i} is numbered ${seq}`);
  if (prev !== head) problems.push(`event ${i} does not follow the one before it`);
  if (hash !== sha256(`${head}|${i}|${JSON.stringify(payload)}`)) {
    problems.push(`event ${i} has been altered`);
  }
  head = hash;
});
if (head !== m.head) problems.push('the final hash does not match the chain');

// 3. The signature.
let signer = null;
let matchedExpected = false;
if (m.signature) {
  try {
    const key = createPublicKey({
      key: Buffer.from(m.signature.public_key, 'hex'), format: 'der', type: 'spki',
    });
    const ok = verify(null, Buffer.from(m.head), key, Buffer.from(m.signature.value, 'hex'));
    if (!ok) problems.push('the signature does not match the head');
    else signer = m.signature.public_key;
  } catch (e) {
    problems.push(`the signature could not be checked: ${e.message}`);
  }
}

// Optionally: is it signed by the identity you expected? A valid signature by
// an unknown key proves the record is unedited, not that it came from anyone in
// particular.
if (expectedKeyFile) {
  const pem = readFileSync(expectedKeyFile, 'utf8');
  const expected = createPublicKey({ key: pem, format: 'pem', type: 'spki' })
    .export({ type: 'spki', format: 'der' }).toString('hex');
  if (!signer) problems.push('a signer was expected, but this record is unsigned');
  else if (signer !== expected) problems.push('signed by a different key than the one expected');
  else matchedExpected = true;
}

console.log(`${file}`);
console.log(`  program   ${program?.file ?? '?'}  sha256 ${(program?.sha256 ?? '').slice(0, 32)}`);
console.log(`  replay    --seed ${replay?.seed} ${(replay?.capabilities ?? []).map((c) => `--grant ${c}`).join(' ')}`);
console.log(`  events    ${m.events.length}, head ${String(m.head).slice(0, 16)}`);
// Never claim a match that was not made -- this line sits directly above the
// verdict, and a verification tool that misreports here is worse than none.
const signerNote = !signer ? 'none'
  : `${signer.slice(-16)}${expectedKeyFile ? (matchedExpected ? ' (matches the expected signer)' : ' (NOT the expected signer)') : ''}`;
console.log(`  signature ${signerNote}`);
console.log('');

if (problems.length === 0) {
  console.log('INTACT');
  process.exit(0);
}
console.log('BROKEN');
for (const p of problems) console.log(`  - ${p}`);
process.exit(1);
