import { NativeFunction, stringify, unwrap, typeName } from './values.js';
import { Tensor } from './tensor.js';
import { sarvmError } from './errors.js';

const nf = (name, arity, fn) => new NativeFunction(name, arity, fn);

// ---------------------------------------------------------------------------
// Structural schemas
// ---------------------------------------------------------------------------
//
// Two versions of a service disagree about a payload's shape. The usual
// outcomes are a crash or a silent misread. This gives a third: describe both
// shapes, and let the runtime work out whether one can be read as the other,
// and what is lost if it can.
//
// It is structural, not nominal -- what matters is the fields present and their
// kinds, never a version string somebody remembered to bump. And it is honest
// about direction: a reader that gained an optional field can read old data; a
// reader that gained a *required* one cannot, and negotiate() says so instead
// of substituting a zero.

export class Schema {
  constructor(name, fields) {
    this.name = name;
    this.fields = fields;      // Map<string, {kind, required, fallback}>
  }
  get sarvmType() { return 'schema'; }

  toString() {
    const shown = [...this.fields.entries()]
      .map(([k, f]) => `${k}: ${f.kind}${f.required ? '' : '?'}`)
      .join(', ');
    return `<schema ${this.name} {${shown}}>`;
  }

  // Does this value match? Returns a list of complaints, empty if it does.
  complaints(value) {
    const out = [];
    const v = unwrap(value);
    if (!(v instanceof Map)) return [`expected a map, got ${typeName(v)}`];
    for (const [key, field] of this.fields) {
      if (!v.has(key)) {
        if (field.required) out.push(`missing required field '${key}'`);
        continue;
      }
      const actual = kindOf(v.get(key));
      if (field.kind !== 'any' && actual !== field.kind) {
        out.push(`field '${key}' should be ${field.kind}, found ${actual}`);
      }
    }
    return out;
  }

  sarvmMembers(interp) {
    return {
      name: this.name,
      fields: [...this.fields.keys()],
      matches: nf('matches', 1, (a) => this.complaints(a[0]).length === 0),
      complaints: nf('complaints', 1, (a) => this.complaints(a[0])),
      required: [...this.fields.entries()].filter(([, f]) => f.required).map(([k]) => k),
    };
  }
}

export function kindOf(value) {
  const v = unwrap(value);
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'number') return 'num';
  if (typeof v === 'string') return 'str';
  if (typeof v === 'boolean') return 'bool';
  if (Array.isArray(v)) return 'list';
  if (v instanceof Tensor) return 'tensor';
  if (v instanceof Map) return 'map';
  return typeName(v);
}

// What happens if a producer speaking `from` sends to a consumer expecting
// `to`. Four outcomes, and the difference between them is the whole point.
export function negotiate(from, to) {
  const added = [];        // the reader wants these; the writer does not send them
  const dropped = [];      // the writer sends these; the reader ignores them
  const retyped = [];      // both have it, but disagree about its kind
  const blocking = [];

  for (const [key, field] of to.fields) {
    if (!from.fields.has(key)) {
      if (field.required && field.fallback === undefined) {
        blocking.push(`'${key}' is required by ${to.name} and ${from.name} does not send it`);
      } else {
        added.push(key);
      }
      continue;
    }
    const theirs = from.fields.get(key);
    if (theirs.kind !== field.kind && field.kind !== 'any' && theirs.kind !== 'any') {
      retyped.push(`'${key}': ${theirs.kind} -> ${field.kind}`);
      if (!coercible(theirs.kind, field.kind)) {
        blocking.push(`'${key}' is ${theirs.kind} in ${from.name} but ${field.kind} in ${to.name}, and one cannot be read as the other`);
      }
    }
  }
  for (const key of from.fields.keys()) {
    if (!to.fields.has(key)) dropped.push(key);
  }

  return {
    compatible: blocking.length === 0,
    added,
    dropped,
    retyped,
    blocking,
  };
}

const COERCIONS = new Set(['num->str', 'bool->str', 'num->bool', 'bool->num']);
const coercible = (a, b) => COERCIONS.has(`${a}->${b}`);

// Read a value written against `from` as though it were written against `to`.
// Missing optional fields take their declared fallback; extra fields are
// dropped; coercible mismatches are converted. Anything else refuses.
export function adapt(value, from, to, line) {
  const result = negotiate(from, to);
  if (!result.compatible) {
    throw sarvmError('SchemaError',
      `cannot read ${from.name} as ${to.name}: ${result.blocking.join('; ')}`, line);
  }
  const v = unwrap(value);
  if (!(v instanceof Map)) {
    throw sarvmError('SchemaError', `expected a map to adapt, got ${typeName(v)}`, line);
  }

  const out = new Map();
  for (const [key, field] of to.fields) {
    if (v.has(key)) {
      const raw = v.get(key);
      const actual = kindOf(raw);
      out.set(key, actual !== field.kind && field.kind !== 'any' ? coerce(raw, field.kind) : raw);
      continue;
    }
    if (field.fallback !== undefined) out.set(key, field.fallback);
  }
  return out;
}

function coerce(value, kind) {
  const v = unwrap(value);
  if (kind === 'str') return stringify(v, 0);
  if (kind === 'num') return typeof v === 'boolean' ? (v ? 1 : 0) : Number(v);
  if (kind === 'bool') return Boolean(v);
  return v;
}

// ---------------------------------------------------------------------------
// Live re-typing
// ---------------------------------------------------------------------------
//
// Changing the shape of records already in memory, in place, without stopping.
// Every record is rewritten through the same adapt() path used on the wire, so
// a migration cannot do anything a negotiation would have refused.

export function migrate(records, from, to, line) {
  const started = process.hrtime.bigint();
  const out = records.map((r) => adapt(r, from, to, line));
  return { records: out, nanos: Number(process.hrtime.bigint() - started) };
}
