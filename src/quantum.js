import { NativeFunction } from './values.js';
import { pedagError } from './errors.js';

// A state-vector quantum simulator: 2^n complex amplitudes, exact unitary
// evolution, and measurement that genuinely collapses the state.
//
// This is simulation, not quantum hardware. What it gives you is real:
// superposition, entanglement, interference, and correct measurement
// statistics, all in the same file as ordinary code. What it does not give you
// is speedup -- simulating n qubits costs 2^n classically, which is exactly why
// quantum hardware is interesting. The qubit ceiling below is that cost, made
// explicit instead of letting a program allocate its way into swap.

const MAX_QUBITS = 22;   // 2^22 complex amplitudes = 64 MB of Float64Array

const nf = (name, arity, fn) => new NativeFunction(name, arity, fn);

const RT2 = Math.SQRT1_2;

// Gates are [m00r, m00i, m01r, m01i, m10r, m10i, m11r, m11i].
export const GATES = {
  h: [RT2, 0, RT2, 0, RT2, 0, -RT2, 0],
  x: [0, 0, 1, 0, 1, 0, 0, 0],
  y: [0, 0, 0, -1, 0, 1, 0, 0],
  z: [1, 0, 0, 0, 0, 0, -1, 0],
  s: [1, 0, 0, 0, 0, 0, 0, 1],
  t: [1, 0, 0, 0, 0, 0, RT2, RT2],
};

export const rx = (theta) => {
  const c = Math.cos(theta / 2);
  const s = Math.sin(theta / 2);
  return [c, 0, 0, -s, 0, -s, c, 0];
};
export const ry = (theta) => {
  const c = Math.cos(theta / 2);
  const s = Math.sin(theta / 2);
  return [c, 0, -s, 0, s, 0, c, 0];
};
export const rz = (theta) => {
  const c = Math.cos(theta / 2);
  const s = Math.sin(theta / 2);
  return [c, -s, 0, 0, 0, 0, c, s];
};

export class QubitRegister {
  constructor(n) {
    if (!Number.isInteger(n) || n < 1) throw new Error('a register needs at least one qubit');
    if (n > MAX_QUBITS) {
      throw new Error(`${n} qubits needs ${2 ** n} amplitudes; this simulator stops at ${MAX_QUBITS}`);
    }
    this.n = n;
    this.size = 1 << n;
    this.re = new Float64Array(this.size);
    this.im = new Float64Array(this.size);
    this.re[0] = 1;                 // |00...0>
    this.ops = 0;
  }

  get pedagType() { return 'qubits'; }

  checkIndex(q, line) {
    if (!Number.isInteger(q) || q < 0 || q >= this.n) {
      throw pedagError('IndexError', `qubit ${q} is outside a register of ${this.n}`, line);
    }
  }

  apply(gate, target, line = null) {
    this.checkIndex(target, line);
    const [ar, ai, br, bi, cr, ci, dr, di] = gate;
    const bit = 1 << target;
    for (let i = 0; i < this.size; i++) {
      if (i & bit) continue;
      const j = i | bit;
      const x0r = this.re[i]; const x0i = this.im[i];
      const x1r = this.re[j]; const x1i = this.im[j];
      this.re[i] = ar * x0r - ai * x0i + br * x1r - bi * x1i;
      this.im[i] = ar * x0i + ai * x0r + br * x1i + bi * x1r;
      this.re[j] = cr * x0r - ci * x0i + dr * x1r - di * x1i;
      this.im[j] = cr * x0i + ci * x0r + dr * x1i + di * x1r;
    }
    this.ops += 1;
    return this;
  }

  applyControlled(gate, control, target, line = null) {
    this.checkIndex(control, line);
    this.checkIndex(target, line);
    if (control === target) {
      throw pedagError('ValueError', 'a controlled gate needs two different qubits', line);
    }
    const [ar, ai, br, bi, cr, ci, dr, di] = gate;
    const cbit = 1 << control;
    const tbit = 1 << target;
    for (let i = 0; i < this.size; i++) {
      if (i & tbit) continue;
      if (!(i & cbit)) continue;
      const j = i | tbit;
      const x0r = this.re[i]; const x0i = this.im[i];
      const x1r = this.re[j]; const x1i = this.im[j];
      this.re[i] = ar * x0r - ai * x0i + br * x1r - bi * x1i;
      this.im[i] = ar * x0i + ai * x0r + br * x1i + bi * x1r;
      this.re[j] = cr * x0r - ci * x0i + dr * x1r - di * x1i;
      this.im[j] = cr * x0i + ci * x0r + dr * x1i + di * x1r;
    }
    this.ops += 1;
    return this;
  }

  swap(a, b, line = null) {
    this.checkIndex(a, line);
    this.checkIndex(b, line);
    if (a === b) return this;
    const abit = 1 << a;
    const bbit = 1 << b;
    for (let i = 0; i < this.size; i++) {
      const hasA = (i & abit) !== 0;
      const hasB = (i & bbit) !== 0;
      if (hasA === hasB) continue;
      const j = (i ^ abit) ^ bbit;
      if (j <= i) continue;
      [this.re[i], this.re[j]] = [this.re[j], this.re[i]];
      [this.im[i], this.im[j]] = [this.im[j], this.im[i]];
    }
    this.ops += 1;
    return this;
  }

  probabilities() {
    const out = new Array(this.size);
    for (let i = 0; i < this.size; i++) out[i] = this.re[i] ** 2 + this.im[i] ** 2;
    return out;
  }

  // Probability that qubit q reads 1.
  probabilityOf(q, line = null) {
    this.checkIndex(q, line);
    const bit = 1 << q;
    let p = 0;
    for (let i = 0; i < this.size; i++) {
      if (i & bit) p += this.re[i] ** 2 + this.im[i] ** 2;
    }
    return p;
  }

  // Measure, and collapse. The draw comes from the interpreter's seeded RNG,
  // so a quantum program replays exactly like the rest of the language.
  measure(q, rng, line = null) {
    const p1 = this.probabilityOf(q, line);
    const outcome = rng.next() < p1 ? 1 : 0;
    const keep = outcome === 1 ? p1 : 1 - p1;
    const bit = 1 << q;
    if (keep <= 0) {
      // The measured branch has no amplitude; the other outcome is certain.
      return this.measureForced(q, outcome === 1 ? 0 : 1);
    }
    const scale = 1 / Math.sqrt(keep);
    for (let i = 0; i < this.size; i++) {
      const isOne = (i & bit) !== 0;
      if ((isOne ? 1 : 0) === outcome) {
        this.re[i] *= scale;
        this.im[i] *= scale;
      } else {
        this.re[i] = 0;
        this.im[i] = 0;
      }
    }
    return outcome;
  }

  measureForced(q, outcome) {
    const bit = 1 << q;
    let norm = 0;
    for (let i = 0; i < this.size; i++) {
      const isOne = (i & bit) !== 0;
      if ((isOne ? 1 : 0) !== outcome) { this.re[i] = 0; this.im[i] = 0; }
      else norm += this.re[i] ** 2 + this.im[i] ** 2;
    }
    if (norm > 0) {
      const scale = 1 / Math.sqrt(norm);
      for (let i = 0; i < this.size; i++) { this.re[i] *= scale; this.im[i] *= scale; }
    }
    return outcome;
  }

  measureAll(rng, line = null) {
    const bits = [];
    for (let q = 0; q < this.n; q++) bits.push(this.measure(q, rng, line));
    return bits;
  }

  // Total probability, which unitary evolution must preserve.
  norm() {
    let s = 0;
    for (let i = 0; i < this.size; i++) s += this.re[i] ** 2 + this.im[i] ** 2;
    return s;
  }

  toString() { return `<qubits n=${this.n} after ${this.ops} gates>`; }

  pedagMembers(interp) {
    return {
      n: this.n,
      gates: this.ops,
      norm: nf('norm', 0, () => this.norm()),
      probabilities: nf('probabilities', 0, () => this.probabilities()),
      probability_of: nf('probability_of', 1, (a, line) =>
        this.probabilityOf(Math.trunc(interp.asNumber(a[0], 'a qubit index', line)), line)),
      measure: nf('measure', 1, (a, line) =>
        this.measure(Math.trunc(interp.asNumber(a[0], 'a qubit index', line)), interp.rng, line)),
      measure_all: nf('measure_all', 0, (_a, line) => this.measureAll(interp.rng, line)),
    };
  }
}
