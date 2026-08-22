import {
  generateKeyPairSync, sign as nodeSign, verify as nodeVerify,
  createPublicKey, createHash, randomBytes,
  createPrivateKey,
} from 'node:crypto';

import { modpow, modinv, lcm, gcd, randomPrime, randomBits, randomBelow, bigFromHex, bitLength } from './bigmath.js';
import { NativeFunction, unwrap, stringify } from './values.js';
import { pedagError } from './errors.js';

export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

const nf = (name, arity, fn) => new NativeFunction(name, arity, fn);

// ---------------------------------------------------------------------------
// Paillier: additively homomorphic encryption
// ---------------------------------------------------------------------------
//
// Real, textbook Paillier. You can add two ciphertexts, and multiply a
// ciphertext by a plaintext, without the private key and without decrypting
// anything in between. You cannot multiply two ciphertexts -- Paillier does not
// provide that, and the runtime says so rather than pretending.

export class PaillierKey {
  constructor({ n, g, lambda = null, mu = null }) {
    this.n = n;
    this.nn = n * n;
    this.g = g;
    this.lambda = lambda;
    this.mu = mu;
  }
  get pedagType() { return 'paillier_key'; }
  get canDecrypt() { return this.lambda !== null; }
  publicOnly() { return new PaillierKey({ n: this.n, g: this.g }); }
  toString() { return `<paillier ${bitLength(this.n)}-bit ${this.canDecrypt ? 'keypair' : 'public key'}>`; }
  pedagMembers() {
    return {
      bits: bitLength(this.n),
      can_decrypt: this.canDecrypt,
      public: nf('public', 0, () => this.publicOnly()),
    };
  }
}

export class Cipher {
  constructor(value, key) {
    this.value = value;          // BigInt in Z*_{n^2}
    this.n = key.n;
    this.nn = key.nn;
    this.g = key.g;
  }
  get pedagType() { return 'cipher'; }
  sameGroup(other) { return this.n === other.n; }
  toString() { return `<cipher over ${bitLength(this.n)}-bit modulus>`; }
  pedagMembers() {
    return { bits: bitLength(this.n) };
  }
}

// Below this a Paillier modulus is not a weak key, it is a decorative one: 512
// bits factors on a laptop, and the whole guarantee is gone. Smaller keys are
// still reachable, because a demonstration that takes four seconds to start is
// a demonstration nobody runs -- but only through a function whose name says
// what it is, and the run records that it happened.
export const PAILLIER_MIN_BITS = 2048;

export function paillierKeygen(bits, { insecure = false } = {}) {
  if (!insecure && bits < PAILLIER_MIN_BITS) {
    throw new Error(
      `a ${bits}-bit Paillier modulus provides no security and factors on a laptop; `
      + `use at least ${PAILLIER_MIN_BITS} bits, or paillier_keygen_insecure(${bits}) `
      + 'if this is a demonstration and the run should say so');
  }
  if (bits < 256) throw new Error('a Paillier modulus below 256 bits is not meaningful');
  const half = Math.floor(bits / 2);
  let p;
  let q;
  let n;
  do {
    p = randomPrime(half);
    q = randomPrime(bits - half);
    n = p * q;
  } while (p === q || bitLength(n) !== bits);

  const lambda = lcm(p - 1n, q - 1n);
  const g = n + 1n;                       // the standard choice
  // With g = n+1, L(g^lambda mod n^2) == lambda mod n, so mu = lambda^-1 mod n.
  const mu = modinv(lambda % n, n);
  return new PaillierKey({ n, g, lambda, mu });
}

// Plaintexts live in Z_n. Negatives are represented in the upper half, and
// decoded back on decryption, so `encrypt(k, -5)` round-trips.
function encodePlain(m, n) {
  return m < 0n ? ((m % n) + n) % n : m % n;
}
function decodePlain(m, n) {
  return m > n / 2n ? m - n : m;
}

export function paillierEncrypt(key, m) {
  const plain = encodePlain(m, key.n);
  // The blinding factor has to be uniform in Z*_n: uniform, and a unit. It was
  // neither. `randomBits(k) % n` is biased twice over (see randomBelow), and
  // `r > 1` is not the same condition as `gcd(r, n) = 1` -- an r sharing a
  // factor with n makes the ciphertext unblindable and hands over the
  // factorisation to anyone who notices. It is vanishingly unlikely, and it is
  // one line to make impossible.
  let r;
  do { r = randomBelow(key.n); } while (r <= 1n || gcd(r, key.n) !== 1n);
  // (1 + n)^m == 1 + m*n (mod n^2), which is cheaper and exact for g = n+1.
  const gm = (1n + (plain * key.n) % key.nn) % key.nn;
  const rn = modpow(r, key.n, key.nn);
  return new Cipher((gm * rn) % key.nn, key);
}

export function paillierDecrypt(key, cipher) {
  if (!key.canDecrypt) throw new Error('this is a public key; it cannot decrypt');
  if (key.n !== cipher.n) throw new Error('this ciphertext belongs to a different key');
  const u = modpow(cipher.value, key.lambda, key.nn);
  const l = (u - 1n) / key.n;
  return decodePlain((l * key.mu) % key.n, key.n);
}

export const heAdd = (a, b) => new Cipher((a.value * b.value) % a.nn, a);
export const heAddPlain = (c, m) => new Cipher(
  (c.value * ((1n + (encodePlain(m, c.n) * c.n) % c.nn) % c.nn)) % c.nn, c);
export const heMulPlain = (c, k) => new Cipher(modpow(c.value, encodePlain(k, c.n), c.nn), c);

// ---------------------------------------------------------------------------
// Zero-knowledge: Schnorr proofs and Pedersen commitments
// ---------------------------------------------------------------------------
//
// RFC 3526 group 14: a 2048-bit safe prime p = 2q + 1. Working in the
// order-q subgroup of quadratic residues, generated by 4 = 2^2.
// tests/crypto.test.mjs re-derives that p and q are prime rather than trusting
// the constant.

const P_HEX = `
FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74
020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437
4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED
EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF05
98DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB
9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B
E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183
995497CEA956AE515D2261898FA051015728E5A8AACAA68FFFFFFFFFFFFFFFF`;

const P = bigFromHex(P_HEX);
const Q = (P - 1n) / 2n;
const G = 4n;
// A second generator whose discrete log with respect to G nobody knows:
// squaring an arbitrary hash lands in the same order-q subgroup.
const H = modpow(bigFromHex(sha256Hex('Pēdāg/pedersen/generator/v1')), 2n, P);

export const ZK = { P, Q, G, H };

// A public element of the ZK group. Wrapped so it has a name and a printable
// form inside the language rather than leaking a bare BigInt.
export class GroupElement {
  constructor(v) { this.v = v; }
  get pedagType() { return 'group_element'; }
  toString() { return `<group element ${this.v.toString(16).slice(0, 16)}...>`; }
  pedagMembers() { return { hex: this.v.toString(16) }; }
}

export class ZkProof {
  constructor(t, s) { this.t = t; this.s = s; }
  get pedagType() { return 'zk_proof'; }
  toString() { return `<zk proof t=${this.t.toString(16).slice(0, 12)}...>`; }
  pedagMembers() {
    return { t: this.t.toString(16), s: this.s.toString(16) };
  }
}

export class Commitment {
  constructor(c) { this.c = c; }
  get pedagType() { return 'commitment'; }
  toString() { return `<commitment ${this.c.toString(16).slice(0, 16)}...>`; }
  pedagMembers() { return { hex: this.c.toString(16) }; }
}

const challenge = (...parts) => bigFromHex(sha256Hex(parts.map((x) => x.toString(16)).join('|'))) % Q;

export const zkPublic = (x) => modpow(G, ((x % Q) + Q) % Q, P);

// Schnorr proof of knowledge of x such that y = G^x, made non-interactive by
// Fiat-Shamir. The verifier learns nothing about x beyond that the prover has it.
export function zkProve(x) {
  const secret = ((x % Q) + Q) % Q;
  const y = modpow(G, secret, P);
  // The nonce must be uniform over [1, Q) and secret. It was `randomBits(256) %
  // Q`, which is biased and 256 bits wide against a 2047-bit order -- Schnorr
  // is the signature scheme where a biased nonce is not a theoretical problem
  // but the standard way the private key is recovered.
  let k;
  do { k = randomBelow(Q); } while (k === 0n);
  const t = modpow(G, k, P);
  const c = challenge(G, y, t);
  const s = (k + c * secret) % Q;
  return new ZkProof(t, s);
}

// Membership in the order-q subgroup, which is where the soundness argument
// lives. An element of Z*_p that is not in it can sit in a small subgroup, and
// everything below assumes it does not.
const inSubgroup = (v) => v > 1n && v < P && modpow(v, Q, P) === 1n;

export function zkVerify(y, proof) {
  // Validate everything that arrived from outside before using it. The old
  // check was `y <= 1n || y >= P` and nothing at all about the proof: `t` was
  // used unvalidated, and `s` was used as an exponent without being reduced.
  // A verifier that accepts malformed input is not a verifier.
  if (!inSubgroup(y)) return false;
  if (!(proof instanceof ZkProof)) return false;
  if (!inSubgroup(proof.t)) return false;
  if (proof.s < 0n || proof.s >= Q) return false;

  const c = challenge(G, y, proof.t);
  return modpow(G, proof.s, P) === (proof.t * modpow(y, c, P)) % P;
}

export const pedersenCommit = (m, r) => new Commitment(
  (modpow(G, ((m % Q) + Q) % Q, P) * modpow(H, ((r % Q) + Q) % Q, P)) % P);

export const pedersenVerify = (commitment, m, r) =>
  inSubgroup(commitment.c) && pedersenCommit(m, r).c === commitment.c;

// ---------------------------------------------------------------------------
// Ed25519: machine-to-machine provenance
// ---------------------------------------------------------------------------

export class KeyPair {
  constructor(publicKey, privateKey = null) {
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    this.publicHex = publicKey.export({ type: 'spki', format: 'der' }).toString('hex');
  }
  get pedagType() { return 'keypair'; }
  get canSign() { return this.privateKey !== null; }
  toString() { return `<ed25519 ${this.canSign ? 'keypair' : 'public key'} ${this.publicHex.slice(-16)}>`; }
  pedagMembers() {
    return {
      public: this.publicHex,
      can_sign: this.canSign,
    };
  }
}

export function generateKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return new KeyPair(publicKey, privateKey);
}

// --- persistent identity -----------------------------------------------------
//
// A run signed with a key generated at startup proves the record was not edited
// afterwards. It cannot prove who produced it, because the key existed for the
// length of one process and nobody ever saw it before.
//
// An audit record that nobody can attribute is half an artifact, so a key can
// be kept. These read and write PKCS#8 / SPKI PEM -- the formats openssl, the
// JVM, Python's `cryptography` and every HSM already speak -- because evidence
// nobody else's tools can check is not evidence.

export function exportKeypair(kp) {
  if (!kp.canSign) throw new Error('this is a public key; there is no private half to export');
  return {
    privatePem: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicPem: kp.publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

export function loadKeypair(privatePem) {
  const privateKey = createPrivateKey({ key: privatePem, format: 'pem', type: 'pkcs8' });
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`this key is ${privateKey.asymmetricKeyType}, and signing here is ed25519`);
  }
  return new KeyPair(createPublicKey(privateKey), privateKey);
}

export function signMessage(kp, message) {
  if (!kp.canSign) throw new Error('this is a public key; it cannot sign');
  return nodeSign(null, Buffer.from(message, 'utf8'), kp.privateKey).toString('hex');
}

export function verifyMessage(publicHex, message, signatureHex) {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicHex, 'hex'), format: 'der', type: 'spki',
    });
    return nodeVerify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Signed lineage
// ---------------------------------------------------------------------------
//
// Each step in a value's history is hashed onto the previous step and signed.
// verify() re-derives every hash and checks every signature, so an entry cannot
// be inserted, removed, reordered or edited without detection.
//
// This proves who *asserted* each step and that the sequence is intact. It does
// not prove anything about hardware -- see README on feature #17.

export class LineageChain {
  constructor(name, keypair) {
    this.name = name;
    this.keypair = keypair;
    this.entries = [];
    this.head = '0'.repeat(64);
  }
  get pedagType() { return 'lineage'; }

  record(payload) {
    const text = stringify(unwrap(payload), 0);
    const index = this.entries.length;
    const hash = sha256Hex(`${this.head}|${index}|${text}`);
    const signature = signMessage(this.keypair, hash);
    this.entries.push({ index, payload: text, prev: this.head, hash, signature });
    this.head = hash;
    return hash;
  }

  verify() {
    let prev = '0'.repeat(64);
    for (const e of this.entries) {
      if (e.prev !== prev) return false;
      if (e.hash !== sha256Hex(`${prev}|${e.index}|${e.payload}`)) return false;
      if (!verifyMessage(this.keypair.publicHex, e.hash, e.signature)) return false;
      prev = e.hash;
    }
    return prev === this.head;
  }

  toString() { return `<lineage ${this.name} n=${this.entries.length} head=${this.head.slice(0, 8)}>`; }

  pedagMembers() {
    return {
      head: this.head,
      signer: this.keypair.publicHex,
      len: nf('len', 0, () => this.entries.length),
      record: nf('record', 1, (a) => this.record(a[0])),
      verify: nf('verify', 0, () => this.verify()),
      steps: nf('steps', 0, () => this.entries.map((e) => e.payload)),
    };
  }
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------
//
// A secret holds its bytes in a mutable buffer that shred() overwrites with
// zeroes, and a `secret { }` block shreds everything declared inside it on the
// way out -- including when the block exits by failing.
//
// What is real: the backing buffer is genuinely zeroed, and the value can never
// be printed. What is NOT real, and cannot be in a garbage-collected runtime:
// a guarantee that no copy of those bytes remains anywhere in physical RAM.

export class Secret {
  constructor(bytes) {
    this.bytes = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(String(bytes));
    this.shredded = false;
  }
  get pedagType() { return 'secret'; }

  shred() {
    this.bytes.fill(0);
    this.shredded = true;
    return true;
  }

  reveal() {
    if (this.shredded) throw new Error('this secret has been shredded');
    return new TextDecoder().decode(this.bytes);
  }

  digest() {
    if (this.shredded) throw new Error('this secret has been shredded');
    return sha256Hex(Buffer.from(this.bytes));
  }

  toString() { return `<secret ${this.bytes.length} bytes${this.shredded ? ', shredded' : ''}>`; }

  pedagMembers() {
    return {
      len: nf('len', 0, () => this.bytes.length),
      shredded: this.shredded,
      digest: nf('digest', 0, (_a, line) => {
        try { return this.digest(); } catch (e) { throw pedagError('SecretError', e.message, line); }
      }),
      shred: nf('shred', 0, () => this.shred()),
    };
  }
}

export function randomSecret(bytes) {
  return new Secret(new Uint8Array(randomBytes(bytes)));
}
