import {
  Linear, Rat, atom, boolAtom, and, or, not, implies, isValid, TRUE, FALSE,
} from './logic.js';
import { Diagnostic } from './diagnostics.js';

// Proving contracts instead of testing them.
//
// `pedag prove` throws generated inputs at a contract and reports what breaks.
// That finds real bugs and it is what most languages offer. It cannot tell you
// a contract *holds* — only that a few hundred inputs did not break it.
//
// This does the other thing. Following Dijkstra's weakest-precondition calculus
// and the shape Dafny uses, each function becomes a verification condition:
//
//     requires  ==>  wp(body, ensures)
//
// and each loop three more: the invariant is established, the invariant is
// preserved by a pass, and the variant strictly decreases while staying at or
// above zero. Discharging those against the solver proves the contract for
// *every* input, unbounded, with no sampling.
//
// What it does not do is more important than what it does:
//
//   - It reasons about linear arithmetic over rationals, booleans, and equality.
//     Non-linear terms, calls, collections and strings become opaque variables.
//   - Opaqueness is sound in the proving direction and lossy in the other: it
//     can fail to prove a true thing, and cannot claim a false one.
//   - Integer division and modulo are not modelled exactly.
//   - Three answers, always distinguished: proved, refuted with a
//     counterexample, or `cannot decide` — never a proof by silence.

// Two kinds of fresh symbol, and the difference decides whether a refutation
// can be believed.
//
//   `?` — an approximation. Something the solver cannot model (a non-linear
//         product, a call, an unmodelled statement) became an unconstrained
//         variable. That *widens* the models, which is sound for proving --
//         no model even with the extra freedom means no model at all -- and
//         unsound for refuting, because the model found may not correspond to
//         any real execution. A condition touching one of these can be proved
//         but never refuted.
//
//   `$` — a universally quantified program state: the arbitrary state at the
//         top of a loop. A counterexample here is a genuine refutation of the
//         annotation, because an invariant is required to hold for every such
//         state whether or not the loop can reach it.
let symbolCounter = 0;
const freshOpaque = (hint) => `?${hint}#${symbolCounter++}`;
const freshHavoc = (hint) => `$${hint}#${symbolCounter++}`;

const APPROXIMATE = /(^|[^\w])\?/;

// Does this condition rest on anything the solver could not model?
function isApproximate(formula) {
  let found = false;
  const walk = (f) => {
    if (found || !f) return;
    switch (f.k) {
      case 'atom':
        for (const v of f.linear.variables()) if (v.startsWith('?')) { found = true; return; }
        return;
      case 'bool': found = true; return;   // an unmodelled boolean term
      case 'not': walk(f.f); return;
      case 'and':
      case 'or': f.parts.forEach(walk); return;
      default:
    }
  };
  walk(formula);
  return found;
}

class Context {
  constructor() {
    this.env = new Map();       // program variable -> Linear (its current value)
    this.opaque = new Map();    // syntax key -> opaque variable name
  }
  clone() {
    const c = new Context();
    c.env = new Map(this.env);
    c.opaque = this.opaque;     // shared: the same expression stays the same unknown
    return c;
  }
}

// A key that is stable for the same syntax in the same shape, so `f(x)`
// appearing twice is the same unknown rather than two.
function syntaxKey(node) {
  if (!node || typeof node !== 'object') return String(node);
  switch (node.type) {
    case 'Num': return `n${node.value}`;
    case 'DecLit': return `d${node.value}`;
    case 'Str': return `s${JSON.stringify(node.value)}`;
    case 'Bool': return `b${node.value}`;
    case 'Nil': return 'nil';
    case 'Ident': return node.name;
    case 'Member': return `${syntaxKey(node.object)}.${node.name}`;
    case 'Index': return `${syntaxKey(node.object)}[${node.indices.map(syntaxKey).join(',')}]`;
    case 'Call': return `${syntaxKey(node.callee)}(${node.args.map(syntaxKey).join(',')})`;
    case 'Binary': return `(${syntaxKey(node.left)}${node.op}${syntaxKey(node.right)})`;
    case 'Unary': return `(${node.op}${syntaxKey(node.operand)})`;
    default: return `?${node.type}`;
  }
}

// --- expressions to linear terms ---------------------------------------------

function toLinear(node, ctx) {
  switch (node.type) {
    // A decimal literal is an exact rational, which is what the solver wants
    // anyway -- `Rat.ofDecimal` reads the digits as written rather than
    // through a float, so no rounding enters the proof.
    case 'Num': return Linear.constant(Rat.of(node.value));
    case 'DecLit': return Linear.constant(Rat.ofDecimal(node.value));

    case 'Ident': {
      const known = ctx.env.get(node.name);
      return known ?? Linear.variable(node.name);
    }

    case 'Unary':
      if (node.op === '-') return toLinear(node.operand, ctx).neg();
      return opaqueLinear(node, ctx);

    case 'Binary': {
      const { op } = node;
      if (op === '+') return toLinear(node.left, ctx).add(toLinear(node.right, ctx));
      if (op === '-') return toLinear(node.left, ctx).sub(toLinear(node.right, ctx));
      if (op === '*') {
        const l = toLinear(node.left, ctx);
        const r = toLinear(node.right, ctx);
        // Linear arithmetic only: a product is linear when one side is known.
        if (l.isConstant) return r.scale(l.constant);
        if (r.isConstant) return l.scale(r.constant);
        return opaqueLinear(node, ctx);
      }
      if (op === '/') {
        const r = toLinear(node.right, ctx);
        if (r.isConstant && !r.constant.isZero()) {
          return toLinear(node.left, ctx).scale(Rat.of(1).div(r.constant));
        }
        return opaqueLinear(node, ctx);
      }
      return opaqueLinear(node, ctx);
    }

    // `old(e)` is a value from the pre-state; the caller seeds it into the
    // context under this name before generating the condition.
    case 'Call':
      if (node.callee.type === 'Ident' && node.callee.name === 'old') {
        const key = `old(${syntaxKey(node.args[0])})`;
        const known = ctx.env.get(key);
        return known ?? Linear.variable(key);
      }
      return opaqueLinear(node, ctx);

    default:
      return opaqueLinear(node, ctx);
  }
}

// Anything the solver cannot see into becomes a variable with no constraints.
// Widening the models is sound for proving; see the note at the top.
function opaqueLinear(node, ctx) {
  const key = syntaxKey(node);
  if (!ctx.opaque.has(key)) ctx.opaque.set(key, freshOpaque('t'));
  return Linear.variable(ctx.opaque.get(key));
}

// --- expressions to formulas -------------------------------------------------

function toFormula(node, ctx) {
  if (!node) return TRUE;
  switch (node.type) {
    case 'Bool': return node.value ? TRUE : FALSE;

    case 'Logical':
      return node.op === 'and'
        ? and(toFormula(node.left, ctx), toFormula(node.right, ctx))
        : or(toFormula(node.left, ctx), toFormula(node.right, ctx));

    case 'Unary':
      if (node.op === 'not') return not(toFormula(node.operand, ctx));
      return opaqueFormula(node, ctx);

    case 'Binary': {
      const { op } = node;
      if (['<', '<=', '>', '>=', '==', '!='].includes(op)) {
        const l = toLinear(node.left, ctx);
        const r = toLinear(node.right, ctx);
        switch (op) {
          case '<': return atom('<', l.sub(r));
          case '<=': return atom('<=', l.sub(r));
          case '>': return atom('<', r.sub(l));
          case '>=': return atom('<=', r.sub(l));
          case '==': return atom('=', l.sub(r));
          case '!=': return not(atom('=', l.sub(r)));
          default: break;
        }
      }
      return opaqueFormula(node, ctx);
    }

    default:
      return opaqueFormula(node, ctx);
  }
}

function opaqueFormula(node, ctx) {
  const key = syntaxKey(node);
  return boolAtom(key);
}

// --- forward symbolic execution ----------------------------------------------
//
// The representation here maps each variable to a symbolic value, so the
// natural direction is forwards: walk the body accumulating a path condition
// and a final state, then evaluate the postcondition *in that state*.
//
// This is equivalent to the weakest precondition for the fragment being
// modelled, and it avoids the mistake the backward form invites with a
// substitution environment -- building the postcondition formula before the
// body has had a chance to define `result`, which makes every postcondition
// look refutable because `result` is still a free variable.
//
// A branch splits the path. A loop is summarised by its invariant, which is
// exactly the annotation the language asks for.

const MAX_PATHS = 64;

class Verifier {
  constructor(fn) {
    this.fn = fn;
    this.conditions = [];
    this.tooManyPaths = false;
  }

  add(kind, name, formula, node) {
    this.conditions.push({ kind, name, formula, node });
  }

  // Returns the terminal states of every path through `statements`.
  run(statements, state) {
    let states = [state];
    for (const stmt of statements) {
      const next = [];
      for (const s of states) {
        if (s.returned) { next.push(s); continue; }
        next.push(...this.step(stmt, s));
      }
      states = next;
      if (states.length > MAX_PATHS) { this.tooManyPaths = true; return states.slice(0, MAX_PATHS); }
    }
    return states;
  }

  step(node, state) {
    const ctx = state.ctx;
    switch (node.type) {
      case 'Declare':
        ctx.env.set(node.name, toLinear(node.value, ctx));
        return [state];

      case 'ExprStmt':
        if (node.expr.type === 'Assign' && node.expr.target.type === 'Ident') {
          ctx.env.set(node.expr.target.name, toLinear(node.expr.value, ctx));
        }
        return [state];

      case 'Return': {
        if (node.value) ctx.env.set('result', toLinear(node.value, ctx));
        return [{ ...state, returned: true }];
      }

      case 'If': {
        const test = toFormula(node.test, ctx);
        const taken = this.fork(state, test);
        const skipped = this.fork(state, not(test));
        const out = [];
        out.push(...this.run(node.then.body, taken));
        if (node.alt && node.alt.body) out.push(...this.run(node.alt.body, skipped));
        else out.push(skipped);
        return out;
      }

      case 'Block':
        return this.run(node.body, state);

      case 'While':
      case 'For':
        return [this.loop(node, state)];

      default: {
        // Not modelled: forget what it might have changed.
        for (const name of [...ctx.env.keys()]) ctx.env.set(name, Linear.variable(freshOpaque(name)));
        return [state];
      }
    }
  }

  fork(state, condition) {
    return {
      ctx: state.ctx.clone(),
      path: and(state.path, condition),
      pre: state.pre,
      returned: state.returned,
    };
  }

  // A loop contributes three obligations and then summarises itself by its
  // invariant. Without an invariant it can only be forgotten, which is the
  // honest reading of an unannotated loop.
  loop(node, state) {
    const ctx = state.ctx;
    const invariants = node.invariants ?? [];
    const hasVariant = Boolean(node.variant);

    if (invariants.length === 0 && !hasVariant) {
      // Nothing was stated, so nothing is known afterwards. This is an
      // approximation, not a universal: refutations downstream cannot be trusted.
      for (const name of [...ctx.env.keys()]) ctx.env.set(name, Linear.variable(freshOpaque(name)));
      return state;
    }

    // 1. established: whatever holds here must imply the invariant.
    const atEntry = and(...invariants.map((c) => toFormula(c.expr, ctx)));
    this.add('loop-established', 'the loop invariant holds on entry',
      implies(and(state.pre, state.path), atEntry), node);

    // 2. preserved, and 3. the variant, from an arbitrary state that satisfies
    // the invariant and the test.
    const body = new Context();
    body.opaque = ctx.opaque;
    // An arbitrary state satisfying the invariant: universally quantified, so a
    // counterexample here really does refute the annotation.
    for (const name of ctx.env.keys()) body.env.set(name, Linear.variable(freshHavoc(name)));

    const invariantAtTop = and(...invariants.map((c) => toFormula(c.expr, body)));
    const test = toFormula(node.test ?? { type: 'Bool', value: true }, body);
    const variantBefore = hasVariant ? toLinear(node.variant.expr, body) : null;

    const after = { ctx: body.clone(), path: and(invariantAtTop, test), pre: state.pre, returned: false };
    const ends = this.run(node.body.body, after);

    for (const end of ends) {
      const restored = and(...invariants.map((c) => toFormula(c.expr, end.ctx)));
      this.add('loop-preserved', 'a pass restores the loop invariant',
        implies(end.path, restored), node);
      if (hasVariant) {
        const variantAfter = toLinear(node.variant.expr, end.ctx);
        this.add('variant-decreases', 'the loop variant strictly decreases',
          implies(end.path, atom('<', variantAfter.sub(variantBefore))), node.variant);
      }
    }

    if (hasVariant) {
      this.add('variant-nonnegative', 'the loop variant stays at or above zero',
        implies(and(invariantAtTop, test), atom('<=', Linear.constant(0).sub(variantBefore))),
        node.variant);
    }

    // After the loop the invariant holds and the test does not.
    for (const name of [...ctx.env.keys()]) ctx.env.set(name, Linear.variable(freshHavoc(name)));
    const atExit = and(...invariants.map((c) => toFormula(c.expr, ctx)));
    const exitTest = toFormula(node.test ?? { type: 'Bool', value: true }, ctx);
    return { ...state, path: and(state.path, atExit, not(exitTest)) };
  }
}

// --- the entry point ---------------------------------------------------------

export function verifyFunction(fn, options = {}) {
  const v = new Verifier(fn);
  const ctx = new Context();

  // Parameters are arbitrary values, and `old(e)` names their entry state.
  for (const p of fn.params) ctx.env.set(p, Linear.variable(p));
  for (const c of fn.ensures) {
    const scan = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(scan); return; }
      if (n.type === 'Call' && n.callee.type === 'Ident' && n.callee.name === 'old' && n.args[0]) {
        const key = `old(${syntaxKey(n.args[0])})`;
        ctx.env.set(key, toLinear(n.args[0], ctx));
      }
      for (const child of Object.values(n)) if (child && typeof child === 'object') scan(child);
    };
    scan(c.expr);
  }

  const pre = and(...fn.requires.map((c) => toFormula(c.expr, ctx)));

  // Walk the body forward, then read the postcondition in each terminal state.
  // Evaluating it here, after `result` has been defined, is the whole point.
  const ends = v.run(fn.body.body, { ctx, path: TRUE, pre, returned: false });

  if (fn.ensures.length > 0) {
    for (const end of ends) {
      const post = and(...fn.ensures.map((c) => toFormula(c.expr, end.ctx)));
      v.add('postcondition', `${fn.name ?? 'this function'} keeps its promise`,
        implies(and(pre, end.path), post), fn);
    }
  }

  if (v.tooManyPaths) {
    return [{
      kind: 'paths', name: `${fn.name ?? 'this function'} has too many paths to explore`,
      fn: fn.name ?? '<anonymous>', result: 'unknown', node: fn,
    }];
  }

  return v.conditions.map((c) => {
    let result = isValid(c.formula, options);
    // A refutation that rests on an over-approximation is not a refutation.
    // Downgrading it to `undecided` is the difference between a verifier and
    // something that confidently makes things up.
    if (result === false && isApproximate(c.formula)) result = 'unknown';
    return { ...c, fn: fn.name ?? '<anonymous>', result, approximate: isApproximate(c.formula) };
  });
}

export function verifyProgram(program, options = {}) {
  const results = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'FnDecl') {
      const fn = node.fn;
      if (fn.requires.length > 0 || fn.ensures.length > 0 || hasLoopContracts(fn)) {
        results.push(...verifyFunction(fn, options));
      }
    }
    for (const child of Object.values(node)) if (child && typeof child === 'object') walk(child);
  };
  walk(program.body);
  return results;
}

function hasLoopContracts(fn) {
  let found = false;
  const walk = (n) => {
    if (found || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if ((n.type === 'While' || n.type === 'For') && ((n.invariants ?? []).length > 0 || n.variant)) {
      found = true;
      return;
    }
    for (const c of Object.values(n)) if (c && typeof c === 'object') walk(c);
  };
  walk(fn.body);
  return found;
}

export function formatVerification(results, file) {
  const lines = [];
  let proved = 0;
  let failed = 0;
  let unknown = 0;

  for (const r of results) {
    if (r.result === true) {
      proved += 1;
      lines.push(`  proved    ${r.fn}: ${r.name}`);
    } else if (r.result === false) {
      failed += 1;
      lines.push(`  REFUTED   ${r.fn}: ${r.name}`);
      lines.push(`            there is an input for which this does not hold`);
    } else {
      unknown += 1;
      lines.push(`  undecided ${r.fn}: ${r.name}`);
      lines.push(`            beyond linear arithmetic; \`pedag prove\` will still test it`);
    }
  }

  const summary = `${proved} proved, ${failed} refuted, ${unknown} undecided`;
  return { text: lines.join('\n'), summary, proved, failed, unknown, ok: failed === 0 };
}
