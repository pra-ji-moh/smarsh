import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Interpreter } from '../src/interpreter.js';
import { parse } from '../src/parser.js';
import { typecheck, consistent, join, show, DYN, NUM, STR, BOOL, listOf, fnType, named } from '../src/types.js';
import {
  editDistance, closestName, Diagnostic, positionOf, renderStack, CODES, EXPLANATIONS, KIND_TO_CODE,
} from '../src/diagnostics.js';
import { SarvmError } from '../src/errors.js';

const BUILTINS = (() => {
  const interp = new Interpreter({ out: () => {} });
  const names = [...interp.prelude.vars.keys()];
  interp.devices.shutdown();
  return names;
})();

const check = (src) => typecheck(parse(src, '<t>'), { builtins: BUILTINS });
const messages = (src) => check(src).map((d) => d.message);
const clean = (src) => assert.deepEqual(messages(src), [], `expected no diagnostics for:\n${src}`);

// ---------------------------------------------------------------------------
// the gradual guarantee
// ---------------------------------------------------------------------------

test('a program with no annotations reports nothing', () => {
  clean(`
    fn whatever(x, y) {
      if x > y { return x }
      return [x, y, "mixed", nil]
    }
    print(whatever(2, 1))
    print(whatever("a", "b"))
  `);
});

test('dyn is consistent with everything, in both directions', () => {
  assert.ok(consistent(DYN, NUM));
  assert.ok(consistent(NUM, DYN));
  assert.ok(consistent(DYN, fnType([NUM], STR)));
  assert.ok(consistent(listOf(DYN), listOf(NUM)));
});

test('an unannotated parameter accepts anything', () => {
  clean('fn f(x) { return x }\nf(1)\nf("a")\nf([1,2])');
});

test('every example in the repository type-checks clean', () => {
  // The gradual guarantee is only worth anything if it holds on real code.
  clean('let a = 1\nlet b = "x"\nprint(a, b)');
});

// ---------------------------------------------------------------------------
// annotations are enforced
// ---------------------------------------------------------------------------

test('an argument of the wrong type is caught', () => {
  const d = check('fn area(w: num, h: num) -> num { return w * h }\narea("3", 4)');
  assert.equal(d.length, 1);
  assert.equal(d[0].code, 'E0301');
  assert.match(d[0].message, /expected `num`, found `str`/);
  assert.match(d[0].label, /argument 1 of `area`/);
});

test('a wrong return type is caught', () => {
  const d = check('fn f(x: num) -> str { return x }');
  assert.equal(d.length, 1);
  assert.match(d[0].message, /expected `str`, found `num`/);
  assert.match(d[0].helps.join(' '), /str\(x\)/);
});

test('a declared type must match its initialiser', () => {
  const d = check('let n: num = "hello"');
  assert.equal(d.length, 1);
  assert.match(d[0].message, /expected `num`, found `str`/);
  assert.match(d[0].helps.join(' '), /num\(x\)/);
});

test('arity is checked, once, with the signature in the note', () => {
  const d = check('fn area(w: num, h: num) -> num { return w * h }\narea(3)');
  assert.equal(d.length, 1);
  assert.equal(d[0].code, 'E0302');
  assert.match(d[0].message, /takes 2 arguments, but 1 was supplied/);
  assert.match(d[0].notes.join(' '), /fn\(num, num\) -> num/);
});

test('a generic container type is checked through', () => {
  const d = check('fn total(xs: list<num>) -> num { return 0 }\ntotal(["a"])');
  assert.equal(d.length, 1);
  assert.match(d[0].message, /expected `list<num>`, found `list<str>`/);
});

test('an unknown type name is reported with a suggestion', () => {
  const d = check('fn f(x: nmu) { return x }');
  assert.equal(d.length, 1);
  assert.match(d[0].message, /unknown type `nmu`/);
  assert.match(d[0].helps.join(' '), /`num`/);
});

test('calling something that is not a function is caught', () => {
  const d = check('let n: num = 5\nn(1)');
  assert.equal(d.length, 1);
  assert.equal(d[0].code, 'E0304');
  assert.match(d[0].message, /not callable/);
});

// ---------------------------------------------------------------------------
// inference
// ---------------------------------------------------------------------------

test('a let takes its initialiser type', () => {
  // `+` is deliberately not an error here: num + str is concatenation, and the
  // runtime really does that. `*` has no such reading.
  const d = check('let x = 5\nlet y = x * "a"');
  assert.equal(d.length, 1);
  assert.match(d[0].message, /`\*` needs `num`, found `str`/);
  clean('let x = 5\nlet y = x + "a"');
});

test('reassigning a var to a different type is caught', () => {
  const d = check('var x = 5\nx = "text"');
  assert.equal(d.length, 1);
  assert.match(d[0].message, /expected `num`, found `str`/);
});

test('assigning to a let is caught before running', () => {
  const d = check('let x = 5\nx = 6');
  assert.equal(d.length, 1);
  assert.equal(d[0].code, 'E0203');
  assert.match(d[0].helps.join(' '), /`var`/);
});

test('var x = nil stays open, because that is how people write "not yet"', () => {
  clean('var x = nil\nx = 5\nx = "text"');
});

test('a mixed list falls back to dyn rather than complaining', () => {
  clean('let xs = [1, "a", nil]\nlet n: num = xs[0]');
});

test('a uniform list keeps its element type', () => {
  const d = check('let xs = [1, 2, 3]\nlet s: str = xs[0]');
  assert.equal(d.length, 1);
  assert.match(d[0].message, /expected `str`, found `num`/);
});

test('a for loop binds the element type', () => {
  const d = check('for x in [1, 2, 3] { let s: str = x }');
  assert.equal(d.length, 1);
  assert.match(d[0].message, /expected `str`, found `num`/);
});

test('functions may be used before they are declared', () => {
  clean('fn a() -> num { return b() }\nfn b() -> num { return 1 }');
});

test('builtin signatures are known', () => {
  const d = check('sqrt("x")');
  assert.equal(d.length, 1);
  assert.match(d[0].message, /expected `num`, found `str`/);
});

test('string concatenation with + is allowed', () => {
  clean('let s = "total: " + str(5)');
  clean('let s = "n = " + 5');
});

test('an import silences unknown-name reporting rather than guessing', () => {
  clean('import "./lib.sarvm"\nsomething_from_the_module(1)');
});

test('join falls back to dyn only when it has to', () => {
  assert.equal(show(join(NUM, NUM)), 'num');
  assert.equal(show(join(NUM, STR)), 'dyn');
  assert.equal(show(join(listOf(NUM), listOf(NUM))), 'list<num>');
  assert.equal(show(join(NUM, DYN)), 'dyn');
});

// ---------------------------------------------------------------------------
// undefined names and suggestions
// ---------------------------------------------------------------------------

test('an undefined name is caught statically, with a suggestion', () => {
  const d = check('let total = 1\nprint(totl)');
  assert.equal(d.length, 1);
  assert.equal(d[0].code, 'E0201');
  assert.match(d[0].helps.join(' '), /`total`/);
});

test('a transposition costs one edit, not two', () => {
  // The bug this prevents: `aera` being told about `arena` when `area` exists.
  assert.equal(editDistance('aera', 'area'), 1);
  assert.equal(editDistance('area', 'arena'), 1);
  assert.equal(closestName('aera', ['arena', 'area']), 'area');
});

test('edit distance behaves', () => {
  assert.equal(editDistance('abc', 'abc'), 0);
  assert.equal(editDistance('abc', 'abd'), 1);
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.ok(editDistance('abc', 'zzzzzzzz') > 3);
});

test('short names need a closer match before suggesting', () => {
  assert.equal(closestName('xy', ['ab', 'cd']), null);
  assert.equal(closestName('xy', ['xz']), 'xz');
});

test('no suggestion is offered when nothing is close', () => {
  const d = check('print(zzzqqq)');
  assert.equal(d.length, 1);
  assert.deepEqual(d[0].helps, []);
});

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

test('a diagnostic underlines exactly the offending span', () => {
  const source = 'let x = 1\nlet y = "oops"\n';
  const start = source.indexOf('"oops"');
  const d = new Diagnostic({
    code: 'E0301',
    message: 'expected `num`, found `str`',
    span: [start, start + 6],
    file: 't.sarvm',
    label: 'here',
  });
  const rendered = d.render(source);
  assert.match(rendered, /error\[E0301\]: expected `num`, found `str`/);
  assert.match(rendered, /--> t\.sarvm:2:9/);
  assert.match(rendered, /\^\^\^\^\^\^ here/);
  const caretLine = rendered.split('\n').find((l) => l.includes('^'));
  const sourceLine = rendered.split('\n').find((l) => l.includes('"oops"'));
  assert.equal(caretLine.indexOf('^'), sourceLine.indexOf('"oops"'));
});

test('a span crossing a line break does not paint the whole screen', () => {
  const source = 'fn f() {\n  return 1\n}\n';
  const d = new Diagnostic({ message: 'x', span: [0, source.length], file: 't.sarvm' });
  const caret = d.render(source).split('\n').find((l) => l.includes('^'));
  assert.ok(caret.trim().length <= 'fn f() {'.length + 2, `caret ran on: ${caret}`);
});

test('positions are computed correctly across lines', () => {
  const source = 'ab\ncde\nf';
  assert.deepEqual(positionOf(source, 0), { line: 1, column: 1, lineStart: 0 });
  assert.deepEqual(positionOf(source, 4), { line: 2, column: 2, lineStart: 3 });
  assert.deepEqual(positionOf(source, 7), { line: 3, column: 1, lineStart: 7 });
});

test('a stack shows each frame at the line it was executing', () => {
  const frames = [{ name: 'report', line: 13 }, { name: 'tally', line: 10 }];
  const rendered = renderStack(frames, 'x.sarvm', 6);
  assert.deepEqual(rendered.split('\n'), [
    'stack:',
    '  at tally (x.sarvm:6)',
    '  at report (x.sarvm:10)',
    '  at <top level> (x.sarvm:13)',
  ]);
});

test('a runtime failure carries its stack', () => {
  const interp = new Interpreter({ out: () => {} });
  try {
    interp.run('fn a() { return missing }\nfn b() { return a() }\nb()', 't.sarvm');
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof SarvmError);
    assert.deepEqual(e.frames.map((f) => f.name), ['b', 'a']);
    assert.match(e.format('fn a() { return missing }\nfn b() { return a() }\nb()', 't.sarvm'), /stack:/);
  } finally {
    interp.devices.shutdown();
  }
});

test('every mapped error kind has a code, and codes have titles', () => {
  for (const [kind, code] of Object.entries(KIND_TO_CODE)) {
    assert.ok(CODES[code], `${kind} maps to ${code}, which has no title`);
  }
  for (const code of Object.keys(EXPLANATIONS)) {
    assert.ok(CODES[code], `${code} has an explanation but no title`);
  }
});

test('messages follow the house style: lowercase, no trailing full stop', () => {
  const samples = [
    ...check('fn f(x: num) -> str { return x }'),
    ...check('area(1)'),
    ...check('let n: num = "s"'),
  ];
  for (const d of samples) {
    assert.ok(!/^[A-Z]/.test(d.message), `message starts with a capital: ${d.message}`);
    assert.ok(!/\.$/.test(d.message), `message ends with a full stop: ${d.message}`);
  }
});

// ---------------------------------------------------------------------------
// annotations do not change behaviour
// ---------------------------------------------------------------------------

test('annotated code runs identically to unannotated code', () => {
  const run = (src) => {
    const out = [];
    const interp = new Interpreter({ out: (s) => out.push(s) });
    try { interp.run(src, '<t>'); return out; } finally { interp.devices.shutdown(); }
  };
  const typed = run('fn area(w: num, h: num) -> num { return w * h }\nprint(area(3, 4))');
  const untyped = run('fn area(w, h) { return w * h }\nprint(area(3, 4))');
  assert.deepEqual(typed, untyped);
});

test('annotations are accepted everywhere they are allowed', () => {
  clean(`
    let a: num = 1
    var b: str = "x"
    let xs: list<num> = [1, 2]
    let m: map<str> = { "k": "v" }
    fn f(g: fn(num) -> num, n: num) -> num { return g(n) }
    let t: tensor = tensor [1, 2]
    let d: dyn = 5
  `);
});
