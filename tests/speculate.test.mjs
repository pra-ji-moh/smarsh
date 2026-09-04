import { test } from 'node:test';
import assert from 'node:assert/strict';

import { coverage, rejectionRate, support, threshold, decide } from '../src/speculate.js';
import { run } from '../src/index.js';

// The speculation gate. `ungrounded` says whether a claim is grounded; this
// says whether it is grounded *enough*, given what being wrong would cost.
//
// The property that matters is not the arithmetic, which is small. It is that
// the program learns only the behaviour, while the record keeps the reasoning:
// a program that could see its own margin could retry until it cleared the bar.

// ---------------------------------------------------------------------------
// the arithmetic
// ---------------------------------------------------------------------------

test('coverage is the share of available grounding that was used', () => {
  assert.equal(coverage(5, 10), 0.5);
  assert.equal(coverage(10, 10), 1);
  assert.equal(coverage(0, 10), 0);
});

test('nothing available means no support, not full coverage of nothing', () => {
  // 0/0 is the case where a division would either throw or quietly report 1.
  assert.equal(coverage(0, 0), 0);
  assert.equal(coverage(3, 0), 0);
});

test('rejections decay, so a region that has improved stops being punished', () => {
  const old = rejectionRate([{ age: 20, rejected: true }, { age: 0, rejected: false }], 0.9);
  const fresh = rejectionRate([{ age: 0, rejected: true }, { age: 20, rejected: false }], 0.9);
  assert.ok(old < fresh, 'an old rejection weighs as much as a recent one');
});

test('a region with no history is not treated as a suspicious one', () => {
  assert.equal(rejectionRate([], 0.9), 0);
});

test('support is coverage discounted by recent rejection', () => {
  assert.equal(support(1, 0), 1);
  assert.equal(support(1, 1), 0);
  assert.equal(support(0.8, 0.5), 0.4);
});

test('the bar takes the stricter of stakes and unformalizability', () => {
  assert.equal(threshold(0.9, 1), 0.9);      // stakes dominate
  assert.equal(threshold(0.1, 0.2), 0.8);    // hard to formalise dominates
});

test('a decision without a stated bar is refused rather than guessed', () => {
  // The one failure mode that matters: defaulting the bar puts it at zero and
  // the gate clears everything, including a query with nothing behind it.
  assert.throws(() => decide({ used: 9, available: 10 }), /stakes and formalizability/);
  assert.throws(() => decide({ used: 9, available: 10, stakes: 0.5 }), /stakes and formalizability/);
});

// ---------------------------------------------------------------------------
// the behaviour a program sees
// ---------------------------------------------------------------------------

const gate = (fields) => `speculate({ ${fields} })`;

test('well grounded and low stakes clears the bar', () => {
  const r = run(`print(str(${gate('"used": 9, "available": 10, "stakes": 0.2, "formalizability": 0.9')}))`);
  assert.equal(r.ok, true);
  assert.equal(r.output[0], '0.9');
});

test('the same evidence is refused when more is at stake', () => {
  const r = run(`print(str(${gate('"used": 9, "available": 10, "stakes": 0.95, "formalizability": 0.9')}))`);
  assert.deepEqual(r.output, ['groundless'], 'high stakes did not raise the bar');
});

test('a claim that resists being formalised needs more evidence', () => {
  const r = run(`print(str(${gate('"used": 9, "available": 10, "stakes": 0.1, "formalizability": 0.05')}))`);
  assert.deepEqual(r.output, ['groundless']);
});

test('a region that has been wrong lately is refused on the same evidence', () => {
  const clean = run(`print(str(${gate('"used": 9, "available": 10, "stakes": 0.5, "formalizability": 0.9')}))`);
  const burned = run(`print(str(${gate('"used": 9, "available": 10, "stakes": 0.5, "formalizability": 0.9, "history": [{"age": 0, "rejected": true}, {"age": 1, "rejected": true}]')}))`);
  assert.equal(clean.output[0], '0.9');
  assert.deepEqual(burned.output, ['groundless'], 'rejection history did not count against it');
});

test('no grounding at all is refused, whatever the bar', () => {
  const r = run(`print(str(${gate('"used": 0, "available": 0, "stakes": 0.5, "formalizability": 0.9')}))`);
  assert.deepEqual(r.output, ['groundless'], 'the gate cleared a query with no evidence behind it');
});

test('the program is told the behaviour and nothing else', () => {
  // A refusal carries no score, no margin, nothing to retry against.
  const r = run([
    `let d = ${gate('"used": 1, "available": 10, "stakes": 0.9, "formalizability": 1')}`,
    'print(str(d))',
  ].join('\n'));
  assert.deepEqual(r.output, ['groundless']);
});

// ---------------------------------------------------------------------------
// what the record keeps
// ---------------------------------------------------------------------------

test('a refusal is recorded with the numbers the program never saw', () => {
  const r = run(`let d = ${gate('"used": 1, "available": 10, "stakes": 0.9, "formalizability": 1')}`);
  const events = r.manifest.events.filter((e) => e.event === 'speculation.refused');
  assert.equal(events.length, 1, 'the refusal was not recorded');

  const e = events[0];
  assert.equal(e.threshold, 0.9);
  assert.equal(e.support, 0.1);
  assert.equal(e.coverage, 0.1);
  assert.ok(e.line > 0, 'the refusal has no line to point at');
});

test('clearing the bar is recorded too, not only refusal', () => {
  const r = run(`let d = ${gate('"used": 10, "available": 10, "stakes": 0.2, "formalizability": 1')}`);
  const events = r.manifest.events.filter((e) => e.event === 'speculation.cleared');
  assert.equal(events.length, 1);
  assert.equal(events[0].support, 1);
  assert.equal(events[0].intensity, 1);
});

test('every gate is recorded, not just the last one', () => {
  const src = [
    `let a = ${gate('"used": 10, "available": 10, "stakes": 0.1, "formalizability": 1')}`,
    `let b = ${gate('"used": 1, "available": 10, "stakes": 0.9, "formalizability": 1')}`,
    `let c = ${gate('"used": 10, "available": 10, "stakes": 0.1, "formalizability": 1')}`,
  ].join('\n');
  const r = run(src);
  const gates = r.manifest.events.filter((e) => String(e.event).startsWith('speculation.'));
  assert.equal(gates.length, 3);
  assert.deepEqual(gates.map((e) => e.event), [
    'speculation.cleared', 'speculation.refused', 'speculation.cleared',
  ]);
});

test('the decision replays: same inputs, same record', () => {
  const src = `let d = ${gate('"used": 7, "available": 9, "stakes": 0.3, "formalizability": 0.8, "history": [{"age": 2, "rejected": true}]')}`;
  const a = run(src, { seed: 1 });
  const b = run(src, { seed: 1 });
  assert.equal(a.manifest.head, b.manifest.head, 'two identical runs disagree');
});

// ---------------------------------------------------------------------------
// refusing bad input rather than deciding on it
// ---------------------------------------------------------------------------

test('the bar must be stated, and must be a proportion', () => {
  assert.equal(run('let d = speculate({ "used": 9, "available": 10 })').ok, false);
  for (const bad of ['"stakes": 2, "formalizability": 1', '"stakes": 0.5, "formalizability": -1']) {
    const r = run(`let d = ${gate(`"used": 9, "available": 10, ${bad}`)}`);
    assert.equal(r.ok, false, `${bad} was accepted`);
    assert.equal(r.error.kind, 'ValueError');
  }
});

test('a decay outside (0, 1] is refused', () => {
  for (const g of [0, 1.5, -0.5]) {
    const r = run(`let d = ${gate(`"used": 9, "available": 10, "stakes": 0.1, "formalizability": 1, "gamma": ${g}`)}`);
    assert.equal(r.ok, false, `gamma ${g} was accepted`);
  }
});

test('a malformed history is refused rather than ignored', () => {
  const notList = run(`let d = ${gate('"used": 9, "available": 10, "stakes": 0.1, "formalizability": 1, "history": 5')}`);
  assert.equal(notList.ok, false);

  const negative = run(`let d = ${gate('"used": 9, "available": 10, "stakes": 0.1, "formalizability": 1, "history": [{"age": 0 - 1, "rejected": true}]')}`);
  assert.equal(negative.ok, false, 'a negative age was accepted');
});

test('speculate needs a map, not a bare number', () => {
  assert.equal(run('let d = speculate(5)').ok, false);
});

// ---------------------------------------------------------------------------
// no grounds is not no value
// ---------------------------------------------------------------------------

test('a refusal is a different thing from a missing value', () => {
  // The conflation this exists to avoid. A caller that cannot tell a refusal
  // from an absent field treats the refusal as an absent field and carries on,
  // which is the failure the whole gate was built to prevent.
  const r = run([
    `let d = ${gate('"used": 1, "available": 10, "stakes": 0.9, "formalizability": 1')}`,
    'print(str(d == nil))',
    'print(str(is_groundless(d)))',
    'print(type(d))',
  ].join('\n'));
  assert.deepEqual(r.output, ['false', 'true', 'groundless'],
    'a refusal is indistinguishable from nil');
});

test('a refusal does not take a branch', () => {
  const r = run([
    `let d = ${gate('"used": 1, "available": 10, "stakes": 0.9, "formalizability": 1')}`,
    'if d { print("ran") } else { print("did not run") }',
  ].join('\n'));
  assert.deepEqual(r.output, ['did not run']);
});

test('clearing the bar returns a number, not a marker', () => {
  const r = run([
    `let d = ${gate('"used": 10, "available": 10, "stakes": 0.2, "formalizability": 1')}`,
    'print(str(is_groundless(d)))',
    'print(str(d + 0))',
  ].join('\n'));
  assert.deepEqual(r.output, ['false', '1']);
});

// ---------------------------------------------------------------------------
// propagation: a refusal does not become an answer
// ---------------------------------------------------------------------------

const refused = `speculate({ "used": 1, "available": 10, "stakes": 0.9, "formalizability": 1 })`;

test('arithmetic on a refusal stays a refusal', () => {
  const r = run([
    `let d = ${refused}`,
    'print(str(d + 1))',
    'print(str(d * 100))',
    'print(str((d + 1) * 2))',
  ].join('\n'));
  assert.deepEqual(r.output, ['groundless', 'groundless', 'groundless'],
    'a refusal was computed into a number');
});

test('propagation does not depend on which side the refusal is', () => {
  const r = run([
    `let d = ${refused}`,
    'print(str(1 + d))',
    'print(str(100 / d))',
  ].join('\n'));
  assert.deepEqual(r.output, ['groundless', 'groundless']);
});

test('a refusal cannot pass a threshold check', () => {
  // The failure this prevents: `if score > limit` silently taking the false
  // branch on a refusal is fine, but taking the TRUE branch would treat "no
  // grounds" as "cleared", which is the whole failure mode.
  const r = run([
    `let d = ${refused}`,
    'print(str(d > 0))',
    'if d > 0 { print("passed") } else { print("did not pass") }',
  ].join('\n'));
  assert.deepEqual(r.output, ['groundless', 'did not pass']);
});

test('equality stays concrete, or the distinction cannot be observed', () => {
  const r = run([
    `let d = ${refused}`,
    'print(str(d == nil))',
    'print(str(d != nil))',
    'print(str(d == d))',
  ].join('\n'));
  assert.deepEqual(r.output, ['false', 'true', 'true']);
});

test('a refusal is not laundered by being caught', () => {
  // Propagating rather than throwing matters here: if arithmetic on a refusal
  // raised, a caller would wrap it, rescue it, and substitute a value, which
  // turns "no grounds" back into an answer.
  const r = run([
    `let d = ${refused}`,
    'attempt { let x = d + 1\n print(str(x)) } rescue e { print("substituted") }',
  ].join('\n'));
  assert.deepEqual(r.output, ['groundless'], 'the refusal threw and could be swallowed');
});

test('both engines agree about refusals', () => {
  const src = [
    `let d = ${refused}`,
    'print(str(d))',
    'print(str(d + 1))',
    'print(str(d > 0))',
    'print(str(d == nil))',
  ].join('\n');
  const fast = run(src);
  const tree = run(src, { engine: 'tree' });
  assert.deepEqual(fast.output, tree.output, 'the two engines disagree about a refusal');
  assert.deepEqual(fast.output, ['groundless', 'groundless', 'groundless', 'false']);
});

// ---------------------------------------------------------------------------
// a checked context will not read a refusal
// ---------------------------------------------------------------------------

test('a grounded block refuses a groundless value', () => {
  // `grounded` stopped `ungrounded` and `untrusted` and let an actual refusal
  // through, because the check returned early for anything that was not a
  // taint label. Stopping the weaker statement while admitting the stronger
  // one is backwards.
  const r = run([
    `let d = ${refused}`,
    'grounded { print(str(d)) }',
  ].join('\n'));
  assert.equal(r.ok, false, 'a checked context read a refusal');
  assert.equal(r.error.kind, 'TaintError');
  assert.match(r.error.message, /groundless/);
});

test('a refusal cannot enter a checked context through interpolation either', () => {
  const r = run([
    `let d = ${refused}`,
    'grounded { print("the answer is ${d}") }',
  ].join('\n'));
  assert.equal(r.ok, false, 'interpolation carried a refusal into a checked context');
  assert.equal(r.error.kind, 'TaintError');
});

test('a cleared value passes a checked context', () => {
  const r = run([
    `let d = ${gate('"used": 10, "available": 10, "stakes": 0.2, "formalizability": 1')}`,
    'grounded { print(str(d)) }',
  ].join('\n'));
  assert.equal(r.ok, true, 'a cleared value was refused by a checked context');
  assert.deepEqual(r.output, ['1']);
});

test('both engines refuse a refusal in a checked context', () => {
  const src = [
    `let d = ${refused}`,
    'attempt { grounded { print(str(d)) } } rescue e { print(e["kind"]) }',
  ].join('\n');
  const fast = run(src);
  const tree = run(src, { engine: 'tree' });
  assert.deepEqual(fast.output, tree.output);
  assert.deepEqual(fast.output, ['TaintError']);
});

// ---------------------------------------------------------------------------
// domain/derivable: grounding computed from a real possibility set, not
// asserted as a bare used/available number
// ---------------------------------------------------------------------------

const domainGate = (fields) => `speculate({ ${fields} })`;

test('used/available computed correctly from domain/derivable sizes', () => {
  // domain of 5, derivable of 2 -> used=3, available=5 -> coverage=0.6,
  // matching S(n) = 1 - |D(n)|/|Dom(n)| already verified against brute-force
  // ground truth in the Python prototype for this exact 5-entity case.
  const r = run(`let d = ${domainGate('"domain": [0,1,2,3,4], "derivable": [3,4], "stakes": 0.5, "formalizability": 1')}`);
  const events = r.manifest.events.filter((e) => e.event === 'speculation.cleared');
  assert.equal(events.length, 1);
  assert.equal(events[0].support, 0.6, 'coverage from domain/derivable did not match the verified S');
});

test('the same boundary case verified in the Python prototype: S=0.6 speculates, S=0.4 declines', () => {
  const above = run(`print(str(${domainGate('"domain": [0,1,2,3,4], "derivable": [3,4], "stakes": 0.5, "formalizability": 1')}))`);
  const below = run(`print(str(${domainGate('"domain": [0,1,2,3,4], "derivable": [1,2,3], "stakes": 0.5, "formalizability": 1')}))`);
  assert.equal(above.output[0], '0.6');
  assert.deepEqual(below.output, ['groundless']);
});

test('a derivable value outside the domain is refused as a fabricated claim', () => {
  const r = run(domainGate('"domain": [0,1,2], "derivable": [0,99], "stakes": 0.5, "formalizability": 1'));
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'ValueError');
  assert.match(r.error.message, /not in 'domain'/);
});

test('an empty domain is refused rather than treated as certain', () => {
  const r = run(domainGate('"domain": [], "derivable": [], "stakes": 0.5, "formalizability": 1'));
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'ValueError');
});

test('used/available and domain/derivable together is ambiguous, not silently resolved', () => {
  const r = run(domainGate('"used": 1, "available": 2, "domain": [0,1], "derivable": [0], "stakes": 0.5, "formalizability": 1'));
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'ValueError');
  assert.match(r.error.message, /not both/);
});

test('domain/derivable deduplicates, so a repeated value is not double-counted', () => {
  // derivable=[1,1,2] is really {1,2}, size 2, same as derivable=[1,2].
  const a = run(`print(str(${domainGate('"domain": [0,1,2,3,4], "derivable": [3,3,4], "stakes": 0.5, "formalizability": 1')}))`);
  const b = run(`print(str(${domainGate('"domain": [0,1,2,3,4], "derivable": [3,4], "stakes": 0.5, "formalizability": 1')}))`);
  assert.deepEqual(a.output, b.output);
});

test('domain/derivable and used/available agree when they describe the same grounding', () => {
  // available=5, used=3 (2 remain possible) should be exactly the domain/derivable
  // case above, since coverage() is domain-agnostic -- only the builtin's
  // wiring changed, not the arithmetic underneath it.
  const viaNumbers = run(`print(str(${gate('"used": 3, "available": 5, "stakes": 0.5, "formalizability": 1')}))`);
  const viaSets = run(`print(str(${domainGate('"domain": [0,1,2,3,4], "derivable": [3,4], "stakes": 0.5, "formalizability": 1')}))`);
  assert.deepEqual(viaNumbers.output, viaSets.output);
});
