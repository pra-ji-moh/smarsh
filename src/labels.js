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
//
// That is the confidentiality half. The other half asks the opposite question:
// not who may see this, but whose word is behind it.
//
// An integrity policy is `alice <- {alice}`: "alice vouches for this value, on
// the understanding that only alice influenced it". The two halves are exact
// duals, and every rule flips:
//
//                        confidentiality            integrity
//   a policy says        who may READ it            who may have WRITTEN it
//   combining values     union the owners           INTERSECT the owners
//     within one owner   intersect the readers      UNION the writers
//   empty label means    readable by everyone       vouched for by nobody
//   needs authority      WEAKENING it (declassify)  STRENGTHENING it (endorse)
//
// The intersection is the whole point. If alice vouches for `x` and nothing
// vouches for `y`, then `x + y` is vouched for by nobody -- automatically, with
// no check to remember to write. A boolean `trusted` flag cannot do that,
// because it has no way to say *who* stopped trusting and no reason to stop
// when the two are mixed.
//
// And the asymmetry in the last row is not an oversight. Weakening integrity is
// always safe: withdrawing your vouch can only make a program more careful.
// Strengthening it is the dangerous direction, so that is the one that costs
// authority -- exactly the reverse of confidentiality, where releasing is the
// dangerous direction.

export class Policy {
  constructor(owner, readers) {
    this.owner = owner;
    this.readers = new Set(readers);
    this.readers.add(owner);            // an owner can always read their own data
  }
  toString() { return `${this.owner}: {${[...this.readers].sort().join(', ')}}`; }
}

// The dual: one principal's statement of what they will stand behind.
export class Trust {
  constructor(owner, writers) {
    this.owner = owner;
    this.writers = new Set(writers);
    this.writers.add(owner);            // vouching for it means vouching for your own hand in it
  }
  toString() { return `${this.owner} <- {${[...this.writers].sort().join(', ')}}`; }
}

const intersect = (a, b) => new Set([...a].filter((x) => b.has(x)));
const union = (a, b) => new Set([...a, ...b]);

export class Label {
  constructor(policies = [], trusts = []) {
    this.policies = new Map();          // owner -> Policy   (who may read)
    this.trusts = new Map();            // owner -> Trust    (who vouches)
    // Principals who vouched for something this value came from, but do not
    // vouch for this value. Losing a vouch is silent by nature -- it happens in
    // an ordinary `+` -- and a value that lost one is not the same thing as a
    // literal that never had one, though without this they would be
    // indistinguishable. Keeping the names is also what lets the error say
    // where the backing went rather than only noting its absence.
    this.lost = new Set();
    for (const p of policies) this.add(p);
    for (const t of trusts) this.vouch(t);
  }

  add(policy) {
    const existing = this.policies.get(policy.owner);
    if (!existing) { this.policies.set(policy.owner, policy); return this; }
    // One owner stating two rules means both apply, so the readers they permit
    // is the intersection.
    this.policies.set(policy.owner,
      new Policy(policy.owner, intersect(existing.readers, policy.readers)));
    return this;
  }

  // The same reasoning, on the other half: one owner saying twice what they
  // will stand behind means both statements bind, so the writers they will
  // tolerate is the intersection. Note this is *not* how two different values
  // combine -- see `join`, where it goes the other way.
  vouch(trust) {
    this.lost.delete(trust.owner);      // vouching again settles the question
    const existing = this.trusts.get(trust.owner);
    if (!existing) { this.trusts.set(trust.owner, trust); return this; }
    this.trusts.set(trust.owner,
      new Trust(trust.owner, intersect(existing.writers, trust.writers)));
    return this;
  }

  get isEmpty() {
    return this.policies.size === 0 && this.trusts.size === 0 && this.lost.size === 0;
  }
  get owners() { return [...this.policies.keys()].sort(); }
  get vouchers() { return [...this.trusts.keys()].sort(); }
  get lostVouchers() { return [...this.lost].sort(); }

  // Everyone who might have had a hand in this, according to those who vouch.
  writers() {
    if (this.trusts.size === 0) return null;         // nobody vouches: unknown
    let all = new Set();
    for (const t of this.trusts.values()) all = union(all, t.writers);
    return all;
  }

  trustedBy(principal) { return this.trusts.has(principal); }

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

  // Two statements about the SAME value. Both bind, so both halves narrow: the
  // readers permitted is the intersection and so is the tolerated writers. This
  // is what `classify` and `endorse` do to a value that is already labelled.
  //
  // Not to be confused with `join` below. Adding alice's vouch to a value must
  // not be read as mixing in a second, unvouched value -- that would cancel the
  // vouch the moment it was given.
  static and(a, b) {
    if (!a) return b;
    if (!b) return a;
    const out = new Label();
    for (const p of a.policies.values()) out.add(p);
    for (const p of b.policies.values()) out.add(p);
    for (const owner of [...a.lost, ...b.lost]) out.lost.add(owner);
    for (const t of a.trusts.values()) out.vouch(t);
    for (const t of b.trusts.values()) out.vouch(t);
    return out;
  }

  // The join: two DIFFERENT values flowing into one result. The two halves move
  // in opposite directions, which is the whole content of the duality.
  //
  // A null operand is an unlabelled value, and unlabelled is not neutral here.
  // On the confidentiality half it means "nobody has stated a rule", so the
  // other side's rules simply carry. On the integrity half it means "nobody
  // stands behind this", and mixing something nobody stands behind into a value
  // alice vouched for produces something alice has not seen. The vouch goes.
  //
  // Yes, that includes a literal: `salary * 2` is no longer vouched for. That is
  // the conservative direction and it is deliberate -- the alternative is a
  // vouch that survives contact with arbitrary data, which is the failure the
  // whole half exists to prevent. Where mixing is intended, `endorse` the
  // result under `authority`, and the audit trail records that you did.
  static join(a, b) {
    if (!a && !b) return null;
    const A = a ?? EMPTY;
    const B = b ?? EMPTY;
    const out = new Label();

    // Confidentiality goes UP. Every owner's rule survives, and an owner named
    // by both ends up permitting only those they both permitted. Mixing data
    // never makes it more readable.
    for (const p of A.policies.values()) out.add(p);
    for (const p of B.policies.values()) out.add(p);

    // Integrity goes DOWN. A vouch survives only if it covers both inputs --
    // alice cannot stand behind a value half of which she never saw -- and
    // where it does survive it must now admit both sides' writers.
    for (const [owner, ta] of A.trusts) {
      const tb = B.trusts.get(owner);
      if (tb) out.trusts.set(owner, new Trust(owner, union(ta.writers, tb.writers)));
      else out.lost.add(owner);
    }
    for (const owner of B.trusts.keys()) if (!A.trusts.has(owner)) out.lost.add(owner);
    for (const owner of [...A.lost, ...B.lost]) if (!out.trusts.has(owner)) out.lost.add(owner);
    return out.isEmpty ? null : out;
  }

  // Remove one owner's confidentiality policy, keeping the integrity half --
  // releasing a value says nothing about who wrote it. The caller must already
  // have checked authority; this is the mechanism, not the decision.
  without(owner) {
    const out = new Label();
    for (const [key, policy] of this.policies) if (key !== owner) out.add(policy);
    for (const owner of this.lost) out.lost.add(owner);
    for (const t of this.trusts.values()) out.vouch(t);
    return out;
  }

  // And the mirror: withdraw one owner's vouch. This one needs no authority --
  // it can only make a program more careful, never less. It also clears the
  // record of that owner having lost one, which is how a program says "I know
  // this is no longer backed, and that is what I meant" without claiming it is.
  unvouched(owner) {
    const out = new Label();
    for (const p of this.policies.values()) out.add(p);
    for (const key of this.lost) if (key !== owner) out.lost.add(key);
    for (const [key, trust] of this.trusts) if (key !== owner) out.vouch(trust);
    return out;
  }

  clone() {
    const out = new Label([...this.policies.values()], [...this.trusts.values()]);
    for (const owner of this.lost) out.lost.add(owner);
    return out;
  }

  toString() {
    if (this.isEmpty) return '{}';
    const parts = [
      ...[...this.policies.values()].map(String).sort(),
      ...[...this.trusts.values()].map(String).sort(),
      // `~alice` reads as "alice's backing was here, and is not any more".
      ...this.lostVouchers.map((o) => '~' + o),
    ];
    return `{${parts.join('; ')}}`;
  }
}

// The label that states nothing: readable by everyone, vouched for by nobody.
// Both directions of "no guarantees", which is what an unlabelled value is.
const EMPTY = new Label();

// A value carrying a label. Kept separate from Tainted: the flat labels answer
// "is this suspect", these answer "whose is it and who may see it", and a value
// can genuinely need both.
export class Labelled {
  constructor(value, label) {
    // Nesting collapses, joining the labels rather than stacking wrappers.
    if (value instanceof Labelled) {
      this.value = value.value;
      this.label = Label.and(value.label, label);
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
      vouchers: this.label.vouchers,
      lost_vouchers: this.label.lostVouchers,
      writers: [...(this.label.writers() ?? [])].sort(),
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
  // Every source counts, including the ones carrying no label. Skipping those
  // would make `vouched + literal` come back still vouched for, which is the
  // one answer this must never give.
  if (sources.length === 0) return result;
  let label = labelOf(sources[0]);
  for (let i = 1; i < sources.length; i++) label = Label.join(label, labelOf(sources[i]));
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
