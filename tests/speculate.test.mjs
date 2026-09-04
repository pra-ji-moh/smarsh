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
  assert.deepEqual(r.output, ['nil'], 'high stakes did not raise the bar');
});

test('a claim that resists being formalised needs more evidence', () => {
  const r = run(`print(str(${gate('"used": 9, "available": 10, "stakes": 0.1, "formalizability": 0.05')}))`);
  assert.deepEqual(r.output, ['nil']);
});

test('a region that has been wrong lately is refused on the same evidence', () => {
  const clean = run(`print(str(${gate('"used": 9, "available": 10, "stakes": 0.5, "formalizability": 0.9')}))`);
  const burned = run(`print(str(${gate('"used": 9, "available": 10, "stakes": 0.5, "formalizability": 0.9, "history": [{"age": 0, "rejected": true}, {"age": 1, "rejected": true}]')}))`);
  assert.equal(clean.output[0], '0.9');
  assert.deepEqual(burned.output, ['nil'], 'rejection history did not count against it');
});

test('no grounding at all is refused, whatever the bar', () => {
  const r = run(`print(str(${gate('"used": 0, "available": 0, "stakes": 0.5, "formalizability": 0.9')}))`);
  assert.deepEqual(r.output, ['nil'], 'the gate cleared a query with no evidence behind it');
});

test('the program is told the behaviour and nothing else', () => {
  // A refusal is `nil`: no score, no margin, nothing to retry against.
  const r = run([
    `let d = ${gate('"used": 1, "available": 10, "stakes": 0.9, "formalizability": 1')}`,
    'print(str(d))',
    'print(str(d == nil))',
  ].join('\n'));
  assert.deepEqual(r.output, ['nil', 'true']);
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
