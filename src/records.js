import { NativeFunction, stringify, unwrap } from './values.js';
import { smarshError } from './errors.js';

const nf = (name, arity, fn) => new NativeFunction(name, arity, fn);

// Records: immutable data carriers.
//
// `record Point(x, y)` gives you a constructor, named fields, structural
// equality and a readable printed form, and nothing else. No inheritance, no
// mutation, no identity semantics to be surprised by. Two records with equal
// fields are equal, which is the property that makes them usable as values.

export class RecordType {
  constructor(name, fields, line) {
    this.name = name;
    this.fields = fields;
    this.line = line;
    // Set when this type is one variant of a `choice`. It is what makes
    // exhaustiveness decidable: from any variant the checker can reach the
    // full set of siblings a match is obliged to cover.
    this.choice = null;
  }
  get smarshType() { return 'record_type'; }
  toString() { return `<record ${this.name}(${this.fields.join(', ')})>`; }
  smarshMembers() {
    return {
      name: this.name,
      fields: [...this.fields],
      choice: this.choice ? this.choice.name : null,
    };
  }
}

// A choice: one named type whose values are exactly one of a fixed set of
// variants.
//
//     choice Shape {
//       Circle(radius)
//       Rect(width, height)
//       Empty
//     }
//
// Each variant is an ordinary record, so construction, fields, structural
// equality, printing, `.with()` and pattern matching all work already and
// none of it needed a second implementation. What the choice adds is the
// closed set -- and a closed set is the thing that lets `smarsh check` prove a
// `match` handles every case before the program runs, instead of a missed
// variant becoming a MatchError in production.
//
// A variant with no fields is a value rather than a constructor: `Empty`, not
// `Empty()`. There is only one of it, so there is nothing to call.
export class ChoiceType {
  constructor(name, line) {
    this.name = name;
    this.line = line;
    this.variants = new Map();   // variant name -> RecordType
  }
  get smarshType() { return 'choice_type'; }
  toString() { return `<choice ${this.name}(${[...this.variants.keys()].join(' | ')})>`; }
  smarshMembers() {
    return { name: this.name, variants: [...this.variants.keys()] };
  }
}

export class RecordValue {
  constructor(type, values) {
    this.type = type;
    this.values = values;
  }
  get smarshType() { return this.type.name; }

  get(field) {
    const i = this.type.fields.indexOf(field);
    return i === -1 ? undefined : this.values[i];
  }

  // A record with one field replaced. The original is untouched -- this is how
  // you "change" an immutable value.
  with(field, value, line) {
    const i = this.type.fields.indexOf(field);
    if (i === -1) {
      throw smarshError('AttributeError', `\`${this.type.name}\` has no field \`${field}\``, line);
    }
    const next = this.values.slice();
    next[i] = value;
    return new RecordValue(this.type, next);
  }

  toString() {
    // A variant carrying nothing is written `Empty`, so it prints that way too.
    if (this.type.fields.length === 0) return this.type.name;
    const parts = this.type.fields.map((f, i) => `${f}: ${stringify(this.values[i], 1)}`);
    return `${this.type.name}(${parts.join(', ')})`;
  }

  smarshMembers(interp, line) {
    const out = {};
    this.type.fields.forEach((f, i) => { out[f] = this.values[i]; });
    out.fields = [...this.type.fields];
    // The invariant is re-checked on the new value, so a record cannot be
    // walked out of its own promise one field at a time.
    out.with = nf('with', 2, (a, l) => {
      const next = this.with(stringify(unwrap(a[0]), 0), a[1], l);
      if (interp && typeof interp.checkRecordInvariants === 'function') {
        interp.checkRecordInvariants(next, l);
      }
      return next;
    });
    return out;
  }
}

export function recordsEqual(a, b, deepEquals) {
  if (a.type !== b.type) return false;
  for (let i = 0; i < a.values.length; i++) {
    if (!deepEquals(unwrap(a.values[i]), unwrap(b.values[i]))) return false;
  }
  return true;
}
