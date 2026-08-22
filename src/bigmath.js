import { randomBytes } from 'node:crypto';

// Modular arithmetic over BigInt. Everything the crypto layer needs and
// nothing it does not.

export function modpow(base, exp, mod) {
  if (mod === 1n) return 0n;
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

export function egcd(a, b) {
  if (b === 0n) return { g: a, x: 1n, y: 0n };
  const { g, x, y } = egcd(b, a % b);
  return { g, x: y, y: x - (a / b) * y };
}

export function modinv(a, m) {
  const { g, x } = egcd(((a % m) + m) % m, m);
  if (g !== 1n) throw new Error('no modular inverse exists');
  return ((x % m) + m) % m;
}

export const gcd = (a, b) => (b === 0n ? a : gcd(b, a % b));
export const lcm = (a, b) => (a / gcd(a, b)) * b;

// Uniform random BigInt with exactly `bits` bits (top bit set).
export function randomBits(bits) {
  const bytes = Math.ceil(bits / 8);
  const buf = randomBytes(bytes);
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  const excess = BigInt(bytes * 8 - bits);
  n >>= excess;
  return n | (1n << BigInt(bits - 1));
}

// Uniform random BigInt in [0, n), by rejection.
//
// The obvious `randomBits(k) % n` is wrong twice over. Reducing a k-bit value
// mod n favours the low end whenever n is not a power of two -- and this
// `randomBits` also forces the top bit, so it never even produces the low half
// of its range before the reduction. Both biases land in exactly the places
// where uniformity is the security assumption: a Paillier blinding factor and a
// Schnorr nonce.
//
// Rejection has no bias and, sampling at the same bit length as n, retries with
// probability under 1/2 per draw.
export function randomBelow(n) {
  if (n <= 0n) throw new Error('randomBelow needs a positive bound');
  if (n === 1n) return 0n;
  const bits = bitLength(n);
  const bytes = Math.ceil(bits / 8);
  const excess = BigInt(bytes * 8 - bits);
  for (;;) {
    const buf = randomBytes(bytes);
    let v = 0n;
    for (const b of buf) v = (v << 8n) | BigInt(b);
    v >>= excess;
    if (v < n) return v;
  }
}

const SMALL_PRIMES = [
  2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n, 43n, 47n,
  53n, 59n, 61n, 67n, 71n, 73n, 79n, 83n, 89n, 97n, 101n, 103n, 107n, 109n, 113n,
];

// Miller-Rabin. 40 rounds puts the false-positive rate below 2^-80, which is
// the usual bar for key generation.
export function isProbablePrime(n, rounds = 40) {
  if (n < 2n) return false;
  for (const p of SMALL_PRIMES) {
    if (n === p) return true;
    if (n % p === 0n) return false;
  }

  let d = n - 1n;
  let r = 0n;
  while (d % 2n === 0n) { d /= 2n; r += 1n; }

  const bits = n.toString(2).length;
  for (let i = 0; i < rounds; i++) {
    let a;
    do { a = randomBits(bits) % (n - 3n); } while (a < 2n);
    let x = modpow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    let composite = true;
    for (let j = 1n; j < r; j++) {
      x = (x * x) % n;
      if (x === n - 1n) { composite = false; break; }
    }
    if (composite) return false;
  }
  return true;
}

export function randomPrime(bits) {
  if (bits < 16) throw new Error('primes below 16 bits are not useful');
  for (;;) {
    let candidate = randomBits(bits) | 1n;
    candidate |= 3n << BigInt(bits - 2);   // keep the product's bit length exact
    if (isProbablePrime(candidate)) return candidate;
  }
}

export function bigFromHex(hex) {
  return BigInt(`0x${hex.replace(/\s+/g, '')}`);
}

export function bitLength(n) {
  return n <= 0n ? 0 : n.toString(2).length;
}
