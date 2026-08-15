import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Interpreter } from '../src/interpreter.js';
import { SarvmError } from '../src/errors.js';
import { parse } from '../src/parser.js';
import { typecheck } from '../src/types.js';

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

const BUILTINS = (() => {
  const i = new Interpreter({ out: () => {} });
  const names = [...i.prelude.vars.keys()];
  i.devices.shutdown();
  return names;
})();
const check = (src) => typecheck(parse(src, '<t>'), { builtins: BUILTINS });

// ---------------------------------------------------------------------------
// string interpolation
// ---------------------------------------------------------------------------

test('interpolation substitutes expressions', () => {
  assert.equal(run('let n = 3\n"n is ${n}"').value, 'n is 3');
  assert.equal(run('"${1 + 2} and ${3 * 4}"').value, '3 and 12');
  assert.equal(run('let xs = [1,2,3]\n"len ${xs.len()}"').value, 'len 3');
});

test('a string with no interpolation is unchanged', () => {
  assert.equal(run('"plain text"').value, 'plain text');
  assert.equal(run('"a $ sign alone"').value, 'a $ sign alone');
});

test('an escaped dollar is literal', () => {
  assert.equal(run('"\\${not interpolated}"').value, '${not interpolated}');
});

test('interpolation nests strings and braces', () => {
  assert.equal(run('"${ { "a": 1 }.len() }"').value, '1');
  assert.equal(run('let s = "in"\n"${ s + "ner" }"').value, 'inner');
});

test('an unterminated or empty interpolation is a syntax error', () => {
  assert.equal(fails('"${1 + "').kind, 'SyntaxError');
  assert.equal(fails('"${}"').kind, 'SyntaxError');
  assert.equal(fails('"${1} ${2 3}"').kind, 'SyntaxError');
});

test('interpolating a tainted value keeps the label', () => {
  const { value } = run('let u = untrusted("x")\nlabels("safe ${u}")');
  assert.deepEqual(value, ['untrusted']);
});

test('a grounded block refuses an interpolated ungrounded value', () => {
  assert.equal(fails('let u = ungrounded("x")\ngrounded { print("v: ${u}") }').kind, 'TaintError');
});

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

test('a record carries named fields', () => {
  const { value } = run('record Point(x, y)\nlet p = Point(3, 4)\n[p.x, p.y]');
  assert.deepEqual(value, [3, 4]);
});

test('records compare by value, not identity', () => {
  assert.equal(run('record P(x, y)\nP(1, 2) == P(1, 2)').value, true);
  assert.equal(run('record P(x, y)\nP(1, 2) == P(1, 3)').value, false);
  assert.equal(run('record P(x)\nrecord Q(x)\nP(1) == Q(1)').value, false);
});

test('records nest and still compare structurally', () => {
  assert.equal(run(`
    record Point(x, y)
    record Line(from, to)
    Line(Point(0,0), Point(1,1)) == Line(Point(0,0), Point(1,1))
  `).value, true);
});

test('a record prints readably', () => {
  assert.deepEqual(run('record Point(x, y)\nprint(Point(3, 4))').out, ['Point(x: 3, y: 4)']);
});

test('with() returns a new record and leaves the original alone', () => {
  const { value } = run(`
    record Point(x, y)
    let a = Point(1, 2)
    let b = a.with("x", 9)
    [a.x, b.x, b.y]
  `);
  assert.deepEqual(value, [1, 9, 2]);
});

test('a record has no field it was not given', () => {
  assert.equal(fails('record P(x)\nP(1).nope').kind, 'AttributeError');
  assert.equal(fails('record P(x)\nP(1).with("nope", 2)').kind, 'AttributeError');
});

test('a record constructor checks its field count', () => {
  const e = fails('record Point(x, y)\nPoint(1)');
  assert.equal(e.kind, 'ArityError');
  assert.match(e.message, /has 2 fields \(x, y\)/);
});

test('records are values in collections', () => {
  const { value } = run(`
    record P(x)
    let xs = [P(1), P(2)]
    [xs.contains(P(2)), xs.contains(P(3))]
  `);
  assert.deepEqual(value, [true, false]);
});

// ---------------------------------------------------------------------------
// match
// ---------------------------------------------------------------------------

test('match picks the first fitting arm', () => {
  const { value } = run(`
    fn f(n) { return match n { 1 => "one", 2 => "two", _ => "many" } }
    [f(1), f(2), f(9)]
  `);
  assert.deepEqual(value, ['one', 'two', 'many']);
});

test('match destructures records', () => {
  const { value } = run(`
    record Point(x, y)
    fn describe(p) {
      return match p {
        Point(0, 0) => "origin",
        Point(0, y) => "y axis " + str(y),
        Point(x, 0) => "x axis " + str(x),
        Point(x, y) => str(x) + "," + str(y)
      }
    }
    [describe(Point(0,0)), describe(Point(0,5)), describe(Point(5,0)), describe(Point(2,3))]
  `);
  assert.deepEqual(value, ['origin', 'y axis 5', 'x axis 5', '2,3']);
});

test('guards refine an arm', () => {
  const { value } = run(`
    record P(x, y)
    fn f(p) {
      return match p {
        P(x, y) when x == y => "diagonal",
        P(x, y) when x > y => "below",
        P(x, y) => "above"
      }
    }
    [f(P(1,1)), f(P(5,1)), f(P(1,5))]
  `);
  assert.deepEqual(value, ['diagonal', 'below', 'above']);
});

test('a failing guard falls through to the next arm', () => {
  assert.equal(run('match 5 { n when n > 10 => "big", _ => "small" }').value, 'small');
});

test('list patterns match by length', () => {
  const { value } = run(`
    fn f(xs) {
      return match xs {
        [] => "empty",
        [a] => "one " + str(a),
        [a, b] => "two " + str(a + b),
        _ => "many"
      }
    }
    [f([]), f([7]), f([3,4]), f([1,2,3])]
  `);
  assert.deepEqual(value, ['empty', 'one 7', 'two 7', 'many']);
});

test('patterns match literals of every kind', () => {
  assert.equal(run('match "hi" { "hi" => 1, _ => 2 }').value, 1);
  assert.equal(run('match true { true => "t", false => "f" }').value, 't');
  assert.equal(run('match nil { nil => "nothing", _ => "something" }').value, 'nothing');
  assert.equal(run('match -3 { -3 => "neg", _ => "other" }').value, 'neg');
});

test('bindings from a pattern do not escape the arm', () => {
  assert.equal(fails('record P(x)\nmatch P(1) { P(v) => v }\nv').kind, 'NameError');
});

test('a value matching nothing is an error that says what to do', () => {
  const e = fails('match 99 { 1 => "one" }');
  assert.equal(e.kind, 'MatchError');
  assert.match(e.message, /no arm of this match fits 99/);
  assert.match(e.helps.join(' '), /_ => /);
});

test('a record pattern with the wrong field count is caught', () => {
  const e = fails('record P(x, y)\nmatch P(1,2) { P(a) => a }');
  assert.equal(e.kind, 'MatchError');
  assert.match(e.message, /has 2 fields, but the pattern lists 1/);
});

test('`record` is contextual, so it stays usable as an ordinary name', () => {
  // Java made `record` contextual for exactly this reason. The agent test
  // suite has a handler called `record`, which is how this was found.
  assert.equal(run('let record = 5\nrecord + 1').value, 6);
  assert.equal(run('fn record(x) { return x * 2 }\nrecord(4)').value, 8);
  assert.equal(run(`
    agent Keeper() {
      var seen = 0
      on record(n) { seen = seen + n }
    }
    let k = spawn Keeper()
    send(k, "record", 7)
    run_agents()
    k.state("seen")
  `).value, 7);
  // And the declaration form still works alongside all of that.
  assert.equal(run('record P(x)\nlet record = P(1)\nrecord.x').value, 1);
});

test('a record pattern does not match a different record', () => {
  assert.equal(run('record A(x)\nrecord B(x)\nmatch B(1) { A(v) => "a", _ => "other" }').value, 'other');
});

test('match is an expression', () => {
  assert.equal(run('let n = 2\nlet s = match n { 1 => "a", _ => "b" }\ns').value, 'b');
});

// ---------------------------------------------------------------------------
// the checker understands all of it
// ---------------------------------------------------------------------------

test('records and match type-check clean', () => {
  assert.deepEqual(check(`
    record Point(x: num, y: num)
    fn describe(p) -> str {
      return match p {
        Point(0, 0) => "origin",
        Point(x, y) => "at \${x}, \${y}",
        _ => "not a point"
      }
    }
    print(describe(Point(1, 2)))
  `).map((d) => d.message), []);
});

test('a record constructor is checked like any function', () => {
  const d = check('record Point(x: num, y: num)\nPoint("a", 2)');
  assert.equal(d.length, 1);
  assert.match(d[0].message, /expected `num`, found `str`/);
});

test('a wrong field count in a pattern is caught statically', () => {
  const d = check('record Point(x, y)\nmatch Point(1,2) { Point(a) => a, _ => 0 }');
  assert.equal(d.length, 1);
  assert.equal(d[0].code, 'E0302');
  assert.match(d[0].notes.join(' '), /its fields are x, y/);
});

test('an unknown record in a pattern is caught, with a suggestion', () => {
  const d = check('record Point(x, y)\nmatch 1 { Poimt(a, b) => a, _ => 0 }');
  assert.equal(d.length, 1);
  assert.match(d[0].message, /`Poimt` is not a record/);
  assert.match(d[0].helps.join(' '), /`Point`/);
});

test('interpolated expressions are checked', () => {
  const d = check('let s = "${undefined_name}"');
  assert.equal(d.length, 1);
  assert.equal(d[0].code, 'E0201');
});

test('a record type flows through destructuring', () => {
  const d = check(`
    record Point(x: num, y: num)
    match Point(1,2) { Point(a, b) => a * "oops", _ => 0 }
  `);
  assert.equal(d.length, 1);
  assert.match(d[0].message, /`\*` needs `num`, found `str`/);
});
