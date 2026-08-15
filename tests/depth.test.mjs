import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Interpreter } from '../src/interpreter.js';
import { SarvmError } from '../src/errors.js';
import { Label, Policy, Labelled } from '../src/labels.js';
import { Grant, Revoker } from '../src/grants.js';

function run(src, opts = {}) {
  const out = [];
  const interp = new Interpreter({ ...opts, out: (s) => out.push(s) });
  try {
    return { value: interp.run(src, '<t>'), out, interp };
  } finally {
    interp.devices.shutdown();
  }
}

function fails(src, opts = {}) {
  try {
    run(src, opts);
  } catch (e) {
    if (e instanceof SarvmError) return e;
    throw e;
  }
  throw new Error('expected the program to fail, but it ran cleanly');
}

// ---------------------------------------------------------------------------
// contracts, at Eiffel's depth
// ---------------------------------------------------------------------------

test('old() names the value on the way in', () => {
  const { value } = run(`
    record Account(holder, balance)
    fn withdraw(a, amount)
      requires amount > 0
      ensures result.balance == old(a.balance) - amount
    { return a.with("balance", a.balance - amount) }
    withdraw(Account("ada", 100), 30).balance
  `);
  assert.equal(value, 70);
});

test('a postcondition using old() catches a wrong amount', () => {
  const e = fails(`
    record Account(holder, balance)
    fn withdraw(a, amount) ensures result.balance == old(a.balance) - amount {
      return a.with("balance", a.balance - (amount * 2))
    }
    withdraw(Account("ada", 100), 10)
  `);
  assert.equal(e.kind, 'ContractError');
  assert.match(e.message, /old\(a\.balance\)/);
});

test('old() is captured before the body, not after', () => {
  const { value } = run(`
    fn grow(xs) ensures result > old(xs.len()) {
      var copy = []
      for x in xs { copy.push(x) }
      copy.push(99)
      return copy.len()
    }
    grow([1, 2])
  `);
  assert.equal(value, 3);
});

test('old() outside a postcondition is refused', () => {
  const e = fails('old(1)');
  assert.equal(e.kind, 'ContractError');
  assert.match(e.message, /only means something inside an `ensures`/);
});

test('a record invariant holds at construction', () => {
  assert.equal(run('record A(b) invariant b >= 0\nA(5).b').value, 5);
  const e = fails('record A(b) invariant b >= 0\nA(-1)');
  assert.equal(e.kind, 'ContractError');
  assert.match(e.message, /`A` requires `b >= 0`/);
});

test('a record invariant cannot be walked around with with()', () => {
  const e = fails('record A(b) invariant b >= 0\nA(5).with("b", -1)');
  assert.equal(e.kind, 'ContractError');
});

test('a record invariant may mention several fields', () => {
  assert.equal(run(`
    record Range(lo, hi) invariant lo <= hi
    Range(1, 5).hi
  `).value, 5);
  assert.equal(fails('record Range(lo, hi) invariant lo <= hi\nRange(5, 1)').kind, 'ContractError');
});

test('a loop invariant is checked before and after every pass', () => {
  assert.equal(run(`
    var total = 0
    var i = 0
    while i < 5 invariant total >= 0 { total = total + i  i = i + 1 }
    total
  `).value, 10);

  const e = fails('var k = 0\nwhile k < 3 invariant k < 2 { k = k + 1 }');
  assert.equal(e.kind, 'LoopError');
  assert.match(e.message, /invariant `k < 2` does not hold/);
});

test('a loop invariant false at the start is caught before any pass', () => {
  const e = fails('var k = 5\nwhile k > 0 invariant k < 3 { k = k - 1 }');
  assert.equal(e.kind, 'LoopError');
  assert.match(e.message, /before the loop/);
});

test('a variant proves termination, and catches a loop that does not', () => {
  assert.equal(run(`
    var i = 0
    var n = 4
    while i < n variant n - i { i = i + 1 }
    i
  `).value, 4);

  const e = fails('var j = 0\nwhile j < 5 variant 5 - j { j = j - 1 }');
  assert.equal(e.kind, 'LoopError');
  assert.match(e.message, /did not decrease \(5 then 6\)/);
  assert.match(e.helps.join(' '), /strictly decrease/);
});

test('a variant that goes negative is caught', () => {
  const e = fails('var i = 0\nwhile i < 5 variant 2 - i { i = i + 1 }');
  assert.equal(e.kind, 'LoopError');
  assert.match(e.message, /went negative/);
});

test('for loops carry contracts too', () => {
  assert.equal(run(`
    var seen = 0
    for x in [1, 2, 3] invariant seen >= 0 { seen = seen + x }
    seen
  `).value, 6);
});

test('a loop with no contracts costs nothing and behaves as before', () => {
  assert.equal(run('var n = 0\nwhile n < 3 { n = n + 1 }\nn').value, 3);
});

// ---------------------------------------------------------------------------
// the decentralized label model
// ---------------------------------------------------------------------------

test('a policy names an owner and its readers', () => {
  const { value } = run('policy_of(classify(1, "hr", ["payroll"]))');
  assert.equal(value, '{hr: {hr, payroll}}');
});

test('an owner can always read their own data', () => {
  assert.deepEqual(run('readers_of(classify(1, "hr", []))').value, ['hr']);
});

test('joining two owners intersects the readers', () => {
  // This is the direction that matters: combining data does not widen access.
  const { value } = run(`
    let a = classify(1, "hr", ["hr", "payroll", "legal"])
    let both = classify(a, "audit", ["audit", "payroll"])
    readers_of(both)
  `);
  assert.deepEqual(value, ['payroll']);
});

test('labels survive being computed with', () => {
  // The policy follows the data, not the variable it was first put in.
  assert.equal(run('policy_of(classify(1, "hr", []) + 1)').value, '{hr: {hr}}');
  assert.equal(run('policy_of(classify(2, "hr", []) * 3)').value, '{hr: {hr}}');
  assert.equal(run('policy_of(classify(2, "hr", []) - 1)').value, '{hr: {hr}}');
  // And a value combined with another owner's data carries both.
  assert.equal(
    run('policy_of(classify(1, "hr", ["x"]) + classify(2, "audit", ["x"]))').value,
    '{audit: {audit, x}; hr: {hr, x}}',
  );
});

test('release_to refuses a party the owners do not permit', () => {
  const e = fails(`
    let s = classify(82000, "hr", ["hr", "payroll"])
    release_to "marketing" { print(s) }
  `);
  assert.equal(e.kind, 'LabelError');
  assert.match(e.message, /`marketing` may not read/);
  assert.match(e.notes.join(' '), /hr: \{hr, payroll\}/);
});

test('release_to permits a reader the owners allow', () => {
  const { out } = run(`
    let s = classify(82000, "hr", ["hr", "payroll"])
    release_to "payroll" { print("ok") }
  `);
  assert.deepEqual(out, ['ok']);
});

test('an unlabelled value is readable by anyone', () => {
  assert.deepEqual(run('release_to "anyone" { print("fine") }').out, ['fine']);
});

test('declassification needs the owning principal authority', () => {
  const e = fails(`
    let s = classify(1, "hr", [])
    declassify(s, "hr", "approved")
  `);
  assert.equal(e.kind, 'AuthorityError');
  assert.match(e.message, /needs `hr`'s authority/);
});

test('authority must be granted at the boundary, not taken from inside', () => {
  const e = fails('authority "hr" { print(1) }');
  assert.equal(e.kind, 'AuthorityError');
  assert.match(e.message, /does not act for `hr`/);
  assert.match(e.helps.join(' '), /--principal hr/);
});

test('with authority, an owner may declassify their own policy', () => {
  const { value } = run(`
    let s = classify(42, "hr", [])
    authority "hr" { declassify(s, "hr", "signed off") }
  `, { principals: ['hr'] });
  assert.equal(value, 42);
});

// The property a blanket trust() cannot express.
test('one principal authority does not release another principal data', () => {
  const e = fails(`
    let s = classify(1, "audit", [])
    authority "hr" { declassify(s, "audit", "not mine to release") }
  `, { principals: ['hr', 'audit'] });
  assert.equal(e.kind, 'AuthorityError');
  assert.match(e.message, /needs `audit`'s authority; this frame acts for hr/);
});

test('declassifying one owner leaves the others in place', () => {
  const { value } = run(`
    let s = classify(classify(1, "hr", ["x"]), "audit", ["x"])
    authority "hr" { policy_of(declassify(s, "hr", "signed off")) }
  `, { principals: ['hr'] });
  assert.equal(value, '{audit: {audit, x}}');
});

test('authority lasts only for its block', () => {
  const { value } = run('let a = acting_for()\nauthority "hr" { }\n[a, acting_for()]', { principals: ['hr'] });
  assert.deepEqual(value, [[], []]);
});

test('declassification is recorded with its reason', () => {
  const { interp } = run(`
    let s = classify(1, "hr", [])
    authority "hr" { declassify(s, "hr", "quarterly disclosure") }
  `, { principals: ['hr'] });
  assert.equal(interp.trace.declassifications.length, 1);
  assert.match(interp.trace.declassifications[0].reason, /quarterly disclosure/);
});

test('declassify refuses a reason-free call and a policy that is not there', () => {
  assert.equal(fails('authority "hr" { declassify(classify(1,"hr",[]), "hr", "") }',
    { principals: ['hr'] }).kind, 'ValueError');
  assert.equal(fails('authority "hr" { declassify(classify(1,"audit",[]), "hr", "why") }',
    { principals: ['hr'] }).kind, 'AuthorityError');
});

test('the Label type behaves under direct use', () => {
  const l = new Label([new Policy('a', ['a', 'b', 'c'])]);
  assert.ok(l.canRead('b'));
  assert.equal(l.canRead('z'), false);
  const joined = Label.join(l, new Label([new Policy('d', ['c'])]));
  assert.deepEqual([...joined.effectiveReaders()].sort(), ['c']);
  assert.deepEqual(joined.without('a').owners, ['d']);
});

// ---------------------------------------------------------------------------
// revocable capabilities
// ---------------------------------------------------------------------------

const FS = { caps: ['fs'] };

test('a grant delegates a capability the frame already holds', () => {
  const { value } = run(`
    fn worker(access) { using access { return caps().contains("fs") } }
    worker(grant("fs"))
  `, FS);
  assert.equal(value, true);
});

test('a frame cannot grant what it does not hold', () => {
  const e = fails('fn f() { return grant("fs") }\nf()', FS);
  assert.equal(e.kind, 'CapabilityError');
  assert.match(e.message, /does not hold/);
  assert.match(e.notes.join(' '), /does not create any/);
});

test('a caretaker can be revoked afterwards', () => {
  const e = fails(`
    fn worker(access) { using access { return 1 } }
    let pair = caretaker(grant("fs"))
    worker(pair["grant"])
    revoke(pair["revoker"])
    worker(pair["grant"])
  `, FS);
  assert.equal(e.kind, 'CapabilityError');
  assert.match(e.message, /has been revoked/);
});

test('revocation is transitive through anything derived', () => {
  const e = fails(`
    let pair = caretaker(grant("fs"))
    let derived = pair["grant"].attenuate({ "uses": 99 })
    revoke(pair["revoker"])
    using derived { print("no") }
  `, FS);
  assert.equal(e.kind, 'CapabilityError');
  assert.match(e.message, /revoked/);
});

test('a use-limited grant runs out', () => {
  const e = fails(`
    let g = grant("fs").attenuate({ "uses": 2 })
    using g { }
    using g { }
    using g { }
  `, FS);
  assert.match(e.message, /uses are spent/);
});

test('a deadline grant expires on logical time', () => {
  const e = fails(`
    let g = grant("fs").attenuate({ "for": 5 })
    using g { }
    advance(10)
    using g { }
  `, FS);
  assert.match(e.message, /expired at t=5 and it is now t=10/);
});

test('attenuation only ever narrows', () => {
  assert.equal(run('grant("fs").attenuate({ "uses": 5 }).attenuate({ "uses": 100 }).uses_left', FS).value, 5);
  assert.equal(run('grant("fs").attenuate({ "uses": 100 }).attenuate({ "uses": 3 }).uses_left', FS).value, 3);
});

test('attenuating to nothing at all is refused', () => {
  assert.equal(fails('grant("fs").attenuate({ })', FS).kind, 'ValueError');
});

test('a delegated capability lasts only for the using block', () => {
  const { value } = run(`
    let g = grant("fs")
    let inside = false
    fn check(access) {
      var held = false
      using access { held = caps().contains("fs") }
      return [held, caps().contains("fs")]
    }
    check(g)
  `, FS);
  assert.deepEqual(value, [true, false]);
});

test('using something that is not a grant says so', () => {
  const e = fails('using 5 { }', FS);
  assert.equal(e.kind, 'TypeError');
  assert.match(e.helps.join(' '), /grant\("fs"\)/);
});

test('grant use and revocation are recorded', () => {
  const { interp } = run(`
    let pair = caretaker(grant("fs"))
    using pair["grant"] { }
    revoke(pair["revoker"])
  `, FS);
  assert.equal(interp.trace.grantUses.length, 1);
  assert.equal(interp.trace.revocations.length, 1);
});

test('revoking twice reports that the first one did it', () => {
  const { value } = run(`
    let pair = caretaker(grant("fs"))
    [revoke(pair["revoker"]), revoke(pair["revoker"])]
  `, FS);
  assert.deepEqual(value, [true, false]);
});

test('the Grant type behaves under direct use', () => {
  const g = new Grant('fs', { uses: 2 });
  assert.equal(g.isLive(0), true);
  g.spend();
  g.spend();
  assert.equal(g.isLive(0), false);
  const parent = new Grant('fs');
  const child = parent.attenuate({ uses: 3 });
  new Revoker(parent).revoke();
  assert.equal(child.isLive(0), false, 'a child of a revoked grant must be dead');
});
