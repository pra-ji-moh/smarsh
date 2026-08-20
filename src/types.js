import { Diagnostic, closestName } from './diagnostics.js';

// A gradual type system.
//
// The design follows Siek and Taha: there is a type `dyn` for "not known
// statically", and instead of type *equality* the checker uses a *consistency*
// relation, under which `dyn` is consistent with everything. That single choice
// is what makes annotations optional rather than viral -- a program with no
// annotations at all has every expression at `dyn`, is consistent everywhere,
// and reports nothing.
//
// Where you do annotate, you are held to it, and the errors arrive before the
// program runs:
//
//     fn area(w: num, h: num) -> num { return w * h }
//     area("3", 4)
//
//     error[E0301]: expected `num`, found `str`
//
// Inference is local and bidirectional, not full Hindley-Milner: literals,
// operators, list and map literals, `let` initialisers and function returns all
// propagate types upward, and annotations flow down. There is no let-generalised
// polymorphism and no unification across statements. That is a real limitation,
// and it is chosen deliberately: the failure mode of local inference is *not
// noticing* a bug, while the failure mode of aggressive inference is reporting
// one that is not there. In a gradual system the second is much worse.

export const DYN = { k: 'dyn' };
export const NUM = { k: 'prim', name: 'num' };
export const STR = { k: 'prim', name: 'str' };
export const BOOL = { k: 'prim', name: 'bool' };
export const NIL = { k: 'prim', name: 'nil' };
export const TENSOR = { k: 'prim', name: 'tensor' };

export const listOf = (of) => ({ k: 'list', of });
export const mapOf = (of) => ({ k: 'map', of });
export const fnType = (params, ret) => ({ k: 'fn', params, ret });
export const named = (name) => ({ k: 'named', name });

export const DEC = { k: 'prim', name: 'dec' };

const PRIMS = { num: NUM, str: STR, bool: BOOL, nil: NIL, tensor: TENSOR, dec: DEC, dyn: DYN, any: DYN };

// Runtime types that have no literal syntax but can be named in an annotation.
const NAMED = new Set([
  'context', 'ledger', 'agent', 'agent_template', 'cipher', 'paillier_key',
  'zk_proof', 'commitment', 'group_element', 'keypair', 'lineage', 'secret',
  'qubits', 'clock', 'stamp', 'liquid', 'schema', 'arena', 'weights',
]);

export function show(t) {
  if (!t) return 'dyn';
  switch (t.k) {
    case 'dyn': return 'dyn';
    case 'prim': return t.name;
    case 'named': return t.name;
    case 'list': return `list<${show(t.of)}>`;
    case 'map': return `map<${show(t.of)}>`;
    case 'fn': return `fn(${t.params.map(show).join(', ')}) -> ${show(t.ret)}`;
    default: return 'dyn';
  }
}

export const isDyn = (t) => !t || t.k === 'dyn';

// Consistency, not equality. `dyn ~ T` for every T, and that is the whole
// mechanism behind gradual typing.
export function consistent(a, b) {
  if (isDyn(a) || isDyn(b)) return true;
  if (a.k !== b.k) return false;
  switch (a.k) {
    case 'prim': return a.name === b.name;
    case 'named': return a.name === b.name;
    case 'list':
    case 'map': return consistent(a.of, b.of);
    case 'fn':
      return a.params.length === b.params.length
        && a.params.every((p, i) => consistent(p, b.params[i]))
        && consistent(a.ret, b.ret);
    default: return true;
  }
}

// The most specific type that describes both, falling back to `dyn`. Used for
// list literals and for functions that return from several places.
export function join(a, b) {
  if (isDyn(a) || isDyn(b)) return DYN;
  if (consistent(a, b)) {
    if (a.k === 'list') return listOf(join(a.of, b.of));
    if (a.k === 'map') return mapOf(join(a.of, b.of));
    return a;
  }
  // A nil arm does not poison the type; it makes it optional, which this
  // system models as dyn rather than growing a null-tracking layer.
  if (a === NIL) return b;
  if (b === NIL) return a;
  return DYN;
}

export function fromAnnotation(node, report) {
  if (!node) return DYN;
  if (node.kind === 'fn') {
    return fnType(node.params.map((p) => fromAnnotation(p, report)), fromAnnotation(node.ret, report));
  }
  const { name, args } = node;
  if (name === 'list') return listOf(args.length ? fromAnnotation(args[0], report) : DYN);
  if (name === 'map') return mapOf(args.length ? fromAnnotation(args[0], report) : DYN);
  if (PRIMS[name]) return PRIMS[name];
  if (NAMED.has(name)) return named(name);
  if (report) {
    const near = closestName(name, [...Object.keys(PRIMS), 'list', 'map', ...NAMED]);
    report({
      code: 'E0301',
      message: `unknown type \`${name}\``,
      span: node.span,
      label: 'not a type',
      helps: near ? [`there is a type with a similar spelling: \`${near}\``] : [],
    });
  }
  return DYN;
}

// ---------------------------------------------------------------------------
// Builtin signatures
// ---------------------------------------------------------------------------
//
// Only builtins whose types are genuinely fixed are listed. Anything variadic
// or genuinely polymorphic is left at `dyn` rather than given a type that is
// nearly right -- a wrong signature produces false errors, which is the one
// thing a gradual checker must not do.

const B = {
  // numbers in, number out
  sqrt: fnType([NUM], NUM),
  abs: fnType([NUM], NUM),
  floor: fnType([NUM], NUM),
  ceil: fnType([NUM], NUM),
  round: fnType([NUM], NUM),
  signum: fnType([NUM], NUM),
  exp: fnType([NUM], NUM),
  sin: fnType([NUM], NUM),
  cos: fnType([NUM], NUM),
  tan: fnType([NUM], NUM),
  clamp: fnType([NUM, NUM, NUM], NUM),
  randint: fnType([NUM, NUM], NUM),
  random: fnType([], NUM),
  time: fnType([], NUM),
  advance: fnType([NUM], NUM),

  // text
  dec: fnType([DYN], DEC),
  dec_sum: fnType([listOf(DEC)], DEC),
  is_dec: fnType([DYN], BOOL),
  sha256: fnType([DYN], STR),
  str: fnType([DYN], STR),
  num: fnType([DYN], NUM),
  type: fnType([DYN], STR),
  tokens: fnType([DYN], NUM),
  distill: fnType([DYN], STR),

  // collections and containers
  len: fnType([DYN], NUM),
  range: fnType([NUM], listOf(NUM)),
  sample: fnType([listOf(DYN)], DYN),
  shuffle: fnType([listOf(DYN)], listOf(DYN)),
  labels: fnType([DYN], listOf(STR)),
  is_tainted: fnType([DYN], BOOL),
  caps: fnType([], listOf(STR)),
  context: fnType([NUM], named('context')),
  ledger: fnType([DYN], named('ledger')),
  clock: fnType([DYN], named('clock')),
  arena: fnType([NUM], named('arena')),

  // tensors
  zeros: fnType([DYN], TENSOR),
  ones: fnType([DYN], TENSOR),
  eye: fnType([NUM], TENSOR),
  arange: fnType([NUM], TENSOR),
  randn: fnType([DYN], TENSOR),
  relu: fnType([DYN], TENSOR),
  sigmoid: fnType([DYN], TENSOR),
  tanh: fnType([DYN], TENSOR),
  softmax: fnType([DYN], TENSOR),
  argmax: fnType([DYN], NUM),
  dot: fnType([DYN, DYN], NUM),
  cosine: fnType([DYN, DYN], NUM),

  // crypto and friends
  paillier_keygen: fnType([NUM], named('paillier_key')),
  encrypt: fnType([named('paillier_key'), NUM], named('cipher')),
  decrypt: fnType([named('paillier_key'), named('cipher')], NUM),
  zk_verify: fnType([named('group_element'), named('zk_proof')], BOOL),
  commit: fnType([NUM, NUM], named('commitment')),
  commit_open: fnType([named('commitment'), NUM, NUM], BOOL),
  keypair: fnType([], named('keypair')),
  sign: fnType([named('keypair'), DYN], STR),
  verify_signature: fnType([STR, DYN, STR], BOOL),
  secret_of: fnType([DYN], named('secret')),
  random_secret: fnType([NUM], named('secret')),
  reveal: fnType([named('secret')], STR),

  // quantum
  qubits: fnType([NUM], named('qubits')),
  measure: fnType([named('qubits'), NUM], NUM),
  measure_all: fnType([named('qubits')], listOf(NUM)),
  probabilities: fnType([named('qubits')], listOf(NUM)),

  // agents and time
  before: fnType([named('stamp'), named('stamp')], BOOL),
  liquid: fnType([NUM, NUM], named('liquid')),
  pending: fnType([], NUM),
  scheduled: fnType([], NUM),
  run_agents: fnType([], NUM),

  // effects
  read: fnType([STR], STR),
  write: fnType([STR, DYN], BOOL),
  now: fnType([], NUM),

  // lifecycle
  versions: fnType([STR], NUM),
  callers: fnType([STR], listOf(STR)),
  dependents: fnType([STR], listOf(STR)),
  rollback: fnType([STR], NUM),
  snapshot: fnType([], STR),
  restore: fnType([STR], NUM),
  watch: fnType([], NUM),
};

// Member types that are worth knowing statically. Everything unlisted is dyn.
const MEMBERS = {
  tensor: { shape: listOf(NUM), rank: NUM, size: NUM, T: TENSOR },
  str: { },
  context: { tokens: NUM, budget: NUM, evicted: NUM },
  ledger: { head: STR },
  liquid: { initial: NUM, halflife: NUM, anchor: NUM, value: NUM },
  stamp: { counter: NUM, node: STR },
  clock: { node: STR, counter: NUM },
  qubits: { n: NUM, gates: NUM },
  secret: { shredded: BOOL },
  keypair: { public: STR, can_sign: BOOL },
  agent: { id: NUM, name: STR, stopped: BOOL },
  arena: { budget: NUM, resident: NUM, held: NUM, spilled: NUM, restored: NUM },
  weights: { shape: listOf(NUM), dtype: STR, bytes: NUM, resident: NUM, reads: NUM, hits: NUM },
  schema: { name: STR, fields: listOf(STR), required: listOf(STR) },
  lineage: { head: STR, signer: STR },
  paillier_key: { bits: NUM, can_decrypt: BOOL },
  cipher: { bits: NUM },
};

// ---------------------------------------------------------------------------
// The checker
// ---------------------------------------------------------------------------

class Scope {
  constructor(parent = null) {
    this.names = new Map();     // name -> { type, mutable }
    this.parent = parent;
  }
  declare(name, type, mutable) { this.names.set(name, { type, mutable }); }
  lookup(name) {
    let s = this;
    while (s) {
      const hit = s.names.get(name);
      if (hit) return hit;
      s = s.parent;
    }
    return null;
  }
  allNames(out = new Set()) {
    for (const k of this.names.keys()) out.add(k);
    return this.parent ? this.parent.allNames(out) : out;
  }
}

export class Checker {
  constructor({ builtins = [] } = {}) {
    this.diagnostics = [];
    this.global = new Scope();
    this.scope = this.global;
    this.returnStack = [];
    this.records = new Map();   // record name -> { fields, types }
    // Builtin names the runtime will provide, so the checker does not report
    // them as undefined. Typed ones get their signature; the rest are dyn.
    for (const name of builtins) {
      this.global.declare(name, B[name] ?? DYN, false);
    }
    this.knownBuiltins = new Set(builtins);
  }

  report({ code = 'E0301', message, span, label, helps = [], notes = [], severity = 'error' }) {
    // One message per problem. Annotations get resolved more than once -- a
    // function signature is read when hoisting, when declaring and when
    // checking the body -- and a reader should not be told three times that
    // one type name is misspelled.
    const key = `${code}|${message}|${span ? span[0] : '?'}`;
    if (this.seen === undefined) this.seen = new Set();
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.diagnostics.push(new Diagnostic({ code, message, span, label, helps, notes, severity }));
  }

  ann(node) { return fromAnnotation(node, (d) => this.report(d)); }

  push() { this.scope = new Scope(this.scope); }
  pop() { this.scope = this.scope.parent; }

  check(program) {
    // Hoist function and agent declarations so order of definition does not
    // matter, the way it does not matter at runtime.
    this.hoist(program.body);
    for (const stmt of program.body) this.statement(stmt);
    return this.diagnostics;
  }

  hoist(body) {
    for (const stmt of body) {
      if (stmt.type === 'FnDecl') this.scope.declare(stmt.fn.name, this.signatureOf(stmt.fn), false);
      else if (stmt.type === 'AgentDecl') this.scope.declare(stmt.name, named('agent_template'), false);
      else if (stmt.type === 'RecordDecl') {
        // The constructor's type: its fields in, one of itself out.
        const fieldTypes = (stmt.fieldTypes ?? stmt.fields.map(() => null)).map((t) => this.ann(t));
        this.scope.declare(stmt.name, fnType(fieldTypes, named(stmt.name)), false);
        this.records.set(stmt.name, { fields: stmt.fields, types: fieldTypes });
      }
      else if (stmt.type === 'ChoiceDecl') {
        // The choice's own name, then each of its variants. A variant carrying
        // fields is a constructor like any record; one carrying nothing is a
        // value of the type, because there is only ever one of it.
        this.scope.declare(stmt.name, named('choice_type'), false);
        for (const v of stmt.variants) {
          const fieldTypes = (v.fieldTypes ?? v.fields.map(() => null)).map((t) => this.ann(t));
          this.scope.declare(
            v.name,
            v.fields.length === 0 ? named(v.name) : fnType(fieldTypes, named(v.name)),
            false,
          );
          this.records.set(v.name, { fields: v.fields, types: fieldTypes });
        }
      }
      else if (stmt.type === 'Import') this.importUnknown = true;
    }
  }

  signatureOf(fn) {
    const params = (fn.paramTypes ?? fn.params.map(() => null)).map((t) => this.ann(t));
    return fnType(params, this.ann(fn.returnType));
  }

  // --- statements ----------------------------------------------------------

  statement(node) {
    switch (node.type) {
      case 'Declare': {
        const declared = node.declared ? this.ann(node.declared) : null;
        const actual = this.expr(node.value);
        if (declared && !consistent(declared, actual)) {
          this.mismatch(declared, actual, node.value.span ?? node.span,
            `\`${node.name}\` is declared \`${show(declared)}\``);
        }
        // An unannotated `let` takes the initialiser's type; `nil` stays open,
        // because `var x = nil` is how people write "not yet".
        const type = declared ?? (actual === NIL ? DYN : actual);
        this.scope.declare(node.name, type, node.mutable);
        return;
      }

      case 'FnDecl':
        this.scope.declare(node.fn.name, this.signatureOf(node.fn), false);
        this.functionBody(node.fn);
        return;

      case 'Redefine':
        if (node.kind === 'fn') this.functionBody(node.fn);
        return;

      case 'ExprStmt': this.expr(node.expr); return;

      case 'If':
        this.expr(node.test);
        this.block(node.then);
        if (node.alt) (node.alt.type === 'Block' ? this.block(node.alt) : this.statement(node.alt));
        return;

      case 'While':
        this.expr(node.test);
        this.block(node.body);
        return;

      case 'For': {
        const over = this.expr(node.iter);
        this.push();
        this.scope.declare(node.name, over && over.k === 'list' ? over.of : DYN, false);
        this.blockInScope(node.body);
        this.pop();
        return;
      }

      case 'Return': {
        const actual = node.value ? this.expr(node.value) : NIL;
        const expected = this.returnStack[this.returnStack.length - 1];
        if (expected && expected.declared && !consistent(expected.declared, actual)) {
          this.mismatch(expected.declared, actual, node.value?.span ?? node.span,
            `\`${expected.name}\` promises \`${show(expected.declared)}\``);
        }
        if (expected) expected.seen.push(actual);
        return;
      }

      case 'Block': this.block(node); return;

      case 'Maybe':
        this.expr(node.prob);
        this.block(node.then);
        if (node.alt) (node.alt.type === 'Block' ? this.block(node.alt) : this.statement(node.alt));
        return;

      case 'Attempt':
        this.block(node.body);
        this.push();
        this.scope.declare(node.name, mapOf(DYN), false);
        this.blockInScope(node.handler);
        this.pop();
        return;

      case 'Grounded':
      case 'Region':
      case 'Atomic':
      case 'Secret':
        this.block(node.body);
        return;

      case 'Budget':
        this.expr(node.amount);
        this.block(node.body);
        return;

      case 'Device':
        this.expr(node.target);
        if (node.threads) this.expr(node.threads);
        this.block(node.body);
        return;

      case 'AgentDecl': {
        this.scope.declare(node.name, named('agent_template'), false);
        this.push();
        for (const p of node.params) this.scope.declare(p, DYN, false);
        for (const s of node.stateDecls) this.statement(s);
        for (const handler of node.handlers.values()) {
          this.push();
          for (const p of handler.params) this.scope.declare(p, DYN, false);
          this.scope.declare('self', named('agent'), false);
          this.scope.declare('sender', DYN, false);
          this.blockInScope(handler.body);
          this.pop();
        }
        this.pop();
        return;
      }

      // An import brings in names this pass cannot see, so from here on the
      // checker stops reporting unknown names rather than reporting nonsense.
      case 'RecordDecl':
      case 'ChoiceDecl':
        return;   // handled when hoisting, so order of declaration is free

      case 'Import':
        this.importUnknown = true;
        if (node.alias) this.scope.declare(node.alias, mapOf(DYN), false);
        return;

      case 'Break':
      case 'Continue':
        return;

      default:
        return;
    }
  }

  block(node) {
    this.push();
    this.blockInScope(node);
    this.pop();
  }

  blockInScope(node) {
    this.hoist(node.body);
    for (const stmt of node.body) this.statement(stmt);
  }

  functionBody(fn) {
    const declared = fn.returnType ? this.ann(fn.returnType) : null;
    this.push();
    const paramTypes = fn.paramTypes ?? fn.params.map(() => null);
    fn.params.forEach((p, i) => this.scope.declare(p, this.ann(paramTypes[i]), false));
    this.returnStack.push({ name: fn.name ?? 'this function', declared, seen: [] });
    this.blockInScope(fn.body);
    this.returnStack.pop();
    this.pop();
  }

  // --- expressions ---------------------------------------------------------

  expr(node) {
    if (!node) return DYN;
    switch (node.type) {
      case 'Num': return NUM;
      case 'DecLit': return DEC;
      case 'Str': return STR;
      case 'Bool': return BOOL;
      case 'Nil': return NIL;

      case 'Ident': {
        const found = this.scope.lookup(node.name);
        if (found) return found.type;
        if (!this.importUnknown && !this.knownBuiltins.has(node.name)) {
          const near = closestName(node.name, this.scope.allNames());
          this.report({
            code: 'E0201',
            message: `\`${node.name}\` is not defined`,
            span: node.span,
            label: 'not found in this scope',
            helps: near ? [`there is a name with a similar spelling: \`${near}\``] : [],
          });
        }
        return DYN;
      }

      case 'ListLit': {
        if (node.elements.length === 0) return listOf(DYN);
        return listOf(node.elements.map((e) => this.expr(e)).reduce(join));
      }

      case 'MapLit': {
        for (const { key } of node.entries) if (key.type !== 'Str') this.expr(key);
        if (node.entries.length === 0) return mapOf(DYN);
        return mapOf(node.entries.map((e) => this.expr(e.value)).reduce(join));
      }

      case 'TensorLit': this.expr(node.value); return TENSOR;

      case 'Fn': {
        this.functionBody(node);
        return this.signatureOf(node);
      }

      case 'Unary': {
        const t = this.expr(node.operand);
        if (node.op === 'not') return BOOL;
        if (!isDyn(t) && t !== NUM && t !== TENSOR) {
          this.mismatch(NUM, t, node.operand.span ?? node.span, 'cannot be negated');
        }
        return t === TENSOR ? TENSOR : NUM;
      }

      case 'Logical':
        this.expr(node.left);
        this.expr(node.right);
        return BOOL;

      case 'Binary': return this.binary(node);

      case 'Assign': {
        const value = this.expr(node.value);
        if (node.target.type === 'Ident') {
          const slot = this.scope.lookup(node.target.name);
          if (slot) {
            if (!slot.mutable) {
              this.report({
                code: 'E0203',
                message: `\`${node.target.name}\` was declared with \`let\` and cannot be reassigned`,
                span: node.span,
                label: 'cannot assign twice',
                helps: [`declare it with \`var\` if it has to change`],
              });
            } else if (!consistent(slot.type, value)) {
              this.mismatch(slot.type, value, node.value.span ?? node.span,
                `\`${node.target.name}\` holds \`${show(slot.type)}\``);
            }
          } else {
            this.expr(node.target);
          }
        } else {
          this.expr(node.target);
        }
        return value;
      }

      case 'Call': return this.call(node);

      case 'Index': {
        const obj = this.expr(node.object);
        for (const i of node.indices) this.expr(i);
        if (obj && obj.k === 'list') return obj.of;
        if (obj && obj.k === 'map') return obj.of;
        if (obj === STR) return STR;
        if (obj === TENSOR) return NUM;
        return DYN;
      }

      case 'Member': {
        const obj = this.expr(node.object);
        const table = obj && (obj.k === 'named' || obj.k === 'prim') ? MEMBERS[obj.name] : null;
        if (table && Object.prototype.hasOwnProperty.call(table, node.name)) return table[node.name];
        return DYN;
      }

      case 'Template': {
        for (const part of node.parts) if (part.kind === 'expr') this.expr(part.expr);
        return STR;
      }

      case 'Match': {
        this.expr(node.subject);
        let result = null;
        for (const arm of node.arms) {
          this.push();
          this.bindPattern(arm.pattern);
          if (arm.guard) this.expr(arm.guard);
          const armType = this.expr(arm.body);
          this.pop();
          result = result === null ? armType : join(result, armType);
        }
        return result ?? DYN;
      }

      case 'Choose': {
        let t = null;
        for (const arm of node.arms) {
          this.expr(arm.weight);
          const armType = this.expr(arm.value);
          t = t === null ? armType : join(t, armType);
        }
        return t ?? DYN;
      }

      case 'Fork': {
        this.expr(node.count);
        this.push();
        this.scope.declare('_', NUM, false);
        this.blockInScope(node.body);
        this.pop();
        return listOf(DYN);
      }

      case 'Spawn': {
        for (const a of node.args) this.expr(a);
        return named('agent');
      }

      default: return DYN;
    }
  }

  binary(node) {
    // A decaying value participates in arithmetic and comparison at its worth
    // now, so for typing purposes it simply is a number.
    // A decimal is arithmetic but deliberately not a num: mixing them is an
    // error the checker should catch, so it must not silently widen either way.
    const asArith = (t) => (t && t.k === 'named' && t.name === 'liquid' ? NUM : t);
    const isDec = (t) => t === DEC;
    const l = asArith(this.expr(node.left));
    const r = asArith(this.expr(node.right));
    const op = node.op;

    if (['==', '!='].includes(op)) return BOOL;

    if (['<', '<=', '>', '>='].includes(op)) {
      if (!isDyn(l) && !isDyn(r) && !consistent(l, r)) {
        this.report({
          code: 'E0301',
          message: `cannot compare \`${show(l)}\` with \`${show(r)}\``,
          span: node.span,
          label: 'these are different types',
        });
      } else {
        for (const [t, side] of [[l, node.left], [r, node.right]]) {
          if (!isDyn(t) && t !== NUM && t !== STR && t.k !== 'named') {
            this.mismatch(NUM, t, side.span ?? node.span, 'cannot be ordered');
          }
        }
      }
      return BOOL;
    }

    if (isDec(l) || isDec(r)) {
      if (['<', '<=', '>', '>=', '==', '!='].includes(op)) return BOOL;
      const other = isDec(l) ? r : l;
      if (!isDyn(other) && !isDec(other) && other !== NUM) {
        this.report({
          code: 'E0301',
          message: `\`${op}\` is not defined between \`dec\` and \`${show(other)}\``,
          span: node.span,
          label: 'exact arithmetic only mixes with whole numbers',
        });
      }
      return DEC;
    }

    if (op === '@') return TENSOR;

    if (op === '+') {
      if (l === STR || r === STR) return STR;
      if (l && r && l.k === 'list' && r.k === 'list') return listOf(join(l.of, r.of));
      // `+` is the one overloaded operator: it adds numbers, joins text and
      // concatenates lists. So an operand the checker does not know leaves the
      // result unknown as well. Falling through to `num` here claimed to know
      // something it did not, and reported a false type error on correct code
      // -- `s.slice(0, 1).upper() + s.slice(1)` in std/str.pedag, where both
      // sides are `dyn` and the answer is plainly a string.
      if (isDyn(l) || isDyn(r)) return DYN;
    }

    if (l === TENSOR || r === TENSOR) return TENSOR;
    if (l && l.k === 'named' && l.name === 'cipher') return l;
    if (r && r.k === 'named' && r.name === 'cipher') return r;

    // Arithmetic: both sides must be numbers, once we actually know.
    for (const [t, side] of [[l, node.left], [r, node.right]]) {
      if (!isDyn(t) && t !== NUM) {
        const helps = [];
        if (t === STR && op === '+') helps.push('to join text, make both sides `str` with `str(...)`');
        this.report({
          code: 'E0301',
          message: `\`${op}\` needs \`num\`, found \`${show(t)}\``,
          span: side.span ?? node.span,
          label: `this is \`${show(t)}\``,
          helps,
        });
      }
    }
    return NUM;
  }

  call(node) {
    const calleeType = this.expr(node.callee);
    const args = node.args.map((a) => this.expr(a));

    if (isDyn(calleeType)) return DYN;

    if (calleeType.k !== 'fn') {
      this.report({
        code: 'E0304',
        message: `\`${show(calleeType)}\` is not callable`,
        span: node.callee.span ?? node.span,
        label: 'not a function',
      });
      return DYN;
    }

    if (calleeType.params.length !== args.length) {
      const name = node.callee.type === 'Ident' ? `\`${node.callee.name}\`` : 'this function';
      this.report({
        code: 'E0302',
        message: `${name} takes ${calleeType.params.length} argument${calleeType.params.length === 1 ? '' : 's'}, but ${args.length} ${args.length === 1 ? 'was' : 'were'} supplied`,
        span: node.span,
        label: `${args.length} supplied`,
        notes: [`its type is \`${show(calleeType)}\``],
      });
      return calleeType.ret;
    }

    args.forEach((actual, i) => {
      const expected = calleeType.params[i];
      if (!consistent(expected, actual)) {
        this.mismatch(expected, actual, node.args[i].span ?? node.span,
          `argument ${i + 1} of ${node.callee.type === 'Ident' ? `\`${node.callee.name}\`` : 'this call'}`);
      }
    });

    return calleeType.ret;
  }

  // Bring a pattern's bindings into the current scope. A record pattern knows
  // its field types, so destructuring keeps them rather than dropping to dyn.
  bindPattern(pattern) {
    switch (pattern.kind) {
      case 'bind': this.scope.declare(pattern.name, DYN, false); return;
      case 'list': for (const p of pattern.items) this.bindPattern(p); return;
      case 'record': {
        const known = this.records.get(pattern.name);
        if (!known && !this.importUnknown && !this.scope.lookup(pattern.name)) {
          const near = closestName(pattern.name, [...this.records.keys()]);
          this.report({
            code: 'E0201',
            message: `\`${pattern.name}\` is not a record`,
            span: pattern.span,
            label: 'no such record',
            helps: near ? [`there is a record with a similar spelling: \`${near}\``] : [],
          });
        }
        if (known && known.fields.length !== pattern.fields.length) {
          this.report({
            code: 'E0302',
            message: `\`${pattern.name}\` has ${known.fields.length} field${known.fields.length === 1 ? '' : 's'}, but this pattern lists ${pattern.fields.length}`,
            span: pattern.span,
            label: 'wrong number of fields',
            notes: [`its fields are ${known.fields.join(', ')}`],
          });
        }
        pattern.fields.forEach((p, i) => {
          if (p.kind === 'bind' && known && known.types[i]) {
            this.scope.declare(p.name, known.types[i], false);
          } else {
            this.bindPattern(p);
          }
        });
        return;
      }
      default:
    }
  }

  mismatch(expected, actual, span, context) {
    const helps = [];
    if (expected === STR && actual === NUM) helps.push('`str(x)` converts a number to text');
    if (expected === NUM && actual === STR) helps.push('`num(x)` reads a number out of text');
    this.report({
      code: 'E0301',
      message: `expected \`${show(expected)}\`, found \`${show(actual)}\``,
      span,
      label: context,
      helps,
    });
  }
}

export function typecheck(program, { builtins = [] } = {}) {
  return new Checker({ builtins }).check(program);
}
