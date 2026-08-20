// Closure compilation: the AST is turned into JavaScript closures once, and
// those closures are what run.
//
// The tree-walker spends 71% of its time in three functions -- `exec`,
// `execBlock` and `evaluate` -- and almost all of that is dispatch rather than
// work. Every time `fib(30)` evaluates `n - 1` it re-enters a switch over forty
// statement kinds to rediscover that the node is still a Binary. V8 cannot
// speculate through a switch that wide, so nothing gets inlined and every node
// visit pays full price.
//
// Compiling each node into a closure moves that decision to compile time. The
// switch runs once per node in the program instead of once per execution of
// that node, and what is left at each site is a monomorphic call that V8 can
// inline and specialise.
//
// A bytecode VM was the other option and is the wrong one for a JavaScript
// host: the dispatch loop would itself be a wide switch, interpreted by V8, so
// you would trade one megamorphic dispatch for another and additionally hide
// the real work behind an opcode table. Closures let the JIT see the work.
//
// The second win is unrelated to dispatch. `return` was implemented by throwing
// a ReturnSignal, so `fib(30)` threw and unwound roughly 2.7 million JavaScript
// exceptions. Throwing is not free anywhere, and in V8 it deoptimises the
// frames it passes through. Compiled code signals completion by returning a
// sentinel instead, and only the call boundary interprets it.
//
// CORRECTNESS RULE, which is the whole reason this is a separate file: the
// tree-walker is the specification. Every compiled node mirrors the
// interpreter's own code for that node, with the static parts hoisted and
// nothing else changed -- same order of evaluation, same `tick`, same `guard`,
// same taint and label handling. Any node kind not compiled here falls back to
// the interpreter, so an unhandled or newly added syntax form is slow rather
// than wrong. `tools/differential.mjs` runs both engines over every example and
// test program and compares the output byte for byte.

import { pedagError, ReturnSignal, BreakSignal, ContinueSignal } from './errors.js';
import {
  PedagFunction, NativeFunction, Tainted,
  unwrap, retaint, truthy, freezeDeep, stringify, withArticle, assertMutable,
} from './values.js';
import { Tensor } from './tensor.js';
import { Env, versionOf } from './env.js';

// --- the completion protocol -----------------------------------------------
//
// A compiled statement returns either a plain value (its result, for an
// expression statement) or one of these sentinels. They are unique objects, so
// no program value can be mistaken for one.
//
// The value carried by a `return`, and the line the signal came from, live on
// the interpreter rather than in the sentinel. That is safe because a signal
// unwinds to its boundary before any other statement can run: there is never a
// second live one. The line matters -- a `break` with no loop is reported at
// the line the `break` is on, and dropping it made the compiled engine's error
// message differ from the tree-walker's.

export const SIG_RETURN = { signal: 'return' };
export const SIG_BREAK = { signal: 'break' };
export const SIG_CONTINUE = { signal: 'continue' };

// `guard` enforces the label and taint rules, and it is called on every operand,
// every argument, every index and every loop subject. For anything that is not
// an object it is the identity function: `Labelled` and `Tainted` are both
// classes, so a number, string, boolean or nil can never be either, and `guard`
// returns it untouched after two failed `instanceof` checks.
//
// So the type test is done at the call site instead, and the call is skipped
// entirely for primitives. Equivalent by construction -- everything that could
// possibly be labelled or tainted still goes through `guard` unchanged -- and in
// arithmetic-heavy code it removes most of the calls.

// One unit of work, charged inline.
//
// `tick` is called once per statement and once per loop pass, so on a counting
// loop it is one of the most frequent calls in the runtime -- and it almost
// always does nothing but increment a counter. The increment and the "is
// anything due" test are one comparison here; the rest stays in the
// interpreter and is reached only when the limit is passed or a budget is open.

const isSignal = (v) => v === SIG_RETURN || v === SIG_BREAK || v === SIG_CONTINUE;

// --- compilation cache -------------------------------------------------------
//
// Keyed on the node, so a function body compiles once however many times it is
// called -- which is the entire point for a recursive function.

const EXPR = Symbol('compiled expression');
const STMT = Symbol('compiled statement');

export function compileExpr(node) {
  const hit = node[EXPR];
  if (hit !== undefined) return hit;
  const fn = buildExpr(node);
  node[EXPR] = fn;
  return fn;
}

export function compileStmt(node) {
  const hit = node[STMT];
  if (hit !== undefined) return hit;
  const fn = buildStmt(node);
  node[STMT] = fn;
  return fn;
}

// --- expressions -------------------------------------------------------------

function buildExpr(node) {
  switch (node.type) {
    // Constants close over the value; nothing is looked at again at run time.
    case 'Num': case 'Str': case 'Bool': {
      const v = node.value;
      return () => v;
    }
    case 'Nil': return () => null;

    case 'Ident': {
      const name = node.name;
      // An inline cache, one entry, per occurrence of the name in the source.
      //
      // `slot` walks the scope chain doing a Map lookup per level, and a loop
      // body reading a variable declared outside it pays that walk on every
      // pass -- 19% of a counting loop's time. The scope object is the same one
      // each pass, so remembering the answer is nearly always right.
      //
      // "Nearly" is not good enough on its own, hence the epoch: any scope
      // anywhere gaining or losing a name invalidates every cache, because a
      // new binding could shadow what was cached. See env.js.
      const version = versionOf(name);
      let cachedEnv = null;
      let cachedVersion = -1;
      let cachedSlot = null;
      return (itp) => {
        const env = itp.env;
        if (env === cachedEnv && cachedVersion === version.v) return cachedSlot.value;
        const slot = env.slot(name);
        if (slot === undefined || slot === null) throw itp.unknownName(node);
        cachedEnv = env;
        cachedVersion = version.v;
        cachedSlot = slot;
        return slot.value;
      };
    }

    case 'Binary': return buildBinary(node);

    case 'Logical': {
      const left = compileExpr(node.left);
      const right = compileExpr(node.right);
      const line = node.line;
      if (node.op === 'and') {
        return (itp) => {
          const l = itp.guard(left(itp), line, 'operand');
          if (!truthy(l)) return l;
          return itp.guard(right(itp), line, 'operand');
        };
      }
      return (itp) => {
        const l = itp.guard(left(itp), line, 'operand');
        if (truthy(l)) return l;
        return itp.guard(right(itp), line, 'operand');
      };
    }

    case 'Unary': {
      const operand = compileExpr(node.operand);
      const line = node.line;
      const isNot = node.op === 'not';
      return (itp) => {
        const v = itp.guard(operand(itp), line, 'operand');
        const u = unwrap(v);
        if (isNot) return retaint(!truthy(u), v);
        if (u instanceof Tensor) return retaint(u.map((x) => -x), v);
        return retaint(-itp.asNumber(u, 'operand of -', line), v);
      };
    }

    case 'Call': return buildCall(node);

    case 'Member': {
      const object = compileExpr(node.object);
      const name = node.name;
      const line = node.line;
      return (itp) => {
        const obj = itp.guard(object(itp), line, 'value');
        const m = itp.member(unwrap(obj), name, line);
        if (obj instanceof Tainted && m instanceof NativeFunction) {
          const wrapped = new NativeFunction(m.name, m.arity,
            (args, l, i) => retaint(m.fn(args, l, i), obj), m.needs);
          wrapped.transparent = m.transparent;
          return wrapped;
        }
        return retaint(m, obj);
      };
    }

    case 'Index': {
      const object = compileExpr(node.object);
      const indices = node.indices.map(compileExpr);
      const line = node.line;
      const n = indices.length;
      return (itp) => {
        const obj = itp.guard(object(itp), line, 'indexed value');
        const idx = new Array(n);
        const raw = new Array(n);
        for (let i = 0; i < n; i++) {
          const v = itp.guard(indices[i](itp), line, 'index');
          idx[i] = v;
          raw[i] = unwrap(v);
        }
        return retaint(itp.index(unwrap(obj), raw, line), obj, ...idx);
      };
    }

    case 'ListLit': {
      const parts = node.elements.map(compileExpr);
      const n = parts.length;
      return (itp) => {
        const items = new Array(n);
        for (let i = 0; i < n; i++) items[i] = parts[i](itp);
        itp.spendMemory(32 + n * 8);
        return items;
      };
    }

    case 'MapLit': {
      const entries = node.entries.map((e) => ({ key: compileExpr(e.key), value: compileExpr(e.value) }));
      const n = entries.length;
      return (itp) => {
        const m = new Map();
        for (let i = 0; i < n; i++) {
          m.set(String(unwrap(entries[i].key(itp))), entries[i].value(itp));
        }
        return m;
      };
    }

    case 'Template': {
      // The literal text between the holes never changes, so it is baked in.
      const parts = node.parts.map((p) => (p.kind === 'text'
        ? { text: p.value }
        : { expr: compileExpr(p.expr), line: p.line }));
      const n = parts.length;
      return (itp) => {
        let out = '';
        let tainted = null;
        for (let i = 0; i < n; i++) {
          const p = parts[i];
          if (p.text !== undefined) { out += p.text; continue; }
          const v = itp.guard(p.expr(itp), p.line, 'interpolated value');
          if (v instanceof Tainted) tainted = tainted ? retaint(null, tainted, v) : v;
          out += stringify(unwrap(v), 0);
        }
        return tainted ? retaint(out, tainted) : out;
      };
    }

    case 'Assign': return buildAssign(node);

    case 'Fn': return (itp) => new PedagFunction(node, itp.env);

    default:
      // Not compiled: hand it back to the tree-walker. Slower, never wrong.
      return (itp) => itp.evaluate(node);
  }
}

const FAST_BINARY = {
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  '<': (a, b) => a < b,
  '>': (a, b) => a > b,
  '<=': (a, b) => a <= b,
  '>=': (a, b) => a >= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '**': (a, b) => a ** b,
};

// Assignment is the statement at the centre of nearly every loop -- `t = t + i`
// is the whole body of a counting loop -- and leaving it uncompiled was why the
// first version of this file made recursion three times faster and loops not at
// all. The three target shapes are distinguished once, here, instead of on
// every pass.
function buildAssign(node) {
  const value = compileExpr(node.value);
  const t = node.target;
  const line = node.line;

  if (t.type === 'Ident') {
    const name = t.name;
    // Same inline cache as a read, for the same reason: `t = t + i` resolves
    // `t` twice per pass and both walks are avoidable.
    const version = versionOf(name);
    let cachedEnv = null;
    let cachedVersion = -1;
    let cachedSlot = null;
    return (itp) => {
      const v = value(itp);
      // Only agents have anything to check, and almost nothing runs inside one.
      if (itp.agentBoundary) itp.checkAgentWrite(name, line);
      const env = itp.env;
      if (env === cachedEnv && cachedVersion === version.v) {
        if (!cachedSlot.mutable) {
          throw pedagError('ImmutableError',
            `'${name}' was declared with let and cannot be reassigned (use var if it must change)`, line);
        }
        cachedSlot.value = v;
        return v;
      }
      const slot = env.slot(name);
      if (slot === undefined || slot === null) {
        throw pedagError('NameError', `'${name}' is not defined`, line);
      }
      if (!slot.mutable) {
        throw pedagError('ImmutableError',
          `'${name}' was declared with let and cannot be reassigned (use var if it must change)`, line);
      }
      cachedEnv = env;
      cachedVersion = version.v;
      cachedSlot = slot;
      slot.value = v;
      return v;
    };
  }

  if (t.type === 'Index') {
    const object = compileExpr(t.object);
    const indices = t.indices.map(compileExpr);
    const n = indices.length;
    // The name to check for an agent-isolation violation is the root of the
    // path being written into, and the path is known now.
    let base = t.object;
    while (base && (base.type === 'Index' || base.type === 'Member')) base = base.object;
    const rootName = base && base.type === 'Ident' ? base.name : null;

    return (itp) => {
      const v = value(itp);
      if (rootName !== null && itp.agentBoundary) itp.checkAgentWrite(rootName, line);
      const obj = unwrap(object(itp));
      const idx = new Array(n);
      for (let i = 0; i < n; i++) idx[i] = unwrap(indices[i](itp));

      if (obj instanceof Tensor) {
        throw pedagError('ImmutableError',
          'tensors are immutable; build a new one instead of writing into this one', line);
      }
      if (Array.isArray(obj)) {
        assertMutable(obj, 'this list', line, pedagError);
        let i = Math.trunc(itp.asNumber(idx[0], 'a list index', line));
        if (i < 0) i += obj.length;
        if (i < 0 || i >= obj.length) {
          throw pedagError('IndexError', `list index ${idx[0]} out of range (length ${obj.length})`, line);
        }
        obj[i] = v;
        return v;
      }
      if (obj instanceof Map) {
        assertMutable(obj, 'this map', line, pedagError);
        obj.set(String(idx[0]), v);
        return v;
      }
      throw pedagError('TypeError', `cannot index-assign into ${withArticle(obj)}`, line);
    };
  }

  // Member assignment is for maps only; everything else exposes methods, not
  // writable fields.
  const object = compileExpr(t.object);
  const name = t.name;
  return (itp) => {
    const v = value(itp);
    const obj = unwrap(object(itp));
    if (obj instanceof Map) {
      assertMutable(obj, 'this map', line, pedagError);
      obj.set(name, v);
      return v;
    }
    throw pedagError('TypeError', `cannot assign to '.${name}' on ${withArticle(obj)}`, line);
  };
}

// A call is the hottest shape in most programs, so the parts that do not change
// between calls -- the argument count, the callee's printable name, whether it
// is the `old()` pseudo-call -- are all settled here.
// Arithmetic, with the operands read in place where that is possible.
//
// `t = t + i` is three nodes and used to be three closure calls: one for the
// addition and one for each name. A name and a literal are the only operands
// whose evaluation cannot have a side effect, which means their reads can be
// folded into the operator's own closure without changing when anything
// happens. In a counting loop that is most of the work.
//
// Order is preserved exactly: left is read and guarded before right is read,
// because `guard` can throw and a program is entitled to the first failure
// rather than a later one.
function buildBinary(node) {
  const op = node.op;
  const line = node.line;
  const fast = FAST_BINARY[op];

  // Both operands a name: read them in place.
  //
  // `t + i` was three closure calls, one for the operator and one for each
  // name. A name's evaluation cannot have a side effect, so folding the reads
  // into the operator's closure does not change when anything happens.
  //
  // Only names. Folding constants in as well was tried and made recursion 6%
  // slower while helping nothing: the extra branches for "is this side a
  // constant" grew the closure past the size V8 will inline, and the reads it
  // saved were of a value already sitting in the closure. A specialisation that
  // is not measured is a guess, and this one was wrong in the direction that
  // looks obviously right.
  //
  // Order is preserved exactly -- left read and guarded before right is read --
  // because `guard` can throw and a program is owed the first failure.
  if (fast && node.left.type === 'Ident' && node.right.type === 'Ident') {
    const L = node.left;
    const R = node.right;
    const lName = L.name;
    const rName = R.name;
    const lVer = versionOf(lName);
    const rVer = versionOf(rName);
    let lEnv = null;
    let lSeen = -1;
    let lSlot = null;
    let rEnv = null;
    let rSeen = -1;
    let rSlot = null;

    return (itp) => {
      const env = itp.env;

      let l;
      if (env === lEnv && lSeen === lVer.v) l = lSlot.value;
      else {
        const slot = env.slot(lName);
        if (slot === null || slot === undefined) throw itp.unknownName(L);
        lEnv = env; lSeen = lVer.v; lSlot = slot;
        l = slot.value;
      }
      if (l !== null && typeof l === 'object') l = itp.guard(l, line, 'operand');

      let r;
      if (env === rEnv && rSeen === rVer.v) r = rSlot.value;
      else {
        const slot = env.slot(rName);
        if (slot === null || slot === undefined) throw itp.unknownName(R);
        rEnv = env; rSeen = rVer.v; rSlot = slot;
        r = slot.value;
      }
      if (r !== null && typeof r === 'object') r = itp.guard(r, line, 'operand');

      if (typeof l === 'number' && typeof r === 'number') return fast(l, r);
      return itp.binary(op, l, r, line);
    };
  }

  const left = compileExpr(node.left);
  const right = compileExpr(node.right);
  if (fast) {
    return (itp) => {
      const lv = left(itp);
      const l = (lv !== null && typeof lv === 'object') ? itp.guard(lv, line, 'operand') : lv;
      const rv = right(itp);
      const r = (rv !== null && typeof rv === 'object') ? itp.guard(rv, line, 'operand') : rv;
      if (typeof l === 'number' && typeof r === 'number') return fast(l, r);
      return itp.binary(op, l, r, line);
    };
  }
  return (itp) => {
    const lv = left(itp);
    const l = (lv !== null && typeof lv === 'object') ? itp.guard(lv, line, 'operand') : lv;
    const rv = right(itp);
    const r = (rv !== null && typeof rv === 'object') ? itp.guard(rv, line, 'operand') : rv;
    return itp.binary(op, l, r, line);
  };
}

function buildCall(node) {
  const line = node.line;
  const argNodes = node.args.map(compileExpr);
  const n = argNodes.length;
  const name = node.callee.type === 'Ident' ? node.callee.name
    : node.callee.type === 'Member' ? node.callee.name
    : 'this value';

  // `old(x)` is a reference to the pre-state, not a call. Detected once.
  const isOld = node.callee.type === 'Ident' && node.callee.name === 'old';
  if (isOld) return (itp) => itp.evalCall(node);

  const callee = compileExpr(node.callee);

  // An argument that is a primitive cannot carry a label, so `guard` would hand
  // it straight back. See the note above `isSignal`.
  const arg = (itp, i) => {
    const v = argNodes[i](itp);
    return (v === null || typeof v !== 'object') ? v : itp.guard(v, line, 'argument');
  };

  // The general path: build an array, hand it to the general machinery.
  const slow = (itp, fn) => {
    const transparent = fn instanceof NativeFunction && fn.transparent;
    const args = new Array(n);
    for (let i = 0; i < n; i++) {
      const v = argNodes[i](itp);
      args[i] = (transparent || v === null || typeof v !== 'object')
        ? v : itp.guard(v, line, 'argument');
    }
    return itp.callValue(fn, args, line, name);
  };

  // Beyond four arguments the array has to be built anyway, so there is nothing
  // to specialise.
  if (n > 4) {
    return (itp) => slow(itp, unwrap(callee(itp)));
  }

  // An inline cache on the callee.
  //
  // Nearly every call site calls the same function every time. Whether that
  // function can take the fast path -- a named function with no capabilities,
  // no contract, and a frame nothing can capture -- is decided once and
  // remembered, so a repeat call skips the whole dispatch. Arguments stay in
  // JavaScript locals and go across positionally, so no array is built either:
  // a call in this shape allocates nothing at all.
  //
  // The cache is checked by identity. A different callee, or one that cannot
  // take the fast path, falls through to the general machinery unchanged.
  // Both answers are cached, not just the affirmative one. A site that always
  // calls a builtin or a record constructor would otherwise ask the same
  // question on every call and always get the same no.
  let cachedFn = null;
  let cachedSimple = false;
  return (itp) => {
    const fn = unwrap(callee(itp));
    if (fn !== cachedFn) {
      cachedFn = fn;
      // The instanceof is inline so that a site which always calls a builtin
      // or a record constructor settles it without a method call.
      cachedSimple = fn instanceof PedagFunction && itp.canCallSimple(fn);
    }
    // `profiling` is checked here rather than trusted from the cache: it is one
    // boolean load, and it can be switched on between calls.
    if (!cachedSimple || itp.profiling) return slow(itp, fn);
    // Every argument is evaluated before any of them is bound, because
    // evaluating one can itself call this same function.
    if (n === 0) return itp.callSimple(fn, line, 0);
    if (n === 1) return itp.callSimple(fn, line, 1, arg(itp, 0));
    if (n === 2) {
      const a0 = arg(itp, 0);
      const a1 = arg(itp, 1);
      return itp.callSimple(fn, line, 2, a0, a1);
    }
    if (n === 3) {
      const a0 = arg(itp, 0);
      const a1 = arg(itp, 1);
      const a2 = arg(itp, 2);
      return itp.callSimple(fn, line, 3, a0, a1, a2);
    }
    const a0 = arg(itp, 0);
    const a1 = arg(itp, 1);
    const a2 = arg(itp, 2);
    const a3 = arg(itp, 3);
    return itp.callSimple(fn, line, 4, a0, a1, a2, a3);
  };
}

// --- statements ---------------------------------------------------------------

function buildStmt(node) {
  switch (node.type) {
    case 'ExprStmt': {
      const expr = compileExpr(node.expr);
      return (itp) => { { if (++itp.steps > itp.tickCheck) itp.tickDue(node); }; return expr(itp); };
    }

    case 'Return': {
      const value = node.value ? compileExpr(node.value) : null;
      const line = node.line;
      return value
        ? (itp) => { { if (++itp.steps > itp.tickCheck) itp.tickDue(node); }; itp.retval = value(itp); itp.sigLine = line; return SIG_RETURN; }
        : (itp) => { { if (++itp.steps > itp.tickCheck) itp.tickDue(node); }; itp.retval = null; itp.sigLine = line; return SIG_RETURN; };
    }

    case 'Break': {
      const line = node.line;
      return (itp) => { { if (++itp.steps > itp.tickCheck) itp.tickDue(node); }; itp.sigLine = line; return SIG_BREAK; };
    }
    case 'Continue': {
      const line = node.line;
      return (itp) => { { if (++itp.steps > itp.tickCheck) itp.tickDue(node); }; itp.sigLine = line; return SIG_CONTINUE; };
    }

    case 'Declare': {
      const value = compileExpr(node.value);
      const name = node.name;
      const mutable = node.mutable;
      const line = node.line;
      return (itp) => {
        { if (++itp.steps > itp.tickCheck) itp.tickDue(node); };
        const v = value(itp);
        // `let` freezes what it binds; a primitive has nothing to freeze.
        if (!mutable && v !== null && typeof v === 'object') freezeDeep(v);
        itp.redeclareIfAllowed(name);
        itp.env.declare(name, v, mutable, line);
        return null;
      };
    }

    case 'FnDecl': {
      const name = node.fn.name;
      const line = node.line;
      return (itp) => {
        { if (++itp.steps > itp.tickCheck) itp.tickDue(node); };
        const fn = new PedagFunction(node.fn, itp.env);
        itp.redeclareIfAllowed(name);
        itp.env.declare(name, fn, false, line);
        itp.graph.define(name, node.fn);
        return null;
      };
    }

    case 'If': {
      const test = compileExpr(node.test);
      const then = compileBlock(node.then);
      const line = node.line;
      const alt = node.alt
        ? (node.alt.type === 'Block' ? compileBlock(node.alt) : compileStmt(node.alt))
        : null;
      const thenScoped = scoper(node.then);
      const altScoped = node.alt && node.alt.type === 'Block' ? scoper(node.alt) : null;
      return (itp) => {
        { if (++itp.steps > itp.tickCheck) itp.tickDue(node); };
        if (truthy(itp.guard(test(itp), line, 'condition'))) {
          return runScoped(itp, then, thenScoped);
        }
        if (alt) {
          return altScoped ? runScoped(itp, alt, altScoped) : alt(itp);
        }
        return null;
      };
    }

    case 'Block': {
      const body = compileBlock(node);
      const scoped = scoper(node);
      return (itp) => { { if (++itp.steps > itp.tickCheck) itp.tickDue(node); }; return runScoped(itp, body, scoped); };
    }

    case 'While': return buildWhile(node);
    case 'For': return buildFor(node);

    default: {
      // Not compiled. Run it on the tree-walker, and translate the exceptions it
      // uses for control flow back into this protocol so the two halves agree.
      // Statements that cannot contain a return, break or continue skip the
      // try/catch entirely -- that is most of them, and try/catch is not free.
      // The value `exec` returns is part of the contract: at the top level a
      // program's result is its last statement's value whatever kind it is, so
      // a trailing `atomic { n = n + 1 }` evaluates to 1. Discarding it here
      // made the compiled engine return nil for those programs.
      if (!mayTransferControl(node)) {
        return (itp) => itp.exec(node);
      }
      return (itp) => {
        try {
          return itp.exec(node);
        } catch (e) {
          if (e instanceof ReturnSignal) { itp.retval = e.value; itp.sigLine = e.line; return SIG_RETURN; }
          if (e instanceof BreakSignal) { itp.sigLine = e.line; return SIG_BREAK; }
          if (e instanceof ContinueSignal) { itp.sigLine = e.line; return SIG_CONTINUE; }
          throw e;
        }
      };
    }
  }
}

// Does this subtree contain a `return`, `break` or `continue` that could escape
// it? A function body in the way stops the search: a return inside a nested
// function belongs to that function, not to this statement.
function mayTransferControl(node) {
  if (node === null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(mayTransferControl);
  if (node.type === 'Return' || node.type === 'Break' || node.type === 'Continue') return true;
  if (node.type === 'Fn' || node.type === 'FnDecl' || node.type === 'AgentDecl') return false;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type' || k === 'line' || k === 'span') continue;
    if (v && typeof v === 'object' && mayTransferControl(v)) return true;
  }
  return false;
}

// --- blocks and scopes ---------------------------------------------------------

// Mirrors Interpreter.blockBinds / scopeFor: a block only needs an Env of its
// own if it actually binds a name. Deciding that here means the check does not
// run again on every pass through the block.
function scoper(block) {
  return block.body.some((s) => s.type === 'Declare' || s.type === 'FnDecl'
    || s.type === 'AgentDecl' || s.type === 'Import');
}

function runScoped(itp, body, needsScope) {
  if (!needsScope) return body(itp);
  const saved = itp.env;
  itp.env = new Env(saved);
  try {
    return body(itp);
  } finally {
    itp.env = saved;
  }
}

// A compiled block runs its statements in order and stops at the first signal.
//
// What the block evaluates to depends on where it is, and the two rules differ
// in the tree-walker, so they differ here too. `execBlock` keeps only the last
// *expression statement's* value and nils out anything else. `run` keeps the
// last statement's value whatever kind it was, which is why a program ending in
// `atomic { n = n + 1 }` evaluates to 1 rather than nil.
export function compileBlock(block, keepAll = false) {
  const stmts = block.body.map(compileStmt);
  const isExpr = block.body.map((s) => s.type === 'ExprStmt');
  const n = stmts.length;

  if (n === 0) return () => null;
  if (n === 1) {
    const only = stmts[0];
    const one = keepAll || isExpr[0];
    return (itp) => {
      const v = only(itp);
      if (isSignal(v)) return v;
      return one ? v : null;
    };
  }
  return (itp) => {
    let last = null;
    for (let i = 0; i < n; i++) {
      const v = stmts[i](itp);
      if (isSignal(v)) return v;
      last = (keepAll || isExpr[i]) ? v : null;
    }
    return last;
  };
}

// --- loops -----------------------------------------------------------------

function buildWhile(node) {
  const test = compileExpr(node.test);
  const body = compileBlock(node.body);
  const line = node.line;
  const binds = scoper(node.body);
  const contracted = node.invariants.length > 0 || node.variant != null;

  return (itp) => {
    { if (++itp.steps > itp.tickCheck) itp.tickDue(node); };
    // A body that makes closures needs a fresh scope per pass, or every closure
    // captures the same cell. Same rule as the tree-walker.
    const fresh = itp.capturesScope(node.body);
    const shared = !fresh && binds ? new Env(itp.env) : null;
    const loop = contracted ? itp.beginLoopContracts(node) : null;

    // One try/finally around the whole loop rather than one per pass. It
    // restores exactly the same scope either way -- an exception leaves through
    // this frame once, not once per iteration -- and setting up an exception
    // handler two million times was most of what a counting loop cost.
    const saved = itp.env;
    try {
      while (truthy(itp.guard(test(itp), line, 'condition'))) {
        { if (++itp.steps > itp.tickCheck) itp.tickDue(node); };
        if (contracted) itp.stepLoopContracts(node, loop);
        if (fresh) itp.env = new Env(saved);
        else if (binds) { shared.clearVars(); itp.env = shared; }
        const out = body(itp);
        // The test runs in the enclosing scope, not the body's.
        itp.env = saved;
        if (out === SIG_BREAK) break;
        if (out === SIG_RETURN) return SIG_RETURN;
        // SIG_CONTINUE and normal completion both fall through to the next pass.
        if (contracted) itp.checkLoopInvariants(node, 'after a pass');
      }
    } finally {
      itp.env = saved;
    }
    return null;
  };
}

// `for i in range(n)` is the most written loop in any language, and until now
// it allocated. `range` is an ordinary builtin that returns a list, so
// `range(2000000)` built a two-million-element JavaScript array -- tens of
// megabytes and a GC bill -- before the first iteration ran.
//
// When the loop subject is literally a call to `range`, the list is a pure
// intermediate: nothing can observe it, because the loop consumes it and throws
// it away. So it is not built. The loop counts instead.
//
// Two things keep this honest. `range` is a normal binding a program may shadow
// or redefine, so the identity of what the name resolves to is checked on every
// entry, and anything unexpected takes the ordinary path. And the argument
// validation below is a copy of the builtin's, so a bad call fails with exactly
// the same error it would have.
function countedRange(node) {
  const call = node.iter;
  if (!call || call.type !== 'Call') return null;
  if (!call.callee || call.callee.type !== 'Ident' || call.callee.name !== 'range') return null;
  if (call.args.length < 1 || call.args.length > 3) return null;
  return call.args.map(compileExpr);
}

function buildFor(node) {
  const rangeArgs = countedRange(node);
  const iter = compileExpr(node.iter);
  const body = compileBlock(node.body);
  const name = node.name;
  const line = node.line;
  const binds = scoper(node.body);
  const contracted = node.invariants.length > 0 || node.variant != null;

  return (itp) => {
    { if (++itp.steps > itp.tickCheck) itp.tickDue(node); };

    // The counted path: no list is built, the loop counts. Only taken when the
    // name `range` still means the builtin.
    let counted = null;
    if (rangeArgs !== null && itp.env.slot('range') === itp.prelude.own('range')) {
      const a = new Array(rangeArgs.length);
      for (let i = 0; i < rangeArgs.length; i++) a[i] = unwrap(rangeArgs[i](itp));
      // Exactly the builtin's validation, so a bad call fails identically.
      const start = a.length === 1 ? 0 : itp.asNumber(a[0], 'a range start', line);
      const stop = a.length === 1 ? itp.asNumber(a[0], 'a range end', line)
        : itp.asNumber(a[1], 'a range end', line);
      const step = a.length === 3 ? itp.asNumber(a[2], 'a range step', line) : 1;
      if (step === 0) throw pedagError('ValueError', 'range step cannot be 0', line);
      counted = { start, stop, step };
    }

    const fresh = itp.capturesScope(node.body);
    let shared = null;
    let slot = null;
    if (!fresh) {
      shared = new Env(itp.env);
      shared.declare(name, null, false, line);
      slot = shared.own(name);
    }
    const loop = contracted ? itp.beginLoopContracts(node) : null;

    // One handler for the whole loop, not one per item -- see buildWhile.
    const saved = itp.env;

    // The two loops are written out separately rather than sharing one body
    // behind an iterator. A generator would have been tidier and would have
    // undone the point of this: `yield` allocates a result object per step, so
    // counting through one still costs an allocation per iteration -- which is
    // what building the list cost in the first place.
    try {
      if (counted !== null) {
        const { start, stop, step } = counted;
        for (let v = start; step > 0 ? v < stop : v > stop; v += step) {
          { if (++itp.steps > itp.tickCheck) itp.tickDue(node); };
          if (fresh) {
            itp.env = new Env(saved);
            itp.env.declare(name, v, false, line);
          } else {
            if (binds) { shared.clearVars(); shared.putSlot(name, slot); }
            slot.value = v;
            itp.env = shared;
          }
          if (contracted) itp.stepLoopContracts(node, loop);
          const out = body(itp);
          itp.env = saved;
          if (out === SIG_BREAK) break;
          if (out === SIG_RETURN) return SIG_RETURN;
          if (contracted) itp.checkLoopInvariants(node, 'after a pass');
        }
        return null;
      }

      const iterable = itp.guard(iter(itp), line, 'loop subject');
      for (const item of itp.toIterable(iterable, line)) {
        { if (++itp.steps > itp.tickCheck) itp.tickDue(node); };
        if (fresh) {
          itp.env = new Env(saved);
          itp.env.declare(name, item, false, line);
        } else {
          if (binds) { shared.clearVars(); shared.putSlot(name, slot); }
          slot.value = item;
          itp.env = shared;
        }
        if (contracted) itp.stepLoopContracts(node, loop);
        const out = body(itp);
        itp.env = saved;
        if (out === SIG_BREAK) break;
        if (out === SIG_RETURN) return SIG_RETURN;
        if (contracted) itp.checkLoopInvariants(node, 'after a pass');
      }
    } finally {
      itp.env = saved;
    }
    return null;
  };
}

// --- the entry point the interpreter calls ----------------------------------

// Run a function body. Returns the function's result. This is where the
// sentinel protocol is converted back into an ordinary value, so nothing
// outside compiled code ever sees a signal.
export function runBody(itp, decl, env) {
  const body = decl[STMT] ?? (decl[STMT] = compileBlock(decl.body));
  const saved = itp.env;
  itp.env = env;
  try {
    const out = body(itp);
    if (out === SIG_RETURN) {
      const v = itp.retval;
      itp.retval = null;
      return v;
    }
    // `break` or `continue` that found no loop inside the function body. The
    // interpreter turns these into a ControlFlowError at the call boundary;
    // rethrowing the signal lets that same code handle it, so both engines
    // produce the identical error.
    if (out === SIG_BREAK) throw new BreakSignal(itp.sigLine);
    if (out === SIG_CONTINUE) throw new ContinueSignal(itp.sigLine);
    return null;
  } finally {
    itp.env = saved;
  }
}

// Run a whole program body at the top level, where every statement's value
// counts -- see compileBlock.
export function runProgram(itp, program) {
  const body = program[STMT] ?? (program[STMT] = compileBlock(program, true));
  const out = body(itp);
  if (out === SIG_RETURN) throw new ReturnSignal(itp.retval, itp.sigLine);
  if (out === SIG_BREAK) throw new BreakSignal(itp.sigLine);
  if (out === SIG_CONTINUE) throw new ContinueSignal(itp.sigLine);
  return out;
}
