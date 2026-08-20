import { createHash } from 'node:crypto';

import { pedagError } from './errors.js';

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

export class PedagFunction {
  constructor(decl, closure) {
    this.decl = decl;             // { name, params, body, needs, requires, ensures, line }
    this.closure = closure;
    this.name = decl.name ?? '<anonymous>';
  }
  get arity() { return this.decl.params.length; }
  toString() { return `<fn ${this.name}/${this.arity}>`; }
}

export class NativeFunction {
  // needs: array of capability names this builtin consumes.
  constructor(name, arity, fn, needs = []) {
    this.name = name;
    this.arity = arity;           // number, or -1 for variadic
    this.fn = fn;
    this.needs = needs;
  }
  toString() { return `<native ${this.name}>`; }
}

// ---------------------------------------------------------------------------
// Taint
// ---------------------------------------------------------------------------

// A value carrying provenance labels. Labels propagate through every operation
// that reads the value, which is what makes `grounded` and `region` blocks
// enforceable rather than advisory.
//
//   'untrusted'    -- came from outside; may be an injection attempt
//   'ungrounded'   -- came from a model; may be fabricated
//   'region:eu'    -- subject to a jurisdiction's rules
export class Tainted {
  constructor(value, labels) {
    this.value = value instanceof Tainted ? value.value : value;
    const inherited = value instanceof Tainted ? value.labels : [];
    this.labels = new Set([...inherited, ...labels]);
  }
  toString() { return `${stringify(this.value)}#{${[...this.labels].join(',')}}`; }
}

// Reach the underlying value through any wrapper that only carries provenance.
// Both Tainted and Labelled are transparent to computation and opaque to
// policy: the value inside is what arithmetic sees, the wrapper is what the
// guards see.
export const unwrap = (v) => {
  let out = v;
  for (let i = 0; i < 4 && out !== null && typeof out === 'object'; i++) {
    if (out instanceof Tainted) { out = out.value; continue; }
    if (out.pedagType === 'labelled') { out = out.value; continue; }
    break;
  }
  return out;
};

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------
//
// `let` freezes what it binds, all the way down. Blocking rebinding while
// leaving the contents writable is the weaker guarantee people assume they are
// getting and are not: `let xs = [1,2]` followed by `xs.push(3)` reads as a
// contradiction, and in an audited system it is one.
//
// The rule has no exceptions: bind with `let` and it is frozen; if you need to
// build a collection, bind it with `var`.
const FROZEN = new WeakSet();

export function freezeDeep(value, seen = null) {
  const v = value instanceof Tainted ? value.value : value;
  // Nothing to freeze, and -- more to the point -- no reason to have allocated
  // a cycle-guard Set to discover that. `let d = g + i` in a loop body called
  // this once per pass and the Set was the whole cost.
  if (v === null || typeof v !== 'object') return value;

  // Only lists and maps hold anything that can be frozen. Everything else is
  // already immutable by construction or is a live handle -- and the cycle
  // guard was being allocated before finding that out, once per `let` binding
  // a record, a tensor or a decimal.
  const isList = Array.isArray(v);
  const isMap = !isList && v instanceof Map;
  if (!isList && !isMap) return value;

  if (seen === null) seen = new Set();
  else if (seen.has(v)) return value;
  seen.add(v);
  FROZEN.add(v);

  if (isList) {
    for (const item of v) freezeDeep(item, seen);
  } else {
    for (const item of v.values()) freezeDeep(item, seen);
  }
  // Everything else is already immutable by construction (tensors, records,
  // decimals) or is a live handle whose identity is the point (agents, ledgers,
  // contexts, arenas). Freezing a handle would break the thing it refers to.
  return value;
}

export const isFrozen = (v) => (v !== null && typeof v === 'object' && FROZEN.has(v));

export function assertMutable(v, what, line, raiseError) {
  if (isFrozen(v)) {
    throw raiseError('ImmutableError',
      `${what} was bound with \`let\`, which freezes it`, line)
      .help('bind it with `var` if it has to change, or build a new value');
  }
  return v;
}

export function labelsOf(v) {
  return v instanceof Tainted ? v.labels : null;
}

// Re-attach the union of all source labels to a freshly computed value.
//
// Almost nothing is tainted, so the common answer is "give it back unchanged" --
// and reaching that answer used to cost a rest-argument array and a Set. The
// sources are scanned first and nothing is allocated unless a label is actually
// going to be attached.
export function retaint(result, ...sources) {
  let any = false;
  for (let i = 0; i < sources.length; i++) {
    if (sources[i] instanceof Tainted) { any = true; break; }
  }
  if (!any) return result;
  const labels = new Set();
  for (const s of sources) {
    if (s instanceof Tainted) for (const l of s.labels) labels.add(l);
  }
  return new Tainted(result, labels);
}

// The one-source case, without the rest array. Member access and unary
// operators take exactly one, and they are on every path through a program.
export function retaintFrom(result, source) {
  if (!(source instanceof Tainted)) return result;
  return new Tainted(result, source.labels);
}

// ---------------------------------------------------------------------------
// Context windows
// ---------------------------------------------------------------------------

// A bounded, token-accounted buffer. Pēdāg treats this as a native memory
// region: you declare a budget in tokens, push into it, and it evicts on its
// own policy when the budget is exceeded. Nothing here calls a model; the token
// count is a real, deterministic estimate over the actual text.
export class ContextWindow {
  constructor(budget, policy = 'fifo') {
    this.budget = budget;
    this.policy = policy;
    this.entries = [];            // { text, tokens, pinned }
    this.evicted = 0;
  }

  get tokens() { return this.entries.reduce((a, e) => a + e.tokens, 0); }
  get length() { return this.entries.length; }

  push(text, pinned = false) {
    const entry = { text, tokens: countTokens(text), pinned };
    this.entries.push(entry);
    this.evict();
    return this;
  }

  evict() {
    if (this.policy === 'none') return;
    while (this.tokens > this.budget) {
      const idx = this.entries.findIndex((e) => !e.pinned);
      if (idx === -1) break;      // everything left is pinned; stop, do not lie
      this.entries.splice(idx, 1);
      this.evicted += 1;
    }
  }

  text() { return this.entries.map((e) => e.text).join('\n'); }
  clear() { this.entries = []; this.evicted = 0; return this; }
  toString() { return `<context ${this.tokens}/${this.budget} tokens, ${this.entries.length} entries>`; }
}

// Deterministic token estimate. Not a real BPE vocabulary -- it is a stable
// approximation (words + punctuation + long-word splitting) that tracks GPT/
// Claude-family counts within roughly 10-15% on prose. It is honest about being
// an estimate; nothing in the runtime pretends it is exact.
export function countTokens(text) {
  const s = String(text);
  if (s.length === 0) return 0;
  const pieces = s.match(/\s+|[A-Za-z]+|[0-9]+|[^\sA-Za-z0-9]/g) ?? [];
  let n = 0;
  for (const p of pieces) {
    if (/^\s+$/.test(p)) { n += Math.max(0, Math.floor(p.length / 4)); continue; }
    n += Math.max(1, Math.ceil(p.length / 4));
  }
  return n;
}

// ---------------------------------------------------------------------------
// Ledger: an append-only, hash-chained log
// ---------------------------------------------------------------------------

const ZERO_HASH = '0'.repeat(64);
const sha256 = (str) => createHash('sha256').update(str).digest('hex');

export class Ledger {
  constructor(name) {
    this.name = name;
    this.entries = [];
    this.head = ZERO_HASH;
    // One savepoint per open `atomic` block holding this ledger. A stack, so
    // that a failing inner transaction undoes only its own appends and leaves
    // the enclosing one intact.
    this.savepoints = [];
  }

  append(value) {
    const payload = stringify(value);
    const hash = sha256(`${this.head}|${this.entries.length}|${payload}`);
    this.entries.push({ index: this.entries.length, payload, prev: this.head, hash });
    this.head = hash;
    return hash;
  }

  verify() {
    let prev = ZERO_HASH;
    for (const e of this.entries) {
      if (e.prev !== prev) return false;
      if (e.hash !== sha256(`${prev}|${e.index}|${e.payload}`)) return false;
      prev = e.hash;
    }
    return prev === this.head;
  }

  // --- two-phase commit ----------------------------------------------------
  // An append-only log cannot un-append after the fact, so a transaction marks
  // where it started and a rollback truncates back to it. Nothing outside the
  // transaction can observe the interim state, because `atomic` blocks are the
  // only way to open one.
  begin() {
    this.savepoints.push({ count: this.entries.length, head: this.head });
  }
  commit() { this.savepoints.pop(); }
  rollback() {
    const mark = this.savepoints.pop();
    if (!mark) return;
    this.entries.length = mark.count;
    this.head = mark.head;
  }

  get length() { return this.entries.length; }
  get pedagType() { return 'ledger'; }
  toString() { return `<ledger ${this.name} n=${this.entries.length} head=${this.head.slice(0, 8)}>`; }
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

export function stringify(v, depth = 0) {
  if (v === null || v === undefined) return 'nil';
  if (v && typeof v.pedagMembers === 'function' && v.type && v.values) return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v);
    return String(Number(v.toPrecision(12)));
  }
  if (typeof v === 'string') return depth === 0 ? v : JSON.stringify(v);
  if (v instanceof Tainted) return `${stringify(v.value, depth)}#{${[...v.labels].join(',')}}`;
  if (Array.isArray(v)) return `[${v.map((x) => stringify(x, depth + 1)).join(', ')}]`;
  if (v instanceof Map) {
    const parts = [];
    for (const [k, val] of v) parts.push(`${JSON.stringify(k)}: ${stringify(val, depth + 1)}`);
    return `{${parts.join(', ')}}`;
  }
  return String(v);
}

export function typeName(v) {
  // Types added by later layers (crypto, quantum, clocks) name themselves,
  // so this function does not need to know about every one of them.
  if (v && typeof v.pedagType === 'string') return v.pedagType;
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return 'num';
  if (typeof v === 'string') return 'str';
  if (Array.isArray(v)) return 'list';
  if (v instanceof Map) return 'map';
  if (v instanceof Tainted) return `tainted ${typeName(v.value)}`;
  if (v instanceof PedagFunction || v instanceof NativeFunction) return 'fn';
  if (v instanceof ContextWindow) return 'context';
  if (v instanceof Ledger) return 'ledger';
  if (v && v.constructor && v.constructor.name === 'Tensor') return 'tensor';
  return 'value';
}

// `a agent has no 'ping'` is the sort of thing a reader notices and a compiler
// author does not. Types name themselves through `pedagType`, so the set of
// vowel-initial names is open and the article has to be derived rather than
// written into each message.
export function withArticle(v) {
  const name = typeName(v);
  return `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`;
}

export const truthy = (v) => {
  const u = unwrap(v);
  if (u === null || u === undefined || u === false) return false;
  if (u === 0 || u === '') return false;
  return true;
};

export function expectNumber(v, what, line) {
  const u = unwrap(v);
  if (typeof u !== 'number') {
    throw pedagError('TypeError', `${what} must be a num, got ${typeName(u)}`, line);
  }
  return u;
}
