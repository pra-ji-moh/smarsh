import fs from 'node:fs';
import path from 'node:path';

import { Tensor } from './tensor.js';
import { pedagError, PedagError } from './errors.js';
import { bigFromHex } from './bigmath.js';
import {
  sha256Hex, PAILLIER_MIN_BITS,
  PaillierKey, Cipher, paillierKeygen, paillierEncrypt, paillierDecrypt,
  GroupElement, ZkProof, Commitment, zkPublic, zkProve, zkVerify, pedersenCommit, pedersenVerify,
  KeyPair, generateKeypair, signMessage, verifyMessage, LineageChain, Secret, randomSecret,
} from './crypto.js';
import { QubitRegister, GATES, rx, ry, rz } from './quantum.js';
import { LogicalClock, Stamp, Liquid } from './temporal.js';
import { AgentRef } from './agents.js';
import { topology, pressure, Arena, Weights } from './devices.js';
import { snapshot, restore } from './snapshot.js';
import { Schema, negotiate, adapt, migrate } from './schema.js';
import { loadForeign } from './ffi.js';
import { Decimal, expectDec } from './decimal.js';
import { Labelled, Label, Policy, Trust, requireAuthority } from './labels.js';
import { Grant, Revoker, expectGrant } from './grants.js';
import { PedagFunction } from './values.js';
import {
  NativeFunction, Tainted, ContextWindow, Ledger,
  unwrap, retaint, stringify, typeName, withArticle, truthy, countTokens,
} from './values.js';

const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(4))));

// A compact, deterministic descriptor of a live value: shape, magnitude, size,
// provenance. This is structural distillation -- it never calls a model, so it
// never invents anything. It is what you hand to a model or a log when the full
// state is too big to carry.
export function distill(v) {
  const u = unwrap(v);
  const lab = v instanceof Tainted ? `#{${[...v.labels].join(',')}}` : '';
  if (u === null || u === undefined) return 'nil';
  if (typeof u === 'boolean') return `bool(${u})${lab}`;
  if (typeof u === 'number') return `num(${fmt(u)})${lab}`;
  if (typeof u === 'string') {
    const head = u.length > 24 ? `${u.slice(0, 24)}...` : u;
    return `str(len=${u.length}, tokens=${countTokens(u)}, "${head.replace(/\n/g, '\\n')}")${lab}`;
  }
  if (u instanceof Tensor) {
    const shape = u.rank === 0 ? 'scalar' : u.shape.join('x');
    return `tensor[${shape}] mean=${fmt(u.mean())} min=${fmt(u.min())} max=${fmt(u.max())} norm=${fmt(u.norm())}${lab}`;
  }
  if (Array.isArray(u)) {
    const kinds = [...new Set(u.map((x) => typeName(unwrap(x))))];
    return `list[${u.length}]${kinds.length ? ` of ${kinds.join('|')}` : ''}${lab}`;
  }
  if (u instanceof Map) {
    const keys = [...u.keys()];
    const shown = keys.slice(0, 6).join(', ');
    return `map{${u.size} keys: ${shown}${keys.length > 6 ? ', ...' : ''}}${lab}`;
  }
  if (u instanceof ContextWindow) {
    return `context(${u.tokens}/${u.budget} tokens, ${u.length} entries, ${u.evicted} evicted)`;
  }
  if (u instanceof Ledger) return `ledger(${u.name}, n=${u.length}, head=${u.head.slice(0, 12)})`;
  return `${typeName(u)}${lab}`;
}

export function installBuiltins(interp) {
  const def = (name, arity, fn, opts = {}) => {
    const nf = new NativeFunction(name, arity, fn, opts.needs ?? []);
    if (opts.transparent) nf.transparent = true;
    interp.prelude.declare(name, nf, false, null);
  };

  const num = (v, what, line) => interp.asNumber(unwrap(v), what, line);

  // --- output and basics ---------------------------------------------------

  def('print', -1, (args) => {
    interp.out(args.map((a) => stringify(a, 0)).join(' '));
    return null;
  });

  def('str', 1, (a) => retaint(stringify(unwrap(a[0]), 0), a[0]));

  def('num', 1, (a, line) => {
    const u = unwrap(a[0]);
    if (typeof u === 'number') return a[0];
    if (typeof u === 'boolean') return retaint(u ? 1 : 0, a[0]);
    if (typeof u === 'string') {
      const n = Number(u.trim());
      if (u.trim() === '' || Number.isNaN(n)) {
        throw pedagError('ValueError', `cannot read '${u}' as a num`, line);
      }
      return retaint(n, a[0]);
    }
    throw pedagError('TypeError', `cannot convert ${withArticle(u)} to a num`, line);
  });

  def('len', 1, (a, line) => {
    const u = unwrap(a[0]);
    if (typeof u === 'string' || Array.isArray(u)) return u.length;
    if (u instanceof Map) return u.size;
    if (u instanceof Tensor) return u.size;
    if (u instanceof ContextWindow) return u.length;
    if (u instanceof Ledger) return u.length;
    throw pedagError('TypeError', `${withArticle(u)} has no length`, line);
  });

  def('type', 1, (a) => typeName(unwrap(a[0])), { transparent: true });

  def('assert', -1, (a, line) => {
    if (a.length < 1 || a.length > 2) {
      throw pedagError('ArityError', `assert takes 1 or 2 arguments, got ${a.length}`, line);
    }
    if (!truthy(a[0])) {
      const msg = a.length === 2 ? stringify(unwrap(a[1]), 0) : 'assertion failed';
      throw pedagError('AssertError', msg, line);
    }
    return true;
  });

  def('range', -1, (a, line) => {
    if (a.length < 1 || a.length > 3) {
      throw pedagError('ArityError', `range takes 1 to 3 arguments, got ${a.length}`, line);
    }
    const start = a.length === 1 ? 0 : num(a[0], 'a range start', line);
    const stop = a.length === 1 ? num(a[0], 'a range end', line) : num(a[1], 'a range end', line);
    const step = a.length === 3 ? num(a[2], 'a range step', line) : 1;
    if (step === 0) throw pedagError('ValueError', 'range step cannot be 0', line);
    const out = [];
    if (step > 0) for (let i = start; i < stop; i += step) out.push(i);
    else for (let i = start; i > stop; i += step) out.push(i);
    return out;
  });

  // --- math ----------------------------------------------------------------

  const math1 = {
    abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round,
    // `signum`, not `sign` -- `sign` belongs to the cryptographic signer below.
    exp: Math.exp, sin: Math.sin, cos: Math.cos, tan: Math.tan, signum: Math.sign,
  };
  for (const [name, fn] of Object.entries(math1)) {
    def(name, 1, (a, line) => {
      const u = unwrap(a[0]);
      if (u instanceof Tensor) return retaint(u.map(fn), a[0]);
      return retaint(fn(num(a[0], `the argument to ${name}`, line)), a[0]);
    });
  }

  def('sqrt', 1, (a, line) => {
    const u = unwrap(a[0]);
    const check = (x) => {
      if (x < 0) throw pedagError('ValueError', `sqrt of a negative number (${fmt(x)})`, line);
      return Math.sqrt(x);
    };
    if (u instanceof Tensor) return retaint(u.map(check), a[0]);
    return retaint(check(num(a[0], 'the argument to sqrt', line)), a[0]);
  });

  def('log', -1, (a, line) => {
    const x = num(a[0], 'the argument to log', line);
    if (x <= 0) throw pedagError('ValueError', `log of ${fmt(x)}, which is not positive`, line);
    const base = a.length > 1 ? num(a[1], 'a log base', line) : Math.E;
    return retaint(a.length > 1 ? Math.log(x) / Math.log(base) : Math.log(x), a[0]);
  });

  const spread = (args, line) => {
    const vals = [];
    for (const arg of args) {
      const u = unwrap(arg);
      if (Array.isArray(u)) vals.push(...u.map((x) => interp.asNumber(unwrap(x), 'a list element', line)));
      else if (u instanceof Tensor) vals.push(...u.data);
      else vals.push(interp.asNumber(u, 'an argument', line));
    }
    return vals;
  };

  def('min', -1, (a, line) => {
    const v = spread(a, line);
    if (v.length === 0) throw pedagError('ValueError', 'min of nothing', line);
    return Math.min(...v);
  });
  def('max', -1, (a, line) => {
    const v = spread(a, line);
    if (v.length === 0) throw pedagError('ValueError', 'max of nothing', line);
    return Math.max(...v);
  });
  def('clamp', 3, (a, line) => {
    const x = num(a[0], 'the value to clamp', line);
    const lo = num(a[1], 'a clamp lower bound', line);
    const hi = num(a[2], 'a clamp upper bound', line);
    if (lo > hi) throw pedagError('ValueError', `clamp bounds are inverted (${fmt(lo)} > ${fmt(hi)})`, line);
    return retaint(Math.min(hi, Math.max(lo, x)), a[0]);
  });

  // --- seeded randomness ---------------------------------------------------

  def('random', 0, () => interp.rng.next());

  def('randint', 2, (a, line) => {
    const lo = Math.trunc(num(a[0], 'a randint lower bound', line));
    const hi = Math.trunc(num(a[1], 'a randint upper bound', line));
    if (hi < lo) throw pedagError('ValueError', `randint bounds are inverted (${lo} > ${hi})`, line);
    return lo + Math.floor(interp.rng.next() * (hi - lo + 1));
  });

  def('sample', 1, (a, line) => {
    const u = unwrap(a[0]);
    if (!Array.isArray(u)) throw pedagError('TypeError', `sample needs a list, got ${typeName(u)}`, line);
    if (u.length === 0) throw pedagError('ValueError', 'sample from an empty list', line);
    return u[Math.floor(interp.rng.next() * u.length)];
  });

  def('shuffle', 1, (a, line) => {
    const u = unwrap(a[0]);
    if (!Array.isArray(u)) throw pedagError('TypeError', `shuffle needs a list, got ${typeName(u)}`, line);
    const out = [...u];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(interp.rng.next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  });

  // --- tensor construction -------------------------------------------------

  def('zeros', 1, (a, line) => Tensor.filled(interp.toShape(unwrap(a[0]), line), 0));
  def('ones', 1, (a, line) => Tensor.filled(interp.toShape(unwrap(a[0]), line), 1));
  def('full', 2, (a, line) => Tensor.filled(interp.toShape(unwrap(a[0]), line), num(a[1], 'a fill value', line)));

  def('eye', 1, (a, line) => {
    const n = Math.trunc(num(a[0], 'the size of eye', line));
    if (n < 0) throw pedagError('ValueError', `eye needs a non-negative size, got ${n}`, line);
    const t = Tensor.filled([n, n], 0);
    for (let i = 0; i < n; i++) t.data[i * n + i] = 1;
    return t;
  });

  def('arange', 1, (a, line) => {
    const n = Math.trunc(num(a[0], 'the size of arange', line));
    if (n < 0) throw pedagError('ValueError', `arange needs a non-negative size, got ${n}`, line);
    const d = new Float64Array(n);
    for (let i = 0; i < n; i++) d[i] = i;
    return new Tensor(d, [n]);
  });

  def('randn', 1, (a, line) => {
    const shape = interp.toShape(unwrap(a[0]), line);
    const t = Tensor.filled(shape, 0);
    for (let i = 0; i < t.data.length; i++) t.data[i] = interp.rng.normal();
    return t;
  });

  // --- tensor operations ---------------------------------------------------

  def('dot', 2, (a, line) => {
    const x = interp.toTensor(unwrap(a[0]), line);
    const y = interp.toTensor(unwrap(a[1]), line);
    if (x.rank !== 1 || y.rank !== 1) {
      throw pedagError('ShapeError', 'dot needs two rank-1 tensors', line);
    }
    if (x.size !== y.size) {
      throw pedagError('ShapeError', `dot needs equal lengths, got ${x.size} and ${y.size}`, line);
    }
    let s = 0;
    for (let i = 0; i < x.size; i++) s += x.data[i] * y.data[i];
    return retaint(s, a[0], a[1]);
  });

  def('cosine', 2, (a, line) => {
    const x = interp.toTensor(unwrap(a[0]), line);
    const y = interp.toTensor(unwrap(a[1]), line);
    if (x.size !== y.size) {
      throw pedagError('ShapeError', `cosine needs equal lengths, got ${x.size} and ${y.size}`, line);
    }
    const nx = x.norm();
    const ny = y.norm();
    if (nx === 0 || ny === 0) throw pedagError('ValueError', 'cosine of a zero vector is undefined', line);
    let s = 0;
    for (let i = 0; i < x.size; i++) s += x.data[i] * y.data[i];
    return retaint(s / (nx * ny), a[0], a[1]);
  });

  def('relu', 1, (a, line) => retaint(interp.toTensor(unwrap(a[0]), line).map((x) => Math.max(0, x)), a[0]));
  def('sigmoid', 1, (a, line) => retaint(interp.toTensor(unwrap(a[0]), line).map((x) => 1 / (1 + Math.exp(-x))), a[0]));
  def('tanh', 1, (a, line) => retaint(interp.toTensor(unwrap(a[0]), line).map(Math.tanh), a[0]));

  def('softmax', 1, (a, line) => {
    const t = interp.toTensor(unwrap(a[0]), line);
    if (t.size === 0) throw pedagError('ValueError', 'softmax of an empty tensor', line);
    const m = t.max();
    const ex = t.map((x) => Math.exp(x - m));
    const total = ex.sum();
    return retaint(ex.map((x) => x / total), a[0]);
  });

  def('argmax', 1, (a, line) => {
    const t = interp.toTensor(unwrap(a[0]), line);
    if (t.size === 0) throw pedagError('ValueError', 'argmax of an empty tensor', line);
    let best = 0;
    for (let i = 1; i < t.size; i++) if (t.data[i] > t.data[best]) best = i;
    return best;
  });

  // --- provenance ----------------------------------------------------------

  def('untrusted', 1, (a) => new Tainted(a[0], ['untrusted']), { transparent: true });
  def('ungrounded', 1, (a) => new Tainted(a[0], ['ungrounded']), { transparent: true });

  def('restrict', 2, (a, line) => {
    const region = unwrap(a[1]);
    if (typeof region !== 'string') {
      throw pedagError('TypeError', `restrict needs a region name string, got ${typeName(region)}`, line);
    }
    return new Tainted(a[0], [`region:${region}`]);
  }, { transparent: true });

  def('labels', 1, (a) => (a[0] instanceof Tainted ? [...a[0].labels] : []), { transparent: true });

  // --- the decentralized label model ---------------------------------------

  def('classify', -1, (a, line) => {
    if (a.length < 2 || a.length > 3) {
      throw pedagError('ArityError', 'classify takes a value, an owner, and optionally a list of readers', line);
    }
    const owner = stringify(unwrap(a[1]), 0);
    const readers = a.length === 3
      ? (unwrap(a[2]) ?? []).map((r) => stringify(unwrap(r), 0))
      : [];
    if (!Array.isArray(unwrap(a[2] ?? []))) {
      throw pedagError('TypeError', 'the readers must be a list of principal names', line);
    }
    return new Labelled(a[0], new Label([new Policy(owner, readers)]));
  }, { transparent: true });

  def('policy_of', 1, (a) => (a[0] instanceof Labelled ? a[0].label.toString() : '{}'), { transparent: true });
  def('owners_of', 1, (a) => (a[0] instanceof Labelled ? a[0].label.owners : []), { transparent: true });

  def('readers_of', 1, (a) => {
    if (!(a[0] instanceof Labelled)) return [];
    const readers = a[0].label.effectiveReaders();
    return readers === null ? [] : [...readers].sort();
  }, { transparent: true });

  def('can_read', 2, (a) => {
    const who = stringify(unwrap(a[1]), 0);
    return a[0] instanceof Labelled ? a[0].label.canRead(who) : true;
  }, { transparent: true });

  // Removing one owner's policy, which only that owner may do. This is the
  // whole difference from a blanket trust(): authority is per-principal, so
  // holding alice's authority does not let you release bob's data.
  def('declassify', 3, (a, line) => {
    const owner = stringify(unwrap(a[1]), 0);
    const reason = unwrap(a[2]);
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw pedagError('ValueError', 'declassify needs a non-empty reason', line);
    }
    requireAuthority(interp, owner, `declassifying \`${owner}\`'s data`, line);

    if (!(a[0] instanceof Labelled)) return a[0];
    if (!a[0].label.policies.has(owner)) {
      throw pedagError('AuthorityError',
        `this value carries no policy owned by \`${owner}\``, line)
        .note(`its label is ${a[0].label}`);
    }
    interp.trace.declassifications.push({
      line, owner, reason, before: a[0].label.toString(),
    });
    const remaining = a[0].label.without(owner);
    return remaining.isEmpty ? a[0].value : new Labelled(a[0].value, remaining);
  }, { transparent: true });

  // --- the integrity half ---------------------------------------------------

  // The dual of classify, and the dual of the rule above it. Adding a vouch is
  // the dangerous direction on this half -- it is how untrusted data becomes
  // trusted -- so it is the one that costs authority. Alice can put alice's
  // name behind a value. Nobody else can.
  def('endorse', 3, (a, line) => {
    const owner = stringify(unwrap(a[1]), 0);
    const reason = unwrap(a[2]);
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw pedagError('ValueError', 'endorse needs a non-empty reason', line);
    }
    requireAuthority(interp, owner, `vouching for a value as \`${owner}\``, line);
    const before = a[0] instanceof Labelled ? a[0].label.toString() : '{}';
    interp.trace.endorsements.push({ line, owner, reason, before });
    return new Labelled(a[0], new Label([], [new Trust(owner, [])]));
  }, { transparent: true });

  // Withdrawing one. No authority needed: it can only make a program more
  // careful. Recorded anyway, because a reviewer reading the manifest wants to
  // know a vouch was given up on purpose rather than lost to composition.
  def('retract', 3, (a, line) => {
    const owner = stringify(unwrap(a[1]), 0);
    const reason = unwrap(a[2]);
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw pedagError('ValueError', 'retract needs a non-empty reason', line);
    }
    if (!(a[0] instanceof Labelled)) return a[0];
    interp.trace.endorsements.push({
      line, owner, reason, before: a[0].label.toString(), withdrawn: true,
    });
    const remaining = a[0].label.unvouched(owner);
    return remaining.isEmpty ? a[0].value : new Labelled(a[0].value, remaining);
  }, { transparent: true });

  def('vouchers_of', 1, (a) => (a[0] instanceof Labelled ? a[0].label.vouchers : []),
    { transparent: true });

  def('writers_of', 1, (a) => {
    if (!(a[0] instanceof Labelled)) return [];
    const writers = a[0].label.writers();
    return writers === null ? [] : [...writers].sort();
  }, { transparent: true });

  def('trusted_by', 2, (a) => {
    const who = stringify(unwrap(a[1]), 0);
    return a[0] instanceof Labelled ? a[0].label.trustedBy(who) : false;
  }, { transparent: true });

  def('acting_for', 0, () => [...interp.authority].sort());

  // --- delegable capabilities ----------------------------------------------

  // You can only make a grant for something you already hold. This is the rule
  // that stops a grant from manufacturing authority out of nothing.
  def('grant', -1, (a, line) => {
    if (a.length < 1 || a.length > 2) {
      throw pedagError('ArityError', 'grant takes a capability name, and optionally a note', line);
    }
    const capability = stringify(unwrap(a[0]), 0);
    if (!interp.caps.has(capability)) {
      const held = interp.caps.size ? [...interp.caps].sort().join(', ') : 'nothing';
      throw pedagError('CapabilityError',
        `cannot grant \`${capability}\`, which this frame does not hold; it holds ${held}`, line)
        .note('a grant delegates authority you have, it does not create any');
    }
    return new Grant(capability, { label: a.length === 2 ? stringify(unwrap(a[1]), 0) : null });
  });

  // The caretaker: one value to hand out, one to keep.
  def('caretaker', 1, (a, line) => {
    const grant = expectGrant(unwrap(a[0]), 'caretaker needs a grant', line);
    const child = grant.attenuate({});
    const out = new Map();
    out.set('grant', child);
    out.set('revoker', new Revoker(child));
    return out;
  });

  def('revoke', 1, (a, line) => {
    const r = unwrap(a[0]);
    if (!r || r.pedagType !== 'revoker') {
      throw pedagError('TypeError', 'revoke needs a revoker, the half of a caretaker you kept', line);
    }
    const first = r.revoke();
    if (first) interp.trace.revocations.push({ line, capability: r.capability });
    return first;
  });

  def('is_live', 1, (a, line) =>
    expectGrant(unwrap(a[0]), 'is_live needs a grant', line).isLive(interp.logicalTime));
  def('is_tainted', 1, (a) => a[0] instanceof Tainted, { transparent: true });

  // The only way to remove a label. It demands a stated reason and records the
  // laundering in the run trace, so "who decided this was safe, and why" is
  // always answerable after the fact.
  def('trust', 2, (a, line) => {
    const reason = unwrap(a[1]);
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw pedagError('ValueError', 'trust needs a non-empty reason string', line);
    }
    const before = a[0] instanceof Tainted ? [...a[0].labels] : [];
    interp.trace.laundered.push({ line, reason, cleared: before });
    return unwrap(a[0]);
  }, { transparent: true });

  // --- memory and accounting -----------------------------------------------

  def('tokens', 1, (a) => {
    const u = unwrap(a[0]);
    if (u instanceof ContextWindow) return u.tokens;
    return countTokens(stringify(u, 0));
  }, { transparent: true });

  def('context', -1, (a, line) => {
    if (a.length < 1 || a.length > 2) {
      throw pedagError('ArityError', `context takes 1 or 2 arguments, got ${a.length}`, line);
    }
    const budget = Math.trunc(num(a[0], 'a context budget', line));
    if (budget <= 0) throw pedagError('ValueError', `a context budget must be positive, got ${budget}`, line);
    const policy = a.length === 2 ? String(unwrap(a[1])) : 'fifo';
    if (!['fifo', 'none'].includes(policy)) {
      throw pedagError('ValueError', `unknown eviction policy '${policy}' (known: fifo, none)`, line);
    }
    return new ContextWindow(budget, policy);
  });

  def('distill', 1, (a) => distill(a[0]), { transparent: true });

  def('ledger', 1, (a) => new Ledger(stringify(unwrap(a[0]), 0)));

  def('caps', 0, () => [...interp.caps].sort());

  // --- capability-gated effects --------------------------------------------

  const resolveInside = (p, line) => {
    const full = path.resolve(interp.cwd, String(p));
    const root = path.resolve(interp.cwd);
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw pedagError('CapabilityError',
        `the 'fs' capability is scoped to ${root}; '${p}' resolves outside it`, line);
    }
    return full;
  };

  def('read', 1, (a, line) => {
    const p = resolveInside(unwrap(a[0]), line);
    try {
      return fs.readFileSync(p, 'utf8');
    } catch (e) {
      throw pedagError('IOError', `cannot read '${unwrap(a[0])}': ${e.code ?? e.message}`, line);
    }
  }, { needs: ['fs'] });

  def('write', 2, (a, line) => {
    const p = resolveInside(unwrap(a[0]), line);
    try {
      fs.writeFileSync(p, stringify(unwrap(a[1]), 0), 'utf8');
      return true;
    } catch (e) {
      throw pedagError('IOError', `cannot write '${unwrap(a[0])}': ${e.code ?? e.message}`, line);
    }
  }, { needs: ['fs'] });

  // Reading the clock breaks reproducibility, so it is a capability like any
  // other effect -- a program without it always replays identically.
  def('now', 0, () => Date.now(), { needs: ['clock'] });

  installCrypto(interp, def, num);
  installQuantum(interp, def, num);
  installTemporal(interp, def, num);
  installAgents(interp, def, num);
  installDevices(interp, def, num);
  installLifecycle(interp, def, num);
  installSimulation(interp, def, num);
  installSchemas(interp, def, num);
}

// ---------------------------------------------------------------------------
// Discrete-event simulation
// ---------------------------------------------------------------------------
//
// One queue, ordered by logical time, so a market open at t=0 and a fill at
// t=0.003 sit in the same block without either needing to know the other's
// timescale. Ties are broken by insertion order, so a run is reproducible.

function installSimulation(interp, def, num) {
  def('schedule', 2, (a, line) => {
    const delay = num(a[0], 'a delay', line);
    if (delay < 0) throw pedagError('ValueError', 'events cannot be scheduled into the past', line);
    const action = unwrap(a[1]);
    if (!(action instanceof PedagFunction) && !(action instanceof NativeFunction)) {
      throw pedagError('TypeError', `schedule needs a function to run, got ${typeName(action)}`, line);
    }
    const at = interp.logicalTime + delay;
    interp.events.push({ at, seq: interp.eventSeq++, action });
    return at;
  });

  def('simulate', -1, (a, line) => {
    const until = a.length ? num(a[0], 'an end time', line) : Infinity;
    let fired = 0;
    for (;;) {
      let best = -1;
      for (let i = 0; i < interp.events.length; i++) {
        const e = interp.events[i];
        if (e.at > until) continue;
        if (best === -1) { best = i; continue; }
        const b = interp.events[best];
        if (e.at < b.at || (e.at === b.at && e.seq < b.seq)) best = i;
      }
      if (best === -1) break;
      const event = interp.events.splice(best, 1)[0];
      // Time moves to the event, never backwards.
      interp.logicalTime = Math.max(interp.logicalTime, event.at);
      interp.callValue(event.action, [], line, 'a scheduled event');
      fired += 1;
      if (fired > 1000000) {
        throw pedagError('ValueError', 'the simulation scheduled more than a million events', line);
      }
    }
    if (until !== Infinity) interp.logicalTime = Math.max(interp.logicalTime, until);
    return fired;
  });

  def('scheduled', 0, () => interp.events.length);

  // A disclosed cost model. These are relative weights, not watts: nothing here
  // reads a power rail. What it does give you is a consistent, comparable score
  // for "did that change make the program do more work", which is the question
  // an energy budget is usually a proxy for anyway.
  def('energy', 0, () => {
    const counts = {
      steps: interp.steps,
      calls: interp.trace.calls,
      tensorOps: interp.cost.tensorOps,
      dispatches: [...interp.devices.backends.values()].reduce((n, b) => n + (b.dispatched ?? 0), 0),
      tokens: interp.cost.tokens,
    };
    // Disclosed weights. A thread dispatch is expensive because waking a core
    // costs far more than the arithmetic it then does; tensor element-ops are
    // cheap individually and matter only in bulk.
    const weights = { steps: 1, calls: 8, tensorOps: 0.05, dispatches: 5000, tokens: 2 };
    const m = new Map();
    let score = 0;
    for (const [k, count] of Object.entries(counts)) {
      m.set(k, count);
      score += count * weights[k];
    }
    m.set('score', Math.round(score));
    m.set('units', 'relative work units, not watts -- see README');
    return m;
  });
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

function installSchemas(interp, def, num) {
  const asSchema = (v, what, line) => {
    const u = unwrap(v);
    if (!(u instanceof Schema)) throw pedagError('TypeError', `${what}, got ${typeName(u)}`, line);
    return u;
  };

  // schema("Order", { "id": "num", "side": "str", "note": "str?" })
  // A trailing ? marks a field optional; "kind=default" gives it a fallback.
  def('schema', 2, (a, line) => {
    const name = stringify(unwrap(a[0]), 0);
    const spec = unwrap(a[1]);
    if (!(spec instanceof Map)) {
      throw pedagError('TypeError', `a schema body is a map of field to kind, got ${typeName(spec)}`, line);
    }
    const fields = new Map();
    for (const [key, rawKind] of spec) {
      let text = stringify(unwrap(rawKind), 0);
      let fallback;
      const eq = text.indexOf('=');
      if (eq !== -1) {
        const literal = text.slice(eq + 1);
        text = text.slice(0, eq);
        fallback = literal === 'nil' ? null : (Number.isNaN(Number(literal)) ? literal : Number(literal));
      }
      const optional = text.endsWith('?');
      if (optional) text = text.slice(0, -1);
      const known = ['num', 'str', 'bool', 'list', 'map', 'tensor', 'any'];
      if (!known.includes(text)) {
        throw pedagError('SchemaError',
          `unknown kind '${text}' for field '${key}'; known kinds are ${known.join(', ')}`, line);
      }
      fields.set(key, { kind: text, required: !optional && fallback === undefined, fallback });
    }
    return new Schema(name, fields);
  });

  def('negotiate', 2, (a, line) => {
    const from = asSchema(a[0], 'negotiate needs a schema first', line);
    const to = asSchema(a[1], 'negotiate needs a schema second', line);
    const r = negotiate(from, to);
    const m = new Map();
    m.set('compatible', r.compatible);
    m.set('added', r.added);
    m.set('dropped', r.dropped);
    m.set('retyped', r.retyped);
    m.set('blocking', r.blocking);
    return m;
  });

  def('adapt', 3, (a, line) =>
    adapt(a[0], asSchema(a[1], 'adapt needs the source schema second', line),
      asSchema(a[2], 'adapt needs the target schema third', line), line));

  // Re-shape records already in memory, in place, without a restart. Every
  // record goes through the same path a wire negotiation would, so a migration
  // cannot do anything a negotiation would have refused.
  def('migrate', 3, (a, line) => {
    const records = unwrap(a[0]);
    if (!Array.isArray(records)) {
      throw pedagError('TypeError', `migrate needs a list of records, got ${typeName(records)}`, line);
    }
    const r = migrate(records,
      asSchema(a[1], 'migrate needs the source schema second', line),
      asSchema(a[2], 'migrate needs the target schema third', line), line);
    const m = new Map();
    m.set('records', r.records);
    m.set('count', r.records.length);
    m.set('nanos', r.nanos);
    return m;
  });
}

// ---------------------------------------------------------------------------
// Self-modification, migration and growth
// ---------------------------------------------------------------------------

function installLifecycle(interp, def, num) {
  def('rollback', 1, (a, line) => interp.rollback(stringify(unwrap(a[0]), 0), line));

  def('versions', 1, (a) => (interp.versions.get(stringify(unwrap(a[0]), 0)) ?? []).length);

  def('callgraph', 0, () => interp.graph.toMap());

  def('callers', 1, (a) => interp.graph.callers(stringify(unwrap(a[0]), 0)));

  def('dependents', 1, (a) => interp.graph.dependents(stringify(unwrap(a[0]), 0)));

  def('recursive_cycles', 0, () => interp.graph.cycles());

  // State migration. `snapshot()` produces text; `restore()` takes it back.
  // Code does not travel -- the receiving side runs the same program.
  def('snapshot', 0, (_a, line) => {
    const state = snapshot(interp);
    if (state.skipped.length > 0) interp.trace.skippedInSnapshot = state.skipped;
    return JSON.stringify(state);
  });

  def('snapshot_report', 0, () => {
    const state = snapshot(interp);
    const m = new Map();
    m.set('globals', Object.keys(state.globals).length);
    m.set('agents', state.agents.length);
    m.set('skipped', state.skipped);
    m.set('bytes', JSON.stringify(state).length);
    return m;
  });

  def('restore', 1, (a, line) => {
    let state;
    try {
      state = JSON.parse(stringify(unwrap(a[0]), 0));
    } catch (e) {
      throw pedagError('RestoreError', `this is not a snapshot: ${e.message}`, line);
    }
    return restore(interp, state, line);
  });

  // Growth watching. Sampling is explicit, so nothing runs behind the
  // program's back and the samples line up with points it chose.
  def('watch', 0, () => {
    const sample = new Map();
    for (const [name, slot] of interp.globals.vars) {
      const v = unwrap(slot.value);
      if (v instanceof ContextWindow) sample.set(name, v.tokens);
      else if (v instanceof Ledger) sample.set(name, v.length);
      else if (Array.isArray(v)) sample.set(name, v.length);
      else if (v instanceof Map) sample.set(name, v.size);
      else if (v instanceof Arena) sample.set(name, v.resident);
    }
    interp.watches.push(sample);
    return sample.size;
  });

  // A structure that grew at every single sample is the shape of a leak. Two
  // samples prove nothing, so it says so rather than guessing.
  def('leaks', 0, (_a, line) => {
    const samples = interp.watches;
    if (samples.length < 3) {
      throw pedagError('ValueError',
        `leak detection needs at least 3 watch() samples, and has ${samples.length}`, line);
    }
    const out = [];
    for (const name of samples[0].keys()) {
      let alwaysGrew = true;
      for (let i = 1; i < samples.length; i++) {
        const before = samples[i - 1].get(name);
        const after = samples[i].get(name);
        if (before === undefined || after === undefined || after <= before) { alwaysGrew = false; break; }
      }
      if (alwaysGrew) {
        const m = new Map();
        m.set('name', name);
        m.set('from', samples[0].get(name));
        m.set('to', samples[samples.length - 1].get(name));
        m.set('samples', samples.length);
        out.push(m);
      }
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Devices, memory and weights
// ---------------------------------------------------------------------------

function installDevices(interp, def, num) {
  def('devices', 0, () => interp.devices.available);

  def('device_stats', 0, () => {
    const m = new Map();
    for (const [name, b] of interp.devices.backends) {
      const s = new Map();
      s.set('dispatched', b.dispatched ?? 0);
      s.set('ran_here_instead', b.fellBack ?? 0);
      if (b.workerCount) s.set('threads', b.workerCount);
      m.set(name, s);
    }
    m.set('active', interp.devices.active.name);
    return m;
  });

  def('topology', 0, () => topology());
  def('pressure', 0, () => pressure());

  def('arena', -1, (a, line) => {
    if (a.length < 1 || a.length > 2) {
      throw pedagError('ArityError', `arena takes 1 or 2 arguments, got ${a.length}`, line);
    }
    const bytes = Math.trunc(num(a[0], 'an arena budget', line));
    if (bytes <= 0) throw pedagError('ValueError', `an arena budget must be positive, got ${bytes}`, line);
    let dir = null;
    if (a.length === 2) {
      if (!interp.caps.has('fs')) {
        throw pedagError('CapabilityError',
          "an arena that spills to disk needs the 'fs' capability", line);
      }
      dir = path.resolve(interp.cwd, stringify(unwrap(a[1]), 0));
      fs.mkdirSync(dir, { recursive: true });
    }
    return new Arena(bytes, dir);
  });

  def('weights', 3, (a, line) => {
    const file = path.resolve(interp.cwd, stringify(unwrap(a[0]), 0));
    const shape = interp.toShape(unwrap(a[1]), line);
    const dtype = stringify(unwrap(a[2]), 0);
    try {
      return new Weights(file, shape, dtype);
    } catch (e) {
      throw pedagError('IOError', e.message, line);
    }
  }, { needs: ['fs'] });
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

function installAgents(interp, def, num) {
  const asAgent = (v, what, line) => {
    const u = unwrap(v);
    if (u === null && interp.currentAgent) {
      throw pedagError('AgentError',
        'this message came from the top level, so `sender` is nil; only a message sent by another agent has one', line);
    }
    if (!(u instanceof AgentRef)) {
      throw pedagError('TypeError', `${what}, got ${typeName(u)}`, line);
    }
    return u;
  };

  def('send', -1, (a, line) => {
    if (a.length < 2) {
      throw pedagError('ArityError', 'send needs at least an agent and a message name', line);
    }
    const to = asAgent(a[0], 'send needs an agent first', line);
    const message = stringify(unwrap(a[1]), 0);
    if (!to.template.handlers.has(message)) {
      throw pedagError('AgentError',
        `agent ${to.template.name} has no handler for '${message}'`, line);
    }
    // `sender` is whichever agent is running now, or nil from the top level.
    const from = interp.currentAgent ?? null;
    return interp.scheduler.send(to, message, a.slice(2), from);
  });

  // Drain every mailbox. Deterministic: round-robin in spawn order, one
  // message per agent per pass.
  def('run_agents', -1, (a, line) => {
    const max = a.length ? Math.trunc(num(a[0], 'a message ceiling', line)) : 100000;
    return interp.scheduler.run((agent, envelope) => {
      const saved = interp.currentAgent;
      interp.currentAgent = agent;
      try {
        interp.deliverMessage(agent, envelope, line);
      } finally {
        interp.currentAgent = saved;
      }
    }, max, line);
  });

  def('pending', 0, () => interp.scheduler.pending);
  def('agents', 0, () => [...interp.scheduler.agents]);
}

// ---------------------------------------------------------------------------
// Quantum
// ---------------------------------------------------------------------------

function installQuantum(interp, def, num) {
  const reg = (v, line) => {
    const u = unwrap(v);
    if (!(u instanceof QubitRegister)) {
      throw pedagError('TypeError', `this gate needs a qubit register, got ${typeName(u)}`, line);
    }
    return u;
  };
  const idx = (v, line) => Math.trunc(num(v, 'a qubit index', line));

  def('qubits', 1, (a, line) => {
    const n = Math.trunc(num(a[0], 'a qubit count', line));
    try {
      return new QubitRegister(n);
    } catch (e) {
      throw pedagError('ValueError', e.message, line);
    }
  });

  // Gates are prefixed `q`. In a general-purpose language, h/x/y/z/s/t are far
  // too useful as ordinary variable names to spend on the prelude.
  for (const name of ['h', 'x', 'y', 'z', 's', 't']) {
    def(`q${name}`, 2, (a, line) => reg(a[0], line).apply(GATES[name], idx(a[1], line), line));
  }

  const rotations = { qrx: rx, qry: ry, qrz: rz };
  for (const [name, build] of Object.entries(rotations)) {
    def(name, 3, (a, line) =>
      reg(a[0], line).apply(build(num(a[2], 'a rotation angle', line)), idx(a[1], line), line));
  }

  def('cnot', 3, (a, line) =>
    reg(a[0], line).applyControlled(GATES.x, idx(a[1], line), idx(a[2], line), line));
  def('cz', 3, (a, line) =>
    reg(a[0], line).applyControlled(GATES.z, idx(a[1], line), idx(a[2], line), line));
  def('qswap', 3, (a, line) => reg(a[0], line).swap(idx(a[1], line), idx(a[2], line), line));

  def('measure', 2, (a, line) => reg(a[0], line).measure(idx(a[1], line), interp.rng, line));
  def('measure_all', 1, (a, line) => reg(a[0], line).measureAll(interp.rng, line));
  def('probabilities', 1, (a, line) => reg(a[0], line).probabilities());
}

// ---------------------------------------------------------------------------
// Logical time
// ---------------------------------------------------------------------------

function installTemporal(interp, def, num) {
  def('clock', 1, (a) => new LogicalClock(stringify(unwrap(a[0]), 0)));

  def('before', 2, (a, line) => {
    const x = unwrap(a[0]);
    const y = unwrap(a[1]);
    if (!(x instanceof Stamp) || !(y instanceof Stamp)) {
      throw pedagError('TypeError', 'before() compares two stamps', line);
    }
    return x.compare(y) < 0;
  });

  def('liquid', -1, (a, line) => {
    if (a.length < 2 || a.length > 3) {
      throw pedagError('ArityError', `liquid takes 2 or 3 arguments, got ${a.length}`, line);
    }
    const initial = num(a[0], 'a starting value', line);
    const halflife = num(a[1], 'a half-life', line);
    if (halflife <= 0) throw pedagError('ValueError', `a half-life must be positive, got ${halflife}`, line);
    const anchor = a.length === 3 ? num(a[2], 'an anchor time', line) : interp.logicalTime;
    return new Liquid(initial, halflife, anchor);
  });

  // Logical time. Not a wall clock -- a program that advances time explicitly
  // replays identically, which is the whole point.
  def('advance', 1, (a, line) => {
    const by = num(a[0], 'a time step', line);
    if (by < 0) throw pedagError('ValueError', 'time does not run backwards', line);
    interp.logicalTime += by;
    return interp.logicalTime;
  });

  def('time', 0, () => interp.logicalTime);
}

// ---------------------------------------------------------------------------
// Cryptography
// ---------------------------------------------------------------------------
//
// Two capabilities, not one, and the split is the important part.
//
// `crypto` covers primitives that delegate to the platform: Ed25519 signing,
// SHA-256, and the operating system's entropy. Those are audited code that this
// project did not write.
//
// `unaudited_crypto` covers Paillier, Schnorr and Pedersen, which are
// implemented here in BigInt. They are correct as far as the test suite can
// establish — the group parameters are re-derived rather than trusted, and the
// round-trips and soundness properties are checked — but BigInt arithmetic in
// JavaScript is not constant time, so these operations leak timing information
// and are exposed to side-channel attack. They have had no third-party audit.
//
// Splitting them means a deployment can hold `crypto` and refuse
// `unaudited_crypto`, and nothing in a dependency can reach the unaudited path
// without that grant appearing in the run's configuration. Anything that
// consumes entropy also makes a run irreproducible, which is the same reason
// `now()` needs `clock`.

function installCrypto(interp, def, num) {
  const toBig = (v, what, line) => {
    const u = unwrap(v);
    if (typeof u !== 'number' || !Number.isInteger(u)) {
      throw pedagError('TypeError', `${what} must be a whole number, got ${typeName(u)}`, line);
    }
    return BigInt(u);
  };

  const fromBig = (b, line) => {
    const limit = BigInt(Number.MAX_SAFE_INTEGER);
    if (b > limit || b < -limit) {
      throw pedagError('ValueError',
        'this result is outside the range a num holds exactly; work in scaled integers', line);
    }
    return Number(b);
  };

  const expect = (v, cls, what, line) => {
    const u = unwrap(v);
    if (!(u instanceof cls)) throw pedagError('TypeError', `${what}, got ${typeName(u)}`, line);
    return u;
  };

  const wrapNative = (fn, line) => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof PedagError) throw e;
      throw pedagError('CryptoError', e.message, line);
    }
  };

  // Loading foreign code needs the `ffi` capability, and for the strongest
  // reason any capability exists: once control crosses into JavaScript, none of
  // Pēdāg's guarantees apply to what happens there. Better to make the boundary
  // something you have to ask for than to leave it open by default.
  def('foreign', 1, (a, line) => loadForeign(stringify(unwrap(a[0]), 0), interp, line), { needs: ['ffi'] });

  // --- exact arithmetic ----------------------------------------------------

  def('dec', 1, (a, line) => {
    const u = unwrap(a[0]);
    if (u instanceof Decimal) return u;
    if (typeof u === 'number') return Decimal.fromInteger(u, line);
    return Decimal.parse(stringify(u, 0), line);
  });

  def('is_dec', 1, (a) => unwrap(a[0]) instanceof Decimal, { transparent: true });

  def('dec_sum', 1, (a, line) => {
    const xs = unwrap(a[0]);
    if (!Array.isArray(xs)) throw pedagError('TypeError', `dec_sum needs a list, got ${typeName(xs)}`, line);
    let total = new Decimal(0n, 0);
    for (const x of xs) total = total.add(expectDec(x, 'every element', line));
    return total;
  });

  def('sha256', 1, (a) => sha256Hex(stringify(unwrap(a[0]), 0)));

  // --- homomorphic encryption ----------------------------------------------

  const UNAUDITED = { needs: ['unaudited_crypto'] };

  // A key size that provides no security is not a warning, it is a different
  // function. `paillier_keygen` refuses below 2048; anything smaller has to be
  // asked for by a name that says what it is, and the run records that it was.
  def('paillier_keygen', -1, (a, line) => {
    const bits = a.length ? Math.trunc(num(a[0], 'a key size', line)) : PAILLIER_MIN_BITS;
    return wrapNative(() => paillierKeygen(bits), line);
  }, UNAUDITED);

  def('paillier_keygen_insecure', 1, (a, line) => {
    const bits = Math.trunc(num(a[0], 'a key size', line));
    const notice = `a ${bits}-bit Paillier modulus was generated at line ${line}; `
      + `it factors on a laptop and protects nothing (${PAILLIER_MIN_BITS} is the minimum for anything real)`;
    interp.trace.cryptoWarnings = interp.trace.cryptoWarnings ?? [];
    interp.trace.cryptoWarnings.push(notice);
    interp.warn(`warning: ${notice}`);
    return wrapNative(() => paillierKeygen(bits, { insecure: true }), line);
  }, UNAUDITED);

  def('encrypt', 2, (a, line) => {
    const key = expect(a[0], PaillierKey, 'encrypt needs a paillier key first', line);
    return wrapNative(() => paillierEncrypt(key, toBig(a[1], 'a plaintext', line)), line);
  }, UNAUDITED);

  def('decrypt', 2, (a, line) => {
    const key = expect(a[0], PaillierKey, 'decrypt needs a paillier key first', line);
    const cipher = expect(a[1], Cipher, 'decrypt needs a ciphertext second', line);
    return fromBig(wrapNative(() => paillierDecrypt(key, cipher), line), line);
  }, UNAUDITED);

  // --- zero knowledge ------------------------------------------------------

  const secretExponent = (v, what, line) => {
    const u = unwrap(v);
    if (u instanceof Secret) return bigFromHex(u.digest());
    return toBig(v, what, line);
  };

  // Verification is gated too. It is deterministic, but it runs the same
  // hand-rolled group arithmetic, and code that decides whether to accept a
  // proof is exactly where an unaudited implementation matters most.
  def('zk_public', 1, (a, line) =>
    new GroupElement(zkPublic(secretExponent(a[0], 'a zk secret', line))), UNAUDITED);

  def('zk_prove', 1, (a, line) =>
    wrapNative(() => zkProve(secretExponent(a[0], 'a zk secret', line)), line), UNAUDITED);

  def('zk_verify', 2, (a, line) => {
    const y = expect(a[0], GroupElement, 'zk_verify needs a public element first', line);
    const proof = expect(a[1], ZkProof, 'zk_verify needs a proof second', line);
    return zkVerify(y.v, proof);
  }, UNAUDITED);

  def('commit', 2, (a, line) =>
    pedersenCommit(toBig(a[0], 'a committed value', line), toBig(a[1], 'a blinding factor', line)), UNAUDITED);

  def('commit_open', 3, (a, line) => {
    const c = expect(a[0], Commitment, 'commit_open needs a commitment first', line);
    return pedersenVerify(c, toBig(a[1], 'a committed value', line), toBig(a[2], 'a blinding factor', line));
  }, UNAUDITED);

  // --- signatures and lineage ----------------------------------------------

  def('keypair', 0, (_a, line) => wrapNative(() => generateKeypair(), line), { needs: ['crypto'] });

  def('sign', 2, (a, line) => {
    const kp = expect(a[0], KeyPair, 'sign needs a keypair first', line);
    return wrapNative(() => signMessage(kp, stringify(unwrap(a[1]), 0)), line);
  });

  def('verify_signature', 3, (a) =>
    verifyMessage(String(unwrap(a[0])), stringify(unwrap(a[1]), 0), String(unwrap(a[2]))));

  def('lineage', 2, (a, line) => {
    const kp = expect(a[1], KeyPair, 'lineage needs a signing keypair second', line);
    if (!kp.canSign) throw pedagError('CryptoError', 'a lineage chain needs a keypair that can sign', line);
    return new LineageChain(stringify(unwrap(a[0]), 0), kp);
  });

  // --- secrets -------------------------------------------------------------

  def('secret_of', 1, (a) => interp.trackSecret(new Secret(stringify(unwrap(a[0]), 0))), { transparent: true });

  def('random_secret', 1, (a, line) => {
    const n = Math.trunc(num(a[0], 'a secret length', line));
    if (n <= 0 || n > 4096) throw pedagError('ValueError', `a secret of ${n} bytes is not sensible`, line);
    return interp.trackSecret(randomSecret(n));
  }, { needs: ['crypto'] });

  def('reveal', 1, (a, line) => {
    const s = expect(a[0], Secret, 'reveal needs a secret', line);
    return wrapNative(() => s.reveal(), line);
  }, { transparent: true });
}
