import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAll, parse } from '../src/parser.js';
import { analyseTaint } from '../src/taint.js';

// ---------------------------------------------------------------------------
// every syntax error, not just the first
// ---------------------------------------------------------------------------

test('several syntax errors are all reported', () => {
  const { errors } = parseAll([
    'let a = ',
    'let b = 2',
    'fn f( { return 1 }',
    'let c = 3',
    'let = 4',
  ].join('\n'), 't.pedag');
  assert.ok(errors.length >= 3, `expected several errors, got ${errors.length}`);
  assert.ok(errors.every((e) => e.kind === 'SyntaxError'));
});

test('recovery keeps the statements that did parse', () => {
  const { program, errors } = parseAll('let a = 1\nlet = 2\nlet c = 3\n', 't.pedag');
  assert.equal(errors.length, 1);
  const names = program.body.filter((s) => s.type === 'Declare').map((s) => s.name);
  assert.deepEqual(names, ['a', 'c'], 'the good statements on both sides should survive');
});

test('a clean file reports nothing and parses fully', () => {
  const { program, errors } = parseAll('let a = 1\nfn f() { return a }\n', 't.pedag');
  assert.deepEqual(errors, []);
  assert.equal(program.body.length, 2);
});

test('recovery always terminates, even on hostile input', () => {
  for (const src of ['{{{{{{', '}}}}}}', 'fn fn fn', '((((', 'let let let', '=]=]=]']) {
    const { errors } = parseAll(src, 't.pedag');
    assert.ok(Array.isArray(errors), `did not terminate on ${JSON.stringify(src)}`);
  }
});

test('the error cap stops a pathological file from flooding', () => {
  const { errors } = parseAll('let = 1\n'.repeat(200), 't.pedag');
  assert.ok(errors.length <= 25);
});

test('a lexer failure still comes back as one error', () => {
  const { errors } = parseAll('let x = "unterminated', 't.pedag');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, 'SyntaxError');
});

test('running a file still stops at the first error', () => {
  // parse() is what execution uses: there is no point running a file that does
  // not parse, and a half-parsed program must never reach the interpreter.
  assert.throws(() => parse('let = 1\nlet b = 2', 't.pedag'), /SyntaxError|expected/);
});

// ---------------------------------------------------------------------------
// taint reachability over every path
// ---------------------------------------------------------------------------

const taint = (src) => analyseTaint(parse(src, 't.pedag'));

test('a label reaching a grounded block is found even on an untaken path', () => {
  const findings = taint(`
    fn maybe_taint(flag) {
      if flag { return ungrounded("from a model") }
      return "a constant"
    }
    let value = maybe_taint(false)
    grounded { print(value) }
  `);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /`ungrounded` can reach this grounded block/);
});

test('labels follow through a chain of calls', () => {
  const findings = taint(`
    fn source() { return untrusted("x") }
    fn middle() { return source() }
    fn outer() { return middle() }
    let v = outer()
    grounded { print(v) }
  `);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /untrusted/);
});

test('a clean value produces no finding', () => {
  assert.deepEqual(taint('let v = "plain"\ngrounded { print(v) }'), []);
  assert.deepEqual(taint('let v = 1 + 2\ngrounded { print(v) }'), []);
});

test('trust() clears the label statically too', () => {
  assert.deepEqual(taint(`
    let raw = ungrounded("x")
    let ok = trust(raw, "checked by a human")
    grounded { print(ok) }
  `), []);
});

test('a jurisdiction crossing is found across paths', () => {
  const findings = taint(`
    let eu = restrict("customer", "eu")
    region "us" { print(eu) }
  `);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /restricted to `eu` can reach a `us` region/);
});

test('the matching jurisdiction is fine', () => {
  assert.deepEqual(taint('let eu = restrict("c", "eu")\nregion "eu" { print(eu) }'), []);
});

test('a label survives being folded into other values', () => {
  const through = [
    'let v = [ungrounded("x")]\ngrounded { print(v) }',
    'let v = { "k": ungrounded("x") }\ngrounded { print(v) }',
    'let v = "prefix " + untrusted("x")\ngrounded { print(v) }',
    'let v = "${untrusted("x")}"\ngrounded { print(v) }',
  ];
  for (const src of through) {
    assert.equal(taint(src).length, 1, `a label was lost in: ${src}`);
  }
});

test('a value tainted in only one branch is still reported', () => {
  const findings = taint(`
    var v = "clean"
    if true { v = ungrounded("from a model") }
    grounded { print(v) }
  `);
  assert.equal(findings.length, 1, 'merging branches must keep the tainted possibility');
});

test('one message per problem', () => {
  const findings = taint(`
    let v = ungrounded("x")
    grounded { print(v) }
  `);
  assert.equal(findings.length, 1);
});
