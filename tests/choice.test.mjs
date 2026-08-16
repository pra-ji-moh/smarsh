import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Interpreter } from '../src/interpreter.js';
import { PedagError } from '../src/errors.js';
import { parse } from '../src/parser.js';
import { analyze } from '../src/analysis.js';
import { typecheck } from '../src/types.js';
import { formatSource } from '../src/format.js';

// Sum types, and the reason they are worth having: a `match` that misses a
// variant is caught before the program runs rather than becoming a MatchError
// on whichever input finally reaches it.

function run(source, { caps = [] } = {}) {
  const out = [];
  const interp = new Interpreter({ out: (s) => out.push(s), caps, seed: 1 });
  try {
    const result = interp.run(source, 't.pedag');
    return { out, result };
  } finally {
    interp.devices.shutdown();
  }
}

const findings = (source) => analyze(parse(source, 't.pedag'))
  .filter((f) => f.kind === 'inexhaustive match');

const SHAPE = `choice Shape {
  Circle(radius)
  Rect(width, height)
  Empty
}
`;

// ---------------------------------------------------------------------------
// the values
// ---------------------------------------------------------------------------

test('a variant with fields constructs like a record', () => {
  const { out } = run(`${SHAPE}print(Circle(2))\nprint(Circle(2).radius)`);
  assert.deepEqual(out, ['Circle(radius: 2)', '2']);
});

test('a variant with no fields is a value, not a constructor', () => {
  // There is only one `Empty`, so calling it would be asking for a second.
  const { out } = run(`${SHAPE}print(Empty)\nprint(Empty == Empty)`);
  assert.deepEqual(out, ['Empty', 'true']);
});

test('variants of the same choice are distinguishable', () => {
  const { out } = run(`${SHAPE}print(Circle(1) == Circle(1))\nprint(Circle(1) == Empty)`);
  assert.deepEqual(out, ['true', 'false']);
});

test('records with the same shape from different variants are not equal', () => {
  const { out } = run(`choice A { One(v) }\nchoice B { Two(v) }\nprint(One(1) == Two(1))`);
  assert.deepEqual(out, ['false']);
});

test('the choice itself names its variants', () => {
  const { out } = run(`${SHAPE}print(Shape)`);
  assert.deepEqual(out, ['<choice Shape(Circle | Rect | Empty)>']);
});

test('a variant may carry an invariant, like any record', () => {
  const source = 'choice N { Pos(v) invariant v > 0\n  Zero }\n';
  assert.deepEqual(run(`${source}print(Pos(1))`).out, ['Pos(v: 1)']);
  assert.throws(() => run(`${source}print(Pos(0))`), (e) => e instanceof PedagError && e.kind === 'ContractError');
});

test('matching destructures the variant', () => {
  const { out } = run(`${SHAPE}
fn area(s) {
  return match s {
    Circle(r) => 3 * r * r,
    Rect(w, h) => w * h,
    Empty => 0
  }
}
print(area(Circle(2)))
print(area(Rect(3, 4)))
print(area(Empty))`);
  assert.deepEqual(out, ['12', '12', '0']);
});

// ---------------------------------------------------------------------------
// exhaustiveness -- the point of the feature
// ---------------------------------------------------------------------------

test('a match that misses a variant is reported before the program runs', () => {
  const f = findings(`${SHAPE}
fn area(s) { return match s { Circle(r) => r, Rect(w, h) => w * h } }`);
  assert.equal(f.length, 1);
  assert.match(f[0].message, /does not handle `Empty`/);
});

test('every missing variant is named, not just the first', () => {
  const f = findings(`${SHAPE}
fn f(s) { return match s { Circle(r) => r } }`);
  assert.equal(f.length, 1);
  assert.match(f[0].message, /`Rect`/);
  assert.match(f[0].message, /`Empty`/);
});

test('a complete match is not reported', () => {
  assert.equal(findings(`${SHAPE}
fn f(s) { return match s { Circle(r) => 1, Rect(w, h) => 2, Empty => 3 } }`).length, 0);
});

test('a wildcard closes the match', () => {
  assert.equal(findings(`${SHAPE}
fn f(s) { return match s { Circle(r) => 1, _ => 0 } }`).length, 0);
});

test('a bare binding closes the match, the same as a wildcard', () => {
  assert.equal(findings(`${SHAPE}
fn f(s) { return match s { Circle(r) => 1, other => 0 } }`).length, 0);
});

test('a guarded arm does not close its variant', () => {
  // `Circle(r) when r > 0` may decline to fire, so Circle is still open.
  const f = findings(`${SHAPE}
fn f(s) { return match s { Circle(r) when r > 0 => 1, Rect(w, h) => 2, Empty => 3 } }`);
  assert.equal(f.length, 1);
  assert.match(f[0].message, /`Circle`/);
  assert.match(f[0].hint, /guard/);
});

test('declaration order does not matter', () => {
  // The match is written above the choice it matches on.
  const f = findings(`fn f(s) { return match s { Circle(r) => 1 } }\n${SHAPE}`);
  assert.equal(f.length, 1);
});

test('a match on records that are not variants is left alone', () => {
  assert.equal(findings('record P(x, y)\nfn f(p) { return match p { P(a, b) => a } }').length, 0);
});

test('a match whose arms span two choices is left alone', () => {
  // Nothing sensible to say: neither choice is being matched exhaustively, and
  // guessing which one was meant would produce noise.
  assert.equal(findings(`choice A { One(v)  Two(v) }
choice B { Three(v)  Four(v) }
fn f(x) { return match x { One(v) => 1, Three(v) => 2 } }`).length, 0);
});

test('a variant name used by two choices is ambiguous, so nothing is claimed', () => {
  assert.equal(findings(`choice A { Same(v)  OnlyA }
choice B { Same(v)  OnlyB }
fn f(x) { return match x { Same(v) => 1 } }`).length, 0);
});

test('a literal arm does not make the match a choice match', () => {
  assert.equal(findings(`${SHAPE}fn f(x) { return match x { 1 => "a", 2 => "b" } }`).length, 0);
});

test('check reports it with its own code', () => {
  const f = findings(`${SHAPE}fn f(s) { return match s { Circle(r) => 1 } }`);
  assert.equal(f[0].kind, 'inexhaustive match');
});

// ---------------------------------------------------------------------------
// it has to work with everything else
// ---------------------------------------------------------------------------

test('the type checker knows the variants', () => {
  const problems = typecheck(parse(`${SHAPE}print(Circle(2))\nprint(Empty)`, 't.pedag'), { builtins: ['print'] });
  assert.deepEqual(problems.map((d) => d.message), []);
});

test('a choice declared after its use still type-checks', () => {
  const problems = typecheck(parse(`fn f() { return Empty }\n${SHAPE}`, 't.pedag'), { builtins: [] });
  assert.deepEqual(problems.map((d) => d.message), []);
});

test('the formatter round-trips a choice', () => {
  const source = `${SHAPE}print(Empty)\n`;
  const once = formatSource(source, 't.pedag');
  const twice = formatSource(once, 't.pedag');
  assert.equal(once, twice, 'formatting is not stable');
  assert.doesNotThrow(() => parse(once, 't.pedag'));
  assert.match(once, /choice Shape \{/);
  // A nullary variant keeps its parenthesis-free form.
  assert.match(once, /^ {2}Empty$/m);
});

test('`choice` is still usable as an ordinary name', () => {
  // Contextual keyword: only `choice <Name> {` declares a type.
  const { out } = run('var choice = 3\nchoice = choice + 1\nprint(choice)');
  assert.deepEqual(out, ['4']);
});

test('a variant name may be a field name elsewhere', () => {
  const { out } = run(`${SHAPE}record Row(Empty2, other)\nprint(Row(1, 2).other)`);
  assert.deepEqual(out, ['2']);
});

test('a choice with one variant is allowed', () => {
  assert.deepEqual(run('choice Only { Just(v) }\nprint(Just(1))').out, ['Just(v: 1)']);
});

test('a choice with no variants is a syntax error', () => {
  assert.throws(() => run('choice Nothing { }\n'), (e) => e instanceof PedagError && e.kind === 'SyntaxError');
});

test('a repeated variant name is a syntax error', () => {
  assert.throws(
    () => run('choice A { One(v)  One(w) }\n'),
    (e) => e instanceof PedagError && /twice/.test(e.message),
  );
});

test('an unmatched variant at run time is still a MatchError', () => {
  // Exhaustiveness is a static check, not a runtime one: a program run without
  // `check` must still fail safely rather than silently.
  assert.throws(
    () => run(`${SHAPE}fn f(s) { return match s { Circle(r) => 1 } }\nf(Empty)`),
    (e) => e instanceof PedagError && e.kind === 'MatchError',
  );
});

test('both engines agree on choices', () => {
  const source = `${SHAPE}
fn area(s) { return match s { Circle(r) => 3 * r * r, Rect(w, h) => w * h, Empty => 0 } }
var total = 0
for s in [Circle(1), Rect(2, 3), Empty] { total = total + area(s) }
print(total)`;
  const both = [true, false].map((compiled) => {
    const out = [];
    const interp = new Interpreter({ out: (s) => out.push(s), seed: 1 });
    interp.compiled = compiled;
    try { interp.run(source, 't.pedag'); } finally { interp.devices.shutdown(); }
    return out.join('\n');
  });
  assert.equal(both[0], both[1]);
  assert.equal(both[0], '9');
});
