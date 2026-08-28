import { NativeFunction } from './values.js';
import { smarshError } from './errors.js';

const nf = (name, arity, fn) => new NativeFunction(name, arity, fn);

// Capabilities as values you can hand out, narrow, and take back.
//
// `needs fs` is the coarse form: a static claim, checked at the call, that
// cannot be withdrawn once made. That is right for a program's own structure
// and wrong for handing authority to something you do not fully trust — you
// cannot lend a `needs` clause and you cannot get it back.
//
// This is the caretaker pattern from the object-capability literature. A grant
// is a first-class value. Handing one out is delegation; wrapping it in a
// caretaker gives you a revoker that switches it off afterwards, including for
// anything the holder derived from it. Attenuation narrows a grant to a number
// of uses or a deadline, so the authority you lend is smaller than the
// authority you hold.
//
// Three rules make it safe to give one away:
//
//   1. A grant can only be created by a frame that already holds the
//      capability, so it never manufactures authority.
//   2. Attenuation only ever narrows. There is no widening operation.
//   3. Revocation is transitive. Revoking a grant kills everything derived
//      from it, because liveness is checked up the whole chain.

export class Grant {
  constructor(capability, { parent = null, uses = null, until = null, label = null } = {}) {
    this.capability = capability;
    this.parent = parent;
    this.usesLeft = uses;          // null = unlimited
    this.until = until;            // logical time, null = no deadline
    this.label = label;
    this.cell = { revoked: false };
    this.spent = 0;
  }
  get smarshType() { return 'grant'; }

  // Live only if this link and every link above it is live.
  reasonUnusable(now) {
    if (this.cell.revoked) return 'it has been revoked';
    if (this.usesLeft !== null && this.usesLeft <= 0) return `its ${this.spent} uses are spent`;
    if (this.until !== null && now > this.until) return `it expired at t=${this.until} and it is now t=${now}`;
    return this.parent ? this.parent.reasonUnusable(now) : null;
  }

  isLive(now) { return this.reasonUnusable(now) === null; }

  spend() {
    if (this.usesLeft !== null) this.usesLeft -= 1;
    this.spent += 1;
    if (this.parent) this.parent.spend();
  }

  // Narrowing only. `uses` and `until` take the tighter of the two.
  attenuate({ uses = null, until = null, label = null }) {
    const child = new Grant(this.capability, {
      parent: this,
      uses: uses === null ? null : Math.min(uses, this.usesLeft ?? uses),
      until: until === null ? this.until : (this.until === null ? until : Math.min(until, this.until)),
      label: label ?? this.label,
    });
    return child;
  }

  describe(now) {
    const bits = [this.capability];
    if (this.usesLeft !== null) bits.push(`${Math.max(0, this.usesLeft)} uses left`);
    if (this.until !== null) bits.push(`until t=${this.until}`);
    const why = this.reasonUnusable(now);
    if (why) bits.push(why);
    if (this.label) bits.push(`for ${this.label}`);
    return bits.join(', ');
  }

  toString() { return `<grant ${this.capability}${this.cell.revoked ? ', revoked' : ''}>`; }

  smarshMembers(interp) {
    return {
      capability: this.capability,
      live: this.isLive(interp.logicalTime),
      uses_left: this.usesLeft === null ? -1 : Math.max(0, this.usesLeft),
      spent: this.spent,
      describe: nf('describe', 0, () => this.describe(interp.logicalTime)),
      attenuate: nf('attenuate', -1, (a, line) => {
        const spec = a[0];
        const read = (key) => {
          if (!spec || typeof spec.get !== 'function') return null;
          const v = spec.get(key);
          return v === undefined || v === null ? null : Number(v);
        };
        const uses = read('uses');
        const forTicks = read('for');
        if (uses === null && forTicks === null) {
          throw smarshError('ValueError',
            'attenuate needs { "uses": n } or { "for": ticks }, since narrowing to nothing is the same as not delegating', line);
        }
        return this.attenuate({
          uses,
          until: forTicks === null ? null : interp.logicalTime + forTicks,
        });
      }),
    };
  }
}

// The revoker half of a caretaker. Holding it is the authority to switch the
// grant off; holding the grant is not.
export class Revoker {
  constructor(grant) {
    this.cell = grant.cell;
    this.capability = grant.capability;
  }
  get smarshType() { return 'revoker'; }
  revoke() {
    const already = this.cell.revoked;
    this.cell.revoked = true;
    return !already;
  }
  toString() { return `<revoker ${this.capability}${this.cell.revoked ? ', used' : ''}>`; }
  smarshMembers() {
    return {
      capability: this.capability,
      revoked: this.cell.revoked,
      revoke: nf('revoke', 0, () => this.revoke()),
    };
  }
}

export function expectGrant(v, what, line) {
  const u = v && v.smarshType === 'grant' ? v : null;
  if (!u) throw smarshError('TypeError', `${what} must be a grant`, line);
  return u;
}
