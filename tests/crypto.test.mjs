import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Interpreter } from '../src/interpreter.js';
import { PedagError } from '../src/errors.js';
import { Ledger } from '../src/values.js';
import {
  ZK, sha256Hex, paillierKeygen, paillierEncrypt, paillierDecrypt,
  heAdd, heMulPlain, zkPublic, zkProve, zkVerify, pedersenCommit, pedersenVerify,
  generateKeypair, signMessage, verifyMessage, LineageChain, Secret,
} from '../src/crypto.js';
import { modpow, isProbablePrime, modinv, randomPrime, bitLength } from '../src/bigmath.js';

// The hand-rolled group arithmetic sits behind its own capability, separate
// from the platform-backed primitives.
const CRYPTO = { caps: ['crypto', 'unaudited_crypto'] };

function run(src, opts = {}) {
  const out = [];
  const interp = new Interpreter({ ...opts, out: (s) => out.push(s) });
  const value = interp.run(src, '<test>');
  return { value, out, interp };
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
// big integer arithmetic
// ---------------------------------------------------------------------------

test('modpow and modinv agree with definitions', () => {
  assert.equal(modpow(2n, 10n, 1000n), 24n);
  assert.equal(modpow(3n, 0n, 7n), 1n);
  const m = 1000003n;
  const a = 123457n;
  assert.equal((a * modinv(a, m)) % m, 1n);
});

test('Miller-Rabin agrees with known primes and composites', () => {
  assert.ok(isProbablePrime(97n));
  assert.ok(isProbablePrime(2n ** 61n - 1n));            // a Mersenne prime
  assert.equal(isProbablePrime(561n), false);            // Carmichael number
  assert.equal(isProbablePrime(1105n), false);           // Carmichael number
  assert.equal(isProbablePrime(2n ** 64n), false);
});

test('generated primes are prime and the right size', () => {
  const p = randomPrime(128);
  assert.equal(bitLength(p), 128);
  assert.ok(isProbablePrime(p));
});

// ---------------------------------------------------------------------------
// the ZK group is what it claims to be
// ---------------------------------------------------------------------------

test('the group parameters are a genuine safe prime, not a recalled constant', () => {
  assert.equal(bitLength(ZK.P), 2048);
  assert.ok(isProbablePrime(ZK.P, 12), 'P must be prime');
  assert.ok(isProbablePrime(ZK.Q, 12), 'Q = (P-1)/2 must be prime');
  assert.equal(ZK.P, 2n * ZK.Q + 1n);
  assert.equal(modpow(ZK.G, ZK.Q, ZK.P), 1n, 'G must have order Q');
  assert.equal(modpow(ZK.H, ZK.Q, ZK.P), 1n, 'H must lie in the same subgroup');
  assert.notEqual(ZK.G, ZK.H);
});

// ---------------------------------------------------------------------------
// Paillier
// ---------------------------------------------------------------------------

test('Paillier round-trips, including negatives and zero', () => {
  const k = paillierKeygen(512);
  for (const m of [0n, 1n, 42n, -7n, 1000000n, -999999n]) {
    assert.equal(paillierDecrypt(k, paillierEncrypt(k, m)), m, `failed for ${m}`);
  }
});

test('ciphertexts add without decrypting', () => {
  const k = paillierKeygen(512);
  const sum = heAdd(paillierEncrypt(k, 1200n), paillierEncrypt(k, 800n));
  assert.equal(paillierDecrypt(k, sum), 2000n);
});

test('a ciphertext scales by a plaintext', () => {
  const k = paillierKeygen(512);
  assert.equal(paillierDecrypt(k, heMulPlain(paillierEncrypt(k, 250n), 4n)), 1000n);
});

test('encryption is randomised: the same value twice gives different ciphertexts', () => {
  const k = paillierKeygen(512);
  const a = paillierEncrypt(k, 5n);
  const b = paillierEncrypt(k, 5n);
  assert.notEqual(a.value, b.value);
  assert.equal(paillierDecrypt(k, a), paillierDecrypt(k, b));
});

test('a public key cannot decrypt', () => {
  const k = paillierKeygen(512);
  assert.throws(() => paillierDecrypt(k.publicOnly(), paillierEncrypt(k, 1n)), /cannot decrypt/);
});

test('the language does encrypted arithmetic with ordinary operators', () => {
  const { value } = run(`
    let k = paillier_keygen(512)
    let a = encrypt(k, 300)
    let b = encrypt(k, 45)
    [decrypt(k, a + b), decrypt(k, a - b), decrypt(k, a * 3), decrypt(k, a + 5)]
  `, CRYPTO);
  assert.deepEqual(value, [345, 255, 900, 305]);
});

test('multiplying two ciphertexts is refused with an explanation', () => {
  const e = fails(`
    let k = paillier_keygen(512)
    encrypt(k, 2) * encrypt(k, 3)
  `, CRYPTO);
  assert.equal(e.kind, 'TypeError');
  assert.match(e.message, /additively homomorphic/);
});

test('ciphertexts refuse to be compared', () => {
  const e = fails('let k = paillier_keygen(512)\nencrypt(k, 1) == encrypt(k, 1)', CRYPTO);
  assert.match(e.message, /cannot be compared/);
});

test('the unaudited primitives are behind their own capability', () => {
  assert.equal(fails('paillier_keygen(512)').kind, 'CapabilityError');
  // Holding `crypto` is deliberately not enough: a deployment can take the
  // platform-backed primitives and refuse the hand-rolled ones.
  assert.equal(fails('paillier_keygen(512)', { caps: ['crypto'] }).kind, 'CapabilityError');
  assert.equal(fails('zk_verify(zk_public(1), zk_prove(1))', { caps: ['crypto'] }).kind, 'CapabilityError');
  assert.equal(fails('commit(1, 2)', { caps: ['crypto'] }).kind, 'CapabilityError');
});

test('the platform-backed primitives stay on `crypto`', () => {
  const { value } = run('let kp = keypair()\nverify_signature(kp.public, "m", sign(kp, "m"))',
    { caps: ['crypto'] });
  assert.equal(value, true);
});

test('an undersized modulus is recorded rather than passed over', () => {
  const { interp } = run('paillier_keygen(512)', CRYPTO);
  assert.equal(interp.trace.cryptoWarnings.length, 1);
  assert.match(interp.trace.cryptoWarnings[0], /2048 is the minimum/);
});

// ---------------------------------------------------------------------------
// zero knowledge
// ---------------------------------------------------------------------------

test('a Schnorr proof verifies against its own public element', () => {
  const x = 123456789n;
  assert.ok(zkVerify(zkPublic(x), zkProve(x)));
});

test('a proof does not verify against a different secret', () => {
  assert.equal(zkVerify(zkPublic(999n), zkProve(123n)), false);
});

test('a tampered proof fails', () => {
  const x = 55n;
  const proof = zkProve(x);
  proof.s += 1n;
  assert.equal(zkVerify(zkPublic(x), proof), false);
});

test('proofs are fresh: two proofs of the same secret differ', () => {
  const a = zkProve(77n);
  const b = zkProve(77n);
  assert.notEqual(a.t, b.t);
  assert.ok(zkVerify(zkPublic(77n), a) && zkVerify(zkPublic(77n), b));
});

test('Pedersen commitments bind and hide', () => {
  const c = pedersenCommit(4200n, 987654321n);
  assert.ok(pedersenVerify(c, 4200n, 987654321n));
  assert.equal(pedersenVerify(c, 4201n, 987654321n), false);   // binding
  assert.equal(pedersenVerify(c, 4200n, 987654322n), false);   // needs the blinding factor
  // Different blinding factors hide the same value behind different commitments.
  assert.notEqual(pedersenCommit(1n, 2n).c, pedersenCommit(1n, 3n).c);
});

test('zero knowledge reaches the language, including proving over a secret', () => {
  const { value } = run(`
    let pw = secret_of("correct horse battery staple")
    let y = zk_public(pw)
    let p = zk_prove(pw)
    [zk_verify(y, p), zk_verify(zk_public(secret_of("wrong")), p)]
  `, CRYPTO);
  assert.deepEqual(value, [true, false]);
});

// ---------------------------------------------------------------------------
// signatures and lineage
// ---------------------------------------------------------------------------

test('Ed25519 signs and verifies, and rejects edits', () => {
  const kp = generateKeypair();
  const sig = signMessage(kp, 'settle 100 ACME');
  assert.ok(verifyMessage(kp.publicHex, 'settle 100 ACME', sig));
  assert.equal(verifyMessage(kp.publicHex, 'settle 200 ACME', sig), false);
  assert.equal(verifyMessage(generateKeypair().publicHex, 'settle 100 ACME', sig), false);
});

test('a lineage chain verifies hashes and signatures together', () => {
  const chain = new LineageChain('sensor-7', generateKeypair());
  chain.record('raw 41.2');
  chain.record('calibrated 40.9');
  chain.record('normalized 0.409');
  assert.ok(chain.verify());
});

test('editing a recorded step breaks the lineage', () => {
  const chain = new LineageChain('sensor-7', generateKeypair());
  chain.record('raw 41.2');
  chain.record('calibrated 40.9');
  chain.entries[0].payload = 'raw 99.9';
  assert.equal(chain.verify(), false);
});

test('removing or reordering steps breaks the lineage', () => {
  const chain = new LineageChain('s', generateKeypair());
  chain.record('a');
  chain.record('b');
  chain.record('c');
  const dropped = new LineageChain('s', chain.keypair);
  dropped.entries = [chain.entries[0], chain.entries[2]];
  dropped.head = chain.head;
  assert.equal(dropped.verify(), false);
});

test('re-signing a forged entry with another key still fails', () => {
  const chain = new LineageChain('s', generateKeypair());
  chain.record('a');
  const attacker = generateKeypair();
  chain.entries[0].payload = 'forged';
  chain.entries[0].hash = sha256Hex(`${'0'.repeat(64)}|0|forged`);
  chain.entries[0].signature = signMessage(attacker, chain.entries[0].hash);
  chain.head = chain.entries[0].hash;
  assert.equal(chain.verify(), false, 'signature must be checked against the chain owner');
});

// ---------------------------------------------------------------------------
// ledgers and atomic blocks
// ---------------------------------------------------------------------------

test('the ledger now uses SHA-256', () => {
  const l = new Ledger('t');
  l.append('a');
  assert.equal(l.head.length, 64);
  assert.equal(l.head, sha256Hex(`${'0'.repeat(64)}|0|a`));
});

test('a committed atomic block keeps every append', () => {
  const { value } = run(`
    let a = ledger("a")
    let b = ledger("b")
    atomic { a.append("x") b.append("x") }
    [a.len(), b.len()]
  `);
  assert.deepEqual(value, [1, 1]);
});

test('a failed atomic block rolls every ledger back', () => {
  const { value } = run(`
    let a = ledger("a")
    let b = ledger("b")
    a.append("before")
    attempt {
      atomic {
        a.append("x")
        b.append("x")
        assert(false, "leg failed")
      }
    } rescue e { }
    [a.len(), b.len(), a.verify(), b.verify()]
  `);
  assert.deepEqual(value, [1, 0, true, true]);
});

test('rollback restores the chain head, not just the count', () => {
  const { value } = run(`
    let a = ledger("a")
    a.append("one")
    let head_before = a.head
    attempt {
      atomic { a.append("two") assert(false, "no") }
    } rescue e { }
    [a.head == head_before, a.verify()]
  `);
  assert.deepEqual(value, [true, true]);
});

test('nested atomic blocks each manage their own ledgers', () => {
  const { value } = run(`
    let a = ledger("a")
    atomic {
      a.append("outer")
      attempt {
        atomic { a.append("inner") }
      } rescue e { }
    }
    a.len()
  `);
  assert.equal(value, 2);
});

test('a failing inner transaction leaves the outer one intact', () => {
  const { value } = run(`
    let a = ledger("a")
    atomic {
      a.append("outer")
      attempt {
        atomic { a.append("inner") assert(false, "no") }
      } rescue e { }
    }
    [a.len(), a.verify()]
  `);
  assert.deepEqual(value, [1, true]);
});

// ---------------------------------------------------------------------------
// secrets
// ---------------------------------------------------------------------------

test('a secret never renders its contents', () => {
  const { out } = run('secret { print(secret_of("hunter2")) }');
  assert.deepEqual(out, ['<secret 7 bytes>']);
});

test('a secret block shreds what it created', () => {
  const { value } = run(`
    var held = nil
    secret { held = secret_of("hunter2") }
    held.shredded
  `);
  assert.equal(value, true);
});

test('shredding zeroes the backing bytes', () => {
  const s = new Secret('hunter2');
  assert.ok(s.bytes.some((b) => b !== 0));
  s.shred();
  assert.ok(s.bytes.every((b) => b === 0));
  assert.throws(() => s.reveal(), /shredded/);
});

test('a secret block shreds even when the block fails', () => {
  const { value } = run(`
    var held = nil
    attempt {
      secret {
        held = secret_of("hunter2")
        assert(false, "boom")
      }
    } rescue e { }
    held.shredded
  `);
  assert.equal(value, true);
});

test('secrets created in a nested scope are still shredded', () => {
  const { value } = run(`
    var held = nil
    secret {
      if true {
        for i in range(1) { held = secret_of("nested") }
      }
    }
    held.shredded
  `);
  assert.equal(value, true);
});

test('a shredded secret cannot be used', () => {
  const e = fails(`
    var held = nil
    secret { held = secret_of("x") }
    held.digest()
  `);
  assert.equal(e.kind, 'SecretError');
});

test('random secrets need the crypto capability', () => {
  assert.equal(fails('random_secret(32)').kind, 'CapabilityError');
});
