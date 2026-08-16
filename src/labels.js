import { NativeFunction, stringify } from './values.js';
import { pedagError } from './errors.js';

const nf = (name, arity, fn) => new NativeFunction(name, arity, fn);

// The decentralized label model, after Myers and Liskov.
//
// The flat labels elsewhere in Pēdāg (`untrusted`, `ungrounded`, `region:eu`)
// answer "is this value suspect". They cannot answer the question a system with
// several mutually distrusting parties actually has: *whose* data is this, and
// *who* said who may read it.
//
// A policy is one principal's rule about one value: `alice: {alice, bob}` reads
// as "alice owns this and permits alice and bob to read it". A label is a set of
// such policies, one per owner. Combining two values unions their policies,
// which is the conservative direction: the result is owned by both, and its
// effective readers are the *intersection* of what each owner allows. Data does
// not become more readable by being mixed with other data.
//
// The part that matters, and the part a blanket `trust()` cannot express:
// removing a policy requires the authority of the principal who owns it. Alice
// can declassify alice's data. Nobody else can, no matter what they hold.

export class Policy {
  constructor(owner, readers) {
    this.owner = owner;
    this.readers = new Set(readers);
    this.readers.add(owner);            // an owner can always read their own data
  }
  toString() { return `${this.owner}: {${[...this.readers].sort().join(', ')}}`; }
}

export class Label {
  constructor(policies = []) {
    this.policies = new Map();          // owner -> Policy
    for (const p of policies) this.add(p);
  }

  add(policy) {
    const existing = this.policies.get(policy.owner);
    if (!existing) { this.policies.set(policy.owner, policy); return this; }
    // One owner stating two rules means both apply, so the readers they permit
    // is the intersection.
    const both = new Set([...existing.readers].filter((r) => policy.readers.has(r)));
    this.policies.set(policy.owner, new Policy(policy.owner, both));
    return this;
  }

  get isEmpty() { return this.policies.size === 0; }
  get owners() { return [...this.policies.keys()].sort(); }

  // Everyone every owner permits. A principal absent from one owner's list
  // cannot read the value, however permissive the other owners were.
  effectiveReaders() {
    const lists = [...this.policies.values()].map((p) => p.readers);
    if (lists.length === 0) return null;          // unlabelled: readable by all
    let readers = new Set(lists[0]);
    for (const next of lists.slice(1)) readers = new Set([...readers].filter((r) => next.has(r)));
    return readers;
  }

  canRead(principal) {
    const readers = this.effectiveReaders();
    return readers === null || readers.has(principal);
  }

  // The join: combining values combines obligations.
  static join(a, b) {
    if (!a) return b;
    if (!b) return a;
    const out = new Label();
    for (const p of a.policies.values()) out.add(p);
    for (const p of b.policies.values()) out.add(p);
    return out;
  }

  // Remove one owner's policy. The caller must already have checked authority;
  // this is the mechanism, not the decision.
  without(owner) {
    const out = new Label();
    for (const [key, policy] of this.policies) if (key !== owner) out.add(policy);
    return out;
  }

  clone() { return new Label([...this.policies.values()]); }

  toString() {
    if (this.isEmpty) return '{}';
    return `{${[...this.policies.values()].map(String).sort().join('; ')}}`;
  }
}

// A value carrying a label. Kept separate from Tainted: the flat labels answer
// "is this suspect", these answer "whose is it and who may see it", and a value
// can genuinely need both.
export class Labelled {
  constructor(value, label) {
    // Nesting collapses, joining the labels rather than stacking wrappers.
    if (value instanceof Labelled) {
      this.value = value.value;
      this.label = Label.join(value.label, label);
    } else {
      this.value = value;
      this.label = label;
    }
  }
  get pedagType() { return 'labelled'; }
  toString() { return `${stringify(this.value, 1)}${this.label}`; }

  pedagMembers() {
    return {
      owners: this.label.owners,
      readers: [...(this.label.effectiveReaders() ?? [])].sort(),
      label: this.label.toString(),
    };
  }
}

export const labelOf = (v) => (v instanceof Labelled ? v.label : null);
export const stripLabel = (v) => (v instanceof Labelled ? v.value : v);

// Carry labels through an operation. Every read of a labelled value produces a
// labelled result; that is what makes the policy follow the data instead of
// being attached to a variable name.
export function relabel(result, ...sources) {
  let label = null;
  for (const s of sources) {
    const l = labelOf(s);
    if (l) label = Label.join(label, l);
  }
  return label ? new Labelled(result, label) : result;
}

// A named party. Held authority is what lets a program act for one.
export class Principal {
  constructor(name) { this.name = name; }
  get pedagType() { return 'principal'; }
  toString() { return `<principal ${this.name}>`; }
  pedagMembers() { return { name: this.name }; }
}

export function requireAuthority(interp, owner, action, line) {
  if (interp.authority.has(owner)) return;
  const held = interp.authority.size ? [...interp.authority].sort().join(', ') : 'no authority';
  throw pedagError('AuthorityError',
    `${action} needs \`${owner}\`'s authority; this frame acts for ${held}`, line)
    .help(`wrap it in \`authority "${owner}" { ... }\`, which the run must have been started with --principal ${owner}`)
    .note('a policy can only be removed by the principal who set it');
}
