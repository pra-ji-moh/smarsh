import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Interpreter } from '../src/interpreter.js';
import { Label, Policy, Trust, Labelled } from '../src/labels.js';
import { buildManifest, summarise } from '../src/audit.js';

// The integrity half of the label model.
//
// Confidentiality answers "who may see this". Integrity answers "whose word is
// behind it", and every rule is the mirror image: combining values intersects
// the owners instead of unioning them, and it is *strengthening* a policy that
// costs authority rather than weakening one.
//
// The property that matters, and the one a boolean `trusted` flag cannot have:
// a vouch does not survive contact with data nobody vouched for. Nothing has to
// remember to check. It falls out of an ordinary `+`.

function run(source, { principals = [], engine } = {}) {
  const out = [];
  const interp = new Interpreter({ out: (s) => out.push(s), principals, seed: 1, engine });
  try {
    interp.run(source, 't.pedag');
    return { out, error: null, interp };
  } catch (e) {
    return { out, error: e.kind ?? 'error', message: e.message ?? '', help: (e.helps ?? []).join(' '), interp };
  } finally {
    interp.devices.shutdown();
  }
}

const asAlice = (body) => `authority "alice" {\n${body}\n}`;

// ---------------------------------------------------------------------------
// the lattice, directly
// ---------------------------------------------------------------------------

test('the two halves join in opposite directions', () => {
  const a = new Label([new Policy('alice', ['bob'])], [new Trust('alice', [])]);
  const b = new Label([new Policy('bob', ['bob'])], [new Trust('bob', [])]);
  const j = Label.join(a, b);

  // Confidentiality: both owners survive, and only those both permit may read.
  assert.deepEqual(j.owners, ['alice', 'bob']);
  assert.deepEqual([...j.effectiveReaders()].sort(), ['bob']);

  // Integrity: neither survives, because neither saw the other's half.
  assert.deepEqual(j.vouchers, []);
  assert.deepEqual(j.lostVouchers, ['alice', 'bob']);
});

test('a vouch shared by both inputs survives, and widens', () => {
  const a = new Label([], [new Trust('alice', ['x'])]);
  const b = new Label([], [new Trust('alice', ['y'])]);
  const j = Label.join(a, b);
  assert.deepEqual(j.vouchers, ['alice']);
  // It admits both sides' writers now: the value has more hands in it.
  assert.deepEqual([...j.writers()].sort(), ['alice', 'x', 'y']);
});

test('an unlabelled operand is not neutral on the integrity half', () => {
  // This is the whole point. `null` is an unlabelled value: nobody stands
  // behind it, so nothing that touches it is stood behind either.
  const a = new Label([new Policy('alice', [])], [new Trust('alice', [])]);
  const j = Label.join(a, null);
  assert.deepEqual(j.owners, ['alice'], 'confidentiality should carry through');
  assert.deepEqual(j.vouchers, [], 'the vouch should not have survived');
  assert.deepEqual(j.lostVouchers, ['alice']);
});

test('adding a policy to a value is not the same as mixing in another value', () => {
  // `and` is two statements about one value; `join` is two values becoming one.
  // Confusing them would cancel a vouch at the moment it was given.
  const existing = new Label([new Policy('alice', ['bob'])]);
  const vouch = new Label([], [new Trust('alice', [])]);
  assert.deepEqual(Label.and(existing, vouch).vouchers, ['alice']);
  assert.deepEqual(Label.join(existing, vouch).vouchers, []);
});

test('one owner vouching twice narrows what they will tolerate', () => {
  const l = new Label([], [new Trust('alice', ['x', 'y'])]);
  l.vouch(new Trust('alice', ['y', 'z']));
  assert.deepEqual([...l.trusts.get('alice').writers].sort(), ['alice', 'y']);
});

test('a label prints both halves, and what it has lost', () => {
  const l = Label.join(new Label([new Policy('alice', ['bob'])], [new Trust('alice', [])]), null);
  assert.equal(String(l), '{alice: {alice, bob}; ~alice}');
});

// ---------------------------------------------------------------------------
// authority: the asymmetry
// ---------------------------------------------------------------------------

test('vouching for a value needs the authority of whoever is vouching', () => {
  const r = run('let x = endorse(1, "alice", "because")');
  assert.equal(r.error, 'AuthorityError');
  assert.match(r.message, /vouching for a value as `alice`/);
});

test('holding one principal does not let you speak for another', () => {
  const r = run(asAlice('  let x = endorse(1, "bob", "because")'), { principals: ['alice'] });
  assert.equal(r.error, 'AuthorityError');
  assert.match(r.message, /`bob`/);
});

test('withdrawing a vouch needs no authority at all', () => {
  // Weakening integrity can only make a program more careful, so it is free --
  // the exact reverse of confidentiality, where releasing is what costs.
  const r = run([
    asAlice('  let x = endorse(1, "alice", "measured")\n  print(policy_of(x))'),
    'let y = retract(classify(2, "carol"), "alice", "not mine to back")',
    'print("retracted without authority")',
  ].join('\n'), { principals: ['alice'] });
  assert.equal(r.error, null);
  assert.equal(r.out[1], 'retracted without authority');
});

test('endorse insists on a reason', () => {
  const r = run(asAlice('  let x = endorse(1, "alice", "  ")'), { principals: ['alice'] });
  assert.equal(r.error, 'ValueError');
});

// ---------------------------------------------------------------------------
// propagation: the part nothing has to remember to do
// ---------------------------------------------------------------------------

test('a vouch does not survive being combined with a literal', () => {
  const r = run(asAlice([
    '  let x = endorse(100, "alice", "measured")',
    '  print(str(trusted_by(x, "alice")))',
    '  print(str(trusted_by(x + 5, "alice")))',
  ].join('\n')), { principals: ['alice'] });
  assert.equal(r.error, null);
  assert.deepEqual(r.out, ['true', 'false']);
});

test('a value that lost a vouch is distinguishable from one that never had one', () => {
  const r = run(asAlice([
    '  let derived = endorse(100, "alice", "measured") + 5',
    '  print(policy_of(derived))',
    '  print(policy_of(7))',
  ].join('\n')), { principals: ['alice'] });
  assert.deepEqual(r.out, ['{~alice}', '{}']);
});

test('losing a vouch is sticky', () => {
  const r = run(asAlice([
    '  let a = endorse(100, "alice", "measured") + 5',
    '  let b = a * 2 - 1',
    '  print(policy_of(b))',
  ].join('\n')), { principals: ['alice'] });
  assert.equal(r.out[0], '{~alice}');
});

test('the confidentiality half is untouched by any of it', () => {
  // Releasing a value says nothing about who wrote it, and vice versa.
  const r = run(asAlice([
    '  let v = classify(endorse(42, "alice", "measured"), "alice", ["bob"])',
    '  let opened = declassify(v, "alice", "agreed disclosure")',
    '  print(str(trusted_by(opened, "alice")))',
    '  print(str(owners_of(opened)))',
  ].join('\n')), { principals: ['alice'] });
  assert.equal(r.out[0], 'true', 'declassifying dropped the vouch');
  assert.deepEqual(r.out[1], '[]');
});

test('the queries report nothing for a value carrying no label', () => {
  const r = run([
    'print(str(vouchers_of(1)))',
    'print(str(writers_of(1)))',
    'print(str(trusted_by(1, "alice")))',
  ].join('\n'));
  assert.deepEqual(r.out, ['[]', '[]', 'false']);
});

// ---------------------------------------------------------------------------
// the enforcement point
// ---------------------------------------------------------------------------

test('a vouched_by block reads what its principal stands behind', () => {
  const r = run(asAlice([
    '  let x = endorse(100, "alice", "measured")',
    '  vouched_by "alice" { print(str(x)) }',
  ].join('\n')), { principals: ['alice'] });
  assert.equal(r.error, null);
  assert.deepEqual(r.out, ['100']);
});

test('and refuses what it does not', () => {
  const r = run(asAlice([
    '  let x = endorse(100, "alice", "measured") + 5',
    '  vouched_by "alice" { print(str(x)) }',
  ].join('\n')), { principals: ['alice'] });
  assert.equal(r.error, 'LabelError');
  assert.match(r.message, /lost it on the way here/);
  assert.match(r.help, /endorse\(\)/);
});

test('it tells a lost vouch apart from one that was never given', () => {
  const never = run(asAlice([
    '  let x = classify(1, "carol")',
    '  vouched_by "alice" { print(str(x)) }',
  ].join('\n')), { principals: ['alice'] });
  assert.equal(never.error, 'LabelError');
  assert.match(never.message, /does not vouch for/);
  assert.doesNotMatch(never.message, /lost it/);
});

test('a refusal inside the block is recorded, not only raised', () => {
  const r = run(asAlice([
    '  let x = endorse(1, "alice", "measured") + 1',
    '  attempt { vouched_by "alice" { print(str(x)) } } rescue e { print("caught") }',
  ].join('\n')), { principals: ['alice'] });
  const refused = r.interp.trace.crossings.filter((c) => c.kind === 'vouch' && !c.allowed);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].to, 'alice');
});

test('an unlabelled value passes the block, and the docs say why', () => {
  // The block asks "did anything here lose alice's backing", not "did every
  // byte originate with alice". `grounded` is the block for untrusted input.
  const r = run('vouched_by "alice" { print("plain literals are fine") }');
  assert.equal(r.error, null);
});

test('endorsing inside the block is the way through it', () => {
  const r = run(asAlice([
    '  let mixed = endorse(100, "alice", "measured") + 5',
    '  let ok = endorse(mixed, "alice", "reviewed the adjustment")',
    '  vouched_by "alice" { print(str(ok)) }',
  ].join('\n')), { principals: ['alice'] });
  assert.equal(r.error, null);
  assert.deepEqual(r.out, ['105']);
});

test('so is retracting, which claims nothing', () => {
  const r = run(asAlice([
    '  let mixed = endorse(100, "alice", "measured") + 5',
    '  let plain = retract(mixed, "alice", "downstream does not need my backing")',
    '  vouched_by "alice" { print(str(plain)) }',
    '  print(str(trusted_by(plain, "alice")))',
  ].join('\n')), { principals: ['alice'] });
  assert.equal(r.error, null);
  assert.deepEqual(r.out, ['105', 'false'], 'retract must not have claimed a vouch');
});

// ---------------------------------------------------------------------------
// two parties
// ---------------------------------------------------------------------------

test('neither party vouches for what only one of them saw', () => {
  const r = run([
    'authority "alice" { authority "bob" {',
    '  let a = endorse(1, "alice", "alice measured")',
    '  let b = endorse(2, "bob", "bob measured")',
    '  print(str(vouchers_of(a + b)))',
    '  print(policy_of(a + b))',
    '} }',
  ].join('\n'), { principals: ['alice', 'bob'] });
  assert.deepEqual(r.out, ['[]', '{~alice; ~bob}']);
});

test('one party can endorse what came from both, and it is on the record', () => {
  const r = run([
    'authority "alice" { authority "bob" {',
    '  let joint = endorse(1, "alice", "a") + endorse(2, "bob", "b")',
    '  let mine = endorse(joint, "alice", "I checked bobs half myself")',
    '  print(str(vouchers_of(mine)))',
    '} }',
  ].join('\n'), { principals: ['alice', 'bob'] });
  assert.deepEqual(r.out, ['["alice"]']);
  const reasons = r.interp.trace.endorsements.map((e) => e.reason);
  assert.ok(reasons.includes("I checked bobs half myself"));
});

// ---------------------------------------------------------------------------
// the record
// ---------------------------------------------------------------------------

test('the manifest reports endorsements apart from declassifications', () => {
  const r = run(asAlice([
    '  let x = endorse(1, "alice", "measured")',
    '  let y = retract(x, "alice", "no longer mine to back")',
    '  let z = declassify(classify(2, "alice"), "alice", "agreed")',
  ].join('\n')), { principals: ['alice'] });
  const m = buildManifest(r.interp, { file: 't.pedag', source: 'x', outcome: 'completed' });
  assert.equal(m.data.endorsements, 1);
  assert.equal(m.data.vouches_withdrawn, 1);
  assert.equal(m.data.declassifications, 1);

  const kinds = m.events.map((e) => e.event);
  assert.ok(kinds.includes('data.endorsed'));
  assert.ok(kinds.includes('data.vouch_withdrawn'));
  assert.ok(kinds.includes('data.declassified'));

  const text = summarise(m);
  assert.match(text, /endorsed\s+1 vouched for, 1 withdrawn/);
});

test('the manifest names the principals the run could act for', () => {
  // Without this the events read as `data.endorsed alice` with nothing saying
  // the run was ever empowered to do that -- and the replay line was wrong.
  const r = run(asAlice('  let x = endorse(1, "alice", "measured")'), { principals: ['alice'] });
  const m = buildManifest(r.interp, { file: 't.pedag', source: 'x', outcome: 'completed' });
  assert.deepEqual(m.replay.principals, ['alice']);
  const text = summarise(m);
  assert.match(text, /acted for\s+alice/);
  assert.match(text, /--principal alice/);
});

// ---------------------------------------------------------------------------
// both engines
// ---------------------------------------------------------------------------

test('the compiled engine agrees with the reference on all of it', () => {
  const source = asAlice([
    '  let a = endorse(100, "alice", "measured")',
    '  let b = a + 5',
    '  print(policy_of(a) + " | " + policy_of(b))',
    '  print(str(vouchers_of(a)) + " | " + str(vouchers_of(b)))',
    '  let c = endorse(b, "alice", "reviewed")',
    '  vouched_by "alice" { print("through: " + str(c)) }',
  ].join('\n'));
  const fast = run(source, { principals: ['alice'], engine: 'fast' });
  const tree = run(source, { principals: ['alice'], engine: 'tree' });
  assert.deepEqual(fast.out, tree.out);
  assert.equal(fast.error, null);
  assert.equal(tree.error, null);
});

test('a labelled value carries both halves in its members', () => {
  const v = new Labelled(1, new Label([new Policy('alice', ['bob'])], [new Trust('alice', [])]));
  const m = v.pedagMembers();
  assert.deepEqual(m.owners, ['alice']);
  assert.deepEqual(m.readers, ['alice', 'bob']);
  assert.deepEqual(m.vouchers, ['alice']);
  assert.deepEqual(m.writers, ['alice']);
  assert.deepEqual(m.lost_vouchers, []);
});
