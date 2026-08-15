// A decision procedure for quantifier-free linear arithmetic.
//
// Sarvm has no dependencies, so it cannot pipe verification conditions to Z3 the
// way Dafny does. This is the solver it uses instead: exact rational
// arithmetic, Fourier-Motzkin elimination to decide a conjunction of linear
// constraints, and a small DPLL search over the boolean structure above them.
//
// It is far less capable than Z3 and makes no pretence otherwise. What matters
// is that it is *sound*: when it says a verification condition is proved, the
// condition holds for every input, with no bound and no sampling. When it
// cannot decide one, it says so rather than guessing.
//
// The soundness argument for the incomplete parts: anything the solver cannot
// interpret -- a non-linear product, a call, a field read -- becomes a fresh
// unconstrained variable. That *widens* the set of models under consideration.
// If the negated verification condition has no model even with that extra
// freedom, it has no model in reality either, so a proof is still a proof. The
// cost is the other direction: it will sometimes fail to prove something true.
// That is the correct direction for the error to point.

// ---------------------------------------------------------------------------
// Exact rationals
// ---------------------------------------------------------------------------

const gcd = (a, b) => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) { [x, y] = [y, x % y]; }
  return x;
};

export class Rat {
  constructor(n, d = 1n) {
    if (d === 0n) throw new Error('a rational with zero denominator');
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n, d) || 1n;
    this.n = n / g;
    this.d = d / g;
  }
  static of(value) {
    if (value instanceof Rat) return value;
    if (typeof value === 'bigint') return new Rat(value);
    if (typeof value === 'string') return Rat.ofDecimal(value);
    if (Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) {
      return new Rat(BigInt(value));
    }
    return Rat.ofDouble(value);
  }

  // The exact value of a decimal as written: 0.1 becomes one tenth. Right for
  // `dec`, which really is exact decimal arithmetic.
  static ofDecimal(text) {
    const [, sign, whole, frac = ''] = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(text)) ?? [];
    if (whole === undefined) throw new Error(`cannot make a rational from ${text}`);
    const scale = 10n ** BigInt(frac.length);
    const n = BigInt(whole) * scale + BigInt(frac || '0');
    return new Rat(sign === '-' ? -n : n, scale);
  }

  // The exact value of a double: 0.1 becomes 3602879701896397/36028797018963968,
  // because that is the number the machine will actually add.
  //
  // This matters more than it looks. A solver that reads `0.1` as one tenth
  // will happily prove `0.1 + 0.2 == 0.3`, which the runtime then falsifies --
  // a proof of something false. Modelling the literal the program really holds
  // keeps the verifier honest about `num`.
  static ofDouble(value) {
    if (!Number.isFinite(value)) throw new Error(`cannot make a rational from ${value}`);
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value);
    const hi = view.getUint32(0);
    const lo = view.getUint32(4);
    const sign = (hi >>> 31) ? -1n : 1n;
    const exponent = (hi >>> 20) & 0x7ff;
    const mantissa = ((BigInt(hi) & 0xfffffn) << 32n) | BigInt(lo);

    if (exponent === 0) return new Rat(sign * mantissa, 1n << 1074n);   // subnormal
    const full = (1n << 52n) | mantissa;
    const e = BigInt(exponent) - 1075n;
    return e >= 0n ? new Rat(sign * full * (1n << e)) : new Rat(sign * full, 1n << -e);
  }
  add(o) { return new Rat(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { return new Rat(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { return new Rat(this.n * o.n, this.d * o.d); }
  div(o) {
    if (o.n === 0n) throw new Error('rational division by zero');
    return new Rat(this.n * o.d, this.d * o.n);
  }
  neg() { return new Rat(-this.n, this.d); }
  get sign() { return this.n < 0n ? -1 : this.n > 0n ? 1 : 0; }
  isZero() { return this.n === 0n; }
  cmp(o) { const d = this.sub(o); return d.sign; }
  toString() { return this.d === 1n ? `${this.n}` : `${this.n}/${this.d}`; }
  toNumber() { return Number(this.n) / Number(this.d); }
}

export const ZERO = new Rat(0n);
export const ONE = new Rat(1n);

// ---------------------------------------------------------------------------
// Linear expressions: a map of variable -> coefficient, plus a constant
// ---------------------------------------------------------------------------

export class Linear {
  constructor(coeffs = new Map(), constant = ZERO) {
    this.coeffs = coeffs;
    this.constant = constant;
  }
  static constant(r) { return new Linear(new Map(), Rat.of(r)); }
  static variable(name) { return new Linear(new Map([[name, ONE]]), ZERO); }

  add(other) {
    const out = new Map(this.coeffs);
    for (const [v, c] of other.coeffs) {
      const sum = (out.get(v) ?? ZERO).add(c);
      if (sum.isZero()) out.delete(v); else out.set(v, sum);
    }
    return new Linear(out, this.constant.add(other.constant));
  }
  neg() {
    const out = new Map();
    for (const [v, c] of this.coeffs) out.set(v, c.neg());
    return new Linear(out, this.constant.neg());
  }
  sub(other) { return this.add(other.neg()); }
  scale(r) {
    const k = Rat.of(r);
    if (k.isZero()) return Linear.constant(0);
    const out = new Map();
    for (const [v, c] of this.coeffs) out.set(v, c.mul(k));
    return new Linear(out, this.constant.mul(k));
  }
  get isConstant() { return this.coeffs.size === 0; }
  variables() { return [...this.coeffs.keys()]; }

  toString() {
    const parts = [...this.coeffs].map(([v, c]) => `${c}*${v}`);
    if (!this.constant.isZero() || parts.length === 0) parts.push(this.constant.toString());
    return parts.join(' + ');
  }
}

// ---------------------------------------------------------------------------
// Atoms and formulas
// ---------------------------------------------------------------------------
//
// Every atom is normalised to `linear OP 0` with OP in {<=, <, =}. Negation
// stays inside the atom, so the DPLL layer only ever sees positive atoms with a
// truth value attached.

export const atom = (op, linear) => ({ k: 'atom', op, linear });

export const TRUE = { k: 'true' };
export const FALSE = { k: 'false' };
export const and = (...parts) => {
  const flat = parts.flatMap((p) => (p.k === 'and' ? p.parts : [p]));
  if (flat.some((p) => p.k === 'false')) return FALSE;
  const kept = flat.filter((p) => p.k !== 'true');
  if (kept.length === 0) return TRUE;
  return kept.length === 1 ? kept[0] : { k: 'and', parts: kept };
};
export const or = (...parts) => {
  const flat = parts.flatMap((p) => (p.k === 'or' ? p.parts : [p]));
  if (flat.some((p) => p.k === 'true')) return TRUE;
  const kept = flat.filter((p) => p.k !== 'false');
  if (kept.length === 0) return FALSE;
  return kept.length === 1 ? kept[0] : { k: 'or', parts: kept };
};
export const not = (f) => {
  if (f.k === 'true') return FALSE;
  if (f.k === 'false') return TRUE;
  if (f.k === 'not') return f.f;
  return { k: 'not', f };
};
export const implies = (a, b) => or(not(a), b);

// A boolean-valued term the solver cannot see into (a call, a field read).
// It gets a name and is treated as an independent boolean.
export const boolAtom = (key) => ({ k: 'bool', key });

// ---------------------------------------------------------------------------
// Fourier-Motzkin: is this conjunction of linear constraints satisfiable?
// ---------------------------------------------------------------------------
//
// Constraints arrive as { linear, strict } meaning `linear < 0` when strict and
// `linear <= 0` otherwise. Equalities are split into two inequalities before
// they get here.

export function satisfiable(constraints, budget = 4000) {
  let current = constraints.map((c) => ({ linear: c.linear, strict: c.strict }));
  const variables = new Set();
  for (const c of current) for (const v of c.linear.variables()) variables.add(v);

  for (const v of variables) {
    const lower = [];      // v >= ...
    const upper = [];      // v <= ...
    const rest = [];
    for (const c of current) {
      const coeff = c.linear.coeffs.get(v);
      if (!coeff) { rest.push(c); continue; }
      // Rewrite as v <= e or v >= e by dividing through by the coefficient.
      const withoutV = new Linear(new Map([...c.linear.coeffs].filter(([x]) => x !== v)), c.linear.constant);
      const bound = withoutV.scale(ONE.div(coeff).neg());
      (coeff.sign > 0 ? upper : lower).push({ bound, strict: c.strict });
    }
    if (lower.length * upper.length > budget) return 'unknown';

    const next = rest;
    for (const lo of lower) {
      for (const hi of upper) {
        // lo <= v <= hi means lo - hi <= 0.
        next.push({ linear: lo.bound.sub(hi.bound), strict: lo.strict || hi.strict });
      }
    }
    current = next;
    if (current.length > budget) return 'unknown';
  }

  // Only constants remain: a contradiction is a false numeric claim.
  for (const c of current) {
    if (!c.linear.isConstant) return 'unknown';
    const s = c.linear.constant.sign;
    if (c.strict ? s >= 0 : s > 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// DPLL over the boolean structure
// ---------------------------------------------------------------------------

function collectAtoms(f, out = []) {
  switch (f.k) {
    case 'atom':
    case 'bool':
      if (!out.some((a) => sameAtom(a, f))) out.push(f);
      return out;
    case 'not': return collectAtoms(f.f, out);
    case 'and':
    case 'or':
      for (const p of f.parts) collectAtoms(p, out);
      return out;
    default: return out;
  }
}

function sameAtom(a, b) {
  if (a.k !== b.k) return false;
  if (a.k === 'bool') return a.key === b.key;
  return a.op === b.op && a.linear.toString() === b.linear.toString();
}

function evaluate(f, assignment) {
  switch (f.k) {
    case 'true': return true;
    case 'false': return false;
    case 'atom':
    case 'bool': {
      const idx = assignment.atoms.findIndex((a) => sameAtom(a, f));
      return assignment.values[idx];
    }
    case 'not': {
      const inner = evaluate(f.f, assignment);
      return inner === undefined ? undefined : !inner;
    }
    case 'and': {
      let unknown = false;
      for (const p of f.parts) {
        const v = evaluate(p, assignment);
        if (v === false) return false;
        if (v === undefined) unknown = true;
      }
      return unknown ? undefined : true;
    }
    case 'or': {
      let unknown = false;
      for (const p of f.parts) {
        const v = evaluate(p, assignment);
        if (v === true) return true;
        if (v === undefined) unknown = true;
      }
      return unknown ? undefined : false;
    }
    default: return undefined;
  }
}

// Turn a truth assignment over arithmetic atoms into linear constraints.
//
// A *false* equality is a disjunction -- `e != 0` means `e < 0 or e > 0` -- so
// one assignment can yield several constraint sets. The caller tries each: the
// conjunction is satisfiable if any of them is.
function constraintSetsOf(atoms, values) {
  let sets = [[]];
  const disequalities = [];

  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i];
    if (a.k !== 'atom' || values[i] === undefined) continue;
    const positive = values[i];
    if (a.op === '<=') {
      const c = positive ? { linear: a.linear, strict: false } : { linear: a.linear.neg(), strict: true };
      for (const s of sets) s.push(c);
    } else if (a.op === '<') {
      const c = positive ? { linear: a.linear, strict: true } : { linear: a.linear.neg(), strict: false };
      for (const s of sets) s.push(c);
    } else if (a.op === '=') {
      if (positive) {
        for (const s of sets) {
          s.push({ linear: a.linear, strict: false });
          s.push({ linear: a.linear.neg(), strict: false });
        }
      } else {
        disequalities.push(a.linear);
      }
    }
  }

  // Each disequality doubles the number of sets, so cap the split rather than
  // exploring 2^n of them.
  if (disequalities.length > 6) return null;
  for (const linear of disequalities) {
    const next = [];
    for (const s of sets) {
      next.push([...s, { linear, strict: true }]);            // e < 0
      next.push([...s, { linear: linear.neg(), strict: true }]); // e > 0
    }
    sets = next;
  }
  return sets;
}

// Is this formula satisfiable? Used on the *negation* of a verification
// condition: unsatisfiable means the condition is proved.
export function isSatisfiable(formula, { maxAtoms = 24, budget = 4000 } = {}) {
  const atoms = collectAtoms(formula);
  if (atoms.length > maxAtoms) return 'unknown';

  const values = new Array(atoms.length).fill(undefined);
  const assignment = { atoms, values };

  const search = (index) => {
    const shape = evaluate(formula, assignment);
    if (shape === false) return false;
    if (index === atoms.length) {
      if (shape !== true) return false;
      const sets = constraintSetsOf(atoms, values);
      if (sets === null) return 'unknown';
      let sawUnknown = false;
      for (const constraints of sets) {
        const result = satisfiable(constraints, budget);
        if (result === true) return true;
        if (result === 'unknown') sawUnknown = true;
      }
      return sawUnknown ? 'unknown' : false;
    }
    for (const guess of [true, false]) {
      values[index] = guess;
      const result = search(index + 1);
      values[index] = undefined;
      if (result === true) return true;
      if (result === 'unknown') return 'unknown';
    }
    return false;
  };

  return search(0);
}

// The question a verifier actually asks.
export function isValid(formula, options) {
  const result = isSatisfiable(not(formula), options);
  if (result === 'unknown') return 'unknown';
  return result === false;
}
