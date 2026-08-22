import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PAILLIER_MIN_BITS, paillierKeygen, paillierEncrypt, paillierDecrypt,
  ZK, ZkProof, zkPublic, zkProve, zkVerify, pedersenCommit, pedersenVerify,
} from '../src/crypto.js';
import { randomBelow, gcd, modpow, bitLength } from '../src/bigmath.js';
import { Interpreter } from '../src/interpreter.js';

// The hand-rolled primitives behind `unaudited_crypto` are still hand-rolled
// and still not constant time. There is no audited JavaScript Paillier to
// replace them with, and swapping in an unaudited npm package would trade this
// code for someone else's unaudited code plus a supply chain.
//
// What could be fixed was fixed: biased sampling in two places where uniformity
// is the security assumption, a missing coprimality condition, a key size that
// provided nothing, and a verifier that used its inputs without validating
// them. These tests hold those closed.

const CRYPTO = { caps: ['crypto', 'unaudited_crypto'] };

function run(source, opts = {}) {
  const out = [];
  const warns = [];
  const interp = new Interpreter({
    out: (s) => out.push(s), warn: (s) => warns.push(s), seed: 1, ...CRYPTO, ...opts,
  });
  try {
    interp.run(source, 't.pedag');
    return { out, warns, error: null, interp };
  } catch (e) {
    return { out, warns, error: e.kind ?? 'error', message: e.message ?? '', interp };
  } finally {
    interp.devices.shutdown();
  }
}

// ---------------------------------------------------------------------------
// uniform sampling
// ---------------------------------------------------------------------------

test('randomBelow stays in range, including at the edges', () => {
  assert.equal(randomBelow(1n), 0n);
  for (const n of [2n, 3n, 255n, 256n, 257n, 1n << 64n, (1n << 512n) + 7n]) {
    for (let i = 0; i < 50; i++) {
      const v = randomBelow(n);
      assert.ok(v >= 0n && v < n, `${v} is not below ${n}`);
    }
  }
  assert.throws(() => randomBelow(0n));
  assert.throws(() => randomBelow(-5n));
});

test('randomBelow reaches the low half, which the old sampling never did', () => {
  // `randomBits` forces the top bit, so `randomBits(k) % n` could not produce a
  // value below n/2 unless the modulo wrapped it there. That is the bias, and
  // it is the one that matters for a nonce.
  const n = 1n << 64n;
  let low = 0;
  for (let i = 0; i < 400; i++) if (randomBelow(n) < n / 2n) low++;
  assert.ok(low > 150 && low < 250, `${low}/400 in the low half -- not uniform`);
});

test('randomBelow is flat across small buckets', () => {
  const counts = [0, 0, 0, 0, 0];
  for (let i = 0; i < 10000; i++) counts[Number(randomBelow(5n))] += 1;
  for (const c of counts) {
    assert.ok(c > 1700 && c < 2300, `bucket counts ${counts.join(',')} are not flat`);
  }
});

// ---------------------------------------------------------------------------
// Paillier
// ---------------------------------------------------------------------------

test('a key size that protects nothing is refused, and says what to do instead', () => {
  assert.throws(() => paillierKeygen(512), /provides no security/);
  assert.throws(() => paillierKeygen(512), /paillier_keygen_insecure/);
  assert.throws(() => paillierKeygen(PAILLIER_MIN_BITS - 1), /provides no security/);
});

test('it can still be asked for, by a name that admits what it is', () => {
  const k = paillierKeygen(512, { insecure: true });
  assert.equal(bitLength(k.n), 512);
  assert.equal(paillierDecrypt(k, paillierEncrypt(k, -7n)), -7n);
  // But not below the point where the maths itself stops working.
  assert.throws(() => paillierKeygen(128, { insecure: true }), /not meaningful/);
});

test('the blinding factor is a unit, every time', () => {
  // `r > 1` is not `gcd(r, n) = 1`. An r sharing a factor with n breaks the
  // blinding and leaks the factorisation. The check is cheap; the failure is not.
  const k = paillierKeygen(512, { insecure: true });
  for (let i = 0; i < 200; i++) {
    const c = paillierEncrypt(k, 3n);
    assert.equal(gcd(c.value, k.n), 1n, 'a ciphertext shares a factor with the modulus');
  }
});

test('encryption is still randomised and still round-trips', () => {
  const k = paillierKeygen(512, { insecure: true });
  const seen = new Set();
  for (let i = 0; i < 30; i++) seen.add(paillierEncrypt(k, 42n).value.toString());
  assert.equal(seen.size, 30, 'the same plaintext produced the same ciphertext twice');
  for (const m of [0n, 1n, -1n, 12345n, -98765n]) {
    assert.equal(paillierDecrypt(k, paillierEncrypt(k, m)), m);
  }
});

// ---------------------------------------------------------------------------
// Schnorr: a verifier that validates its input
// ---------------------------------------------------------------------------

test('a genuine proof verifies', () => {
  for (const x of [1n, 2n, 12345n, ZK.Q - 1n]) {
    assert.equal(zkVerify(zkPublic(x), zkProve(x)), true, `failed for x = ${x}`);
  }
});

test('a proof for a different secret does not', () => {
  assert.equal(zkVerify(zkPublic(9n), zkProve(12345n)), false);
});

test('a public value outside the order-q subgroup is rejected', () => {
  // The soundness argument assumes membership. An element in a small subgroup
  // is exactly what an attacker submits when nothing checks. Also defence in
  // depth: the equation rejected most of these already, but `y = P` and `y = 0`
  // reached `modpow` unvalidated, and a verifier should not be relying on what
  // its arithmetic happens to do with input it never looked at.
  const proof = zkProve(5n);
  for (const bad of [0n, 1n, ZK.P, ZK.P + 1n, -1n]) {
    assert.equal(zkVerify(bad, proof), false, `${bad} was accepted as a public value`);
  }
  // A quadratic non-residue is in Z*_p but not in the subgroup.
  let nonResidue = null;
  for (let g = 2n; g < 60n; g++) {
    if (modpow(g, ZK.Q, ZK.P) !== 1n) { nonResidue = g; break; }
  }
  assert.ok(nonResidue !== null, 'the test could not find a non-residue');
  assert.equal(zkVerify(nonResidue, proof), false, 'a non-member was accepted');
});

// Defence in depth rather than a bug that was: the old verifier rejected these
// too, because the equation happens not to hold for them. It relied on the
// algebra to catch malformed input instead of checking. The next case is the
// one where that reliance actually failed.
test('a proof carrying a commitment outside the subgroup is rejected', () => {
  const x = 777n;
  const y = zkPublic(x);
  const good = zkProve(x);
  assert.equal(zkVerify(y, good), true);
  for (const badT of [0n, 1n, 3n, ZK.P, ZK.P + 2n]) {
    assert.equal(zkVerify(y, new ZkProof(badT, good.s)), false, `t = ${badT} was accepted`);
  }
});

test('a response outside [0, q) is rejected rather than reduced', () => {
  // This one was real. G has order q, so G^(s+q) == G^s and the old verifier --
  // which checked nothing about `s` -- accepted (t, s + kq) for every k. One
  // valid proof could be turned into unboundedly many distinct valid proofs,
  // which is proof malleability, and it breaks anything that treats a proof as
  // an identifier: deduplication, replay detection, a nonce set, an audit trail
  // keyed on what was seen before.
  const x = 777n;
  const y = zkPublic(x);
  const good = zkProve(x);
  for (const badS of [-1n, ZK.Q, ZK.Q + good.s, 2n * ZK.Q + good.s]) {
    assert.equal(zkVerify(y, new ZkProof(good.t, badS)), false, `s = ${badS} was accepted`);
  }
  // The genuine one still verifies, so the range check did not just say no to
  // everything.
  assert.equal(zkVerify(y, good), true);
});

test('anything that is not a proof is rejected', () => {
  const y = zkPublic(5n);
  for (const junk of [null, undefined, 0, 'proof', {}, { t: 4n, s: 1n }]) {
    assert.equal(zkVerify(y, junk), false);
  }
});

test('the nonce is drawn from the whole order, not 256 bits of it', () => {
  // A biased or short Schnorr nonce is the standard route to the private key.
  // The old sampling was `randomBits(256) % Q` against a 2047-bit order; if it
  // came back, every `t` would be a power of G with a 256-bit exponent, and the
  // spread of `s` would collapse with it.
  const lengths = new Set();
  for (let i = 0; i < 40; i++) lengths.add(bitLength(zkProve(31337n).s));
  const max = Math.max(...lengths);
  assert.ok(max > 2000, `the widest response was ${max} bits; the nonce is not full width`);
});

// ---------------------------------------------------------------------------
// Pedersen
// ---------------------------------------------------------------------------

test('a commitment opens to what was committed, and nothing else', () => {
  const c = pedersenCommit(7n, 99n);
  assert.equal(pedersenVerify(c, 7n, 99n), true);
  assert.equal(pedersenVerify(c, 8n, 99n), false);
  assert.equal(pedersenVerify(c, 7n, 98n), false);
});

test('a commitment outside the subgroup opens to nothing', () => {
  assert.equal(pedersenVerify({ c: 3n }, 7n, 99n), false);
  assert.equal(pedersenVerify({ c: 0n }, 0n, 0n), false);
});

test('the two generators are independent, as far as the group can say', () => {
  // H must be in the subgroup and must not be G, or the commitment binds to
  // nothing. Its discrete log is unknown by construction: a hash, squared.
  assert.equal(modpow(ZK.H, ZK.Q, ZK.P), 1n, 'H is not in the order-q subgroup');
  assert.notEqual(ZK.H, ZK.G);
  assert.ok(ZK.H > 1n && ZK.H < ZK.P);
});

// ---------------------------------------------------------------------------
// through the language
// ---------------------------------------------------------------------------

test('the language refuses the insecure size under the ordinary name', () => {
  const r = run('let k = paillier_keygen(512)');
  assert.notEqual(r.error, null);
  assert.match(r.message, /provides no security/);
});

test('and warns on stderr when asked for it by name, without needing --audit', () => {
  // This went only into the audit manifest, so a run without `--audit`
  // generated a key that protects nothing in complete silence.
  const r = run('let k = paillier_keygen_insecure(512)\nprint(str(k))');
  assert.equal(r.error, null);
  assert.equal(r.warns.length, 1);
  assert.match(r.warns[0], /warning: a 512-bit Paillier modulus/);
  assert.match(r.warns[0], /protects nothing/);
  // And it is still on the record for a reviewer reading the manifest.
  assert.equal(r.interp.trace.cryptoWarnings.length, 1);
});

test('the insecure name needs the same capability as the rest', () => {
  const out = [];
  const interp = new Interpreter({ out: (s) => out.push(s), warn: () => {}, caps: ['crypto'], seed: 1 });
  try {
    assert.throws(
      () => interp.run('paillier_keygen_insecure(512)', 't.pedag'),
      (e) => e.kind === 'CapabilityError',
    );
  } finally {
    interp.devices.shutdown();
  }
});

test('the default key size is a real one', () => {
  // `paillier_keygen()` used to default to 512. Whatever it defaults to must be
  // a size the same function would accept if you typed it.
  assert.ok(PAILLIER_MIN_BITS >= 2048);
  assert.doesNotThrow(() => paillierKeygen(PAILLIER_MIN_BITS, { insecure: true }));
});
