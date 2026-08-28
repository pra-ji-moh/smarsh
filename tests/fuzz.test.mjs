import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Interpreter } from '../src/interpreter.js';
import { SmarshError, BudgetExceeded } from '../src/errors.js';
import { parse, parseAll } from '../src/parser.js';
import { tokenize } from '../src/lexer.js';
import { formatSource } from '../src/format.js';
import { analyze } from '../src/analysis.js';
import { Rng } from '../src/rng.js';

// Fuzzing the runtime against input nobody would write on purpose.
//
// The contract being tested is narrow and absolute: for *any* input, Smarsh
// either runs it, or fails with a SmarshError that names a kind and a line. It
// must never surface a raw JavaScript error, because a `TypeError: cannot read
// properties of undefined` tells a user nothing, tells a tool nothing, and
// usually means an internal invariant broke somewhere further back.
//
// Every case is generated from a seeded PRNG, so a failure here is reproducible
// from the seed printed with it rather than being a story about a run that
// happened once.

const CLEAN_KINDS = new Set(['SyntaxError']);

// A JavaScript error the runtime failed to turn into something meaningful.
function describeLeak(e, input, seed) {
  return `seed ${seed}\ninput: ${JSON.stringify(input.slice(0, 200))}\n`
    + `leaked ${e && e.constructor ? e.constructor.name : typeof e}: ${e && e.message}`;
}

function attempt(source, { caps = [], run = true } = {}) {
  const interp = new Interpreter({ out: () => {}, caps, seed: 1 });
  interp.stepLimit = 20000;      // a fuzzer will write infinite loops
  try {
    if (run) interp.run(source, 'fuzz.smarsh');
    else parse(source, 'fuzz.smarsh');
    return null;
  } catch (e) {
    return e;
  } finally {
    interp.devices.shutdown();
  }
}

const acceptable = (e) => e === null
  || e instanceof SmarshError
  || e instanceof BudgetExceeded
  // A genuine stack overflow is converted at the boundary; the raw form can
  // still escape from deep inside a native callback, and is not a leak.
  || (e instanceof RangeError && /call stack/i.test(e.message));

// ---------------------------------------------------------------------------
// token soup
// ---------------------------------------------------------------------------

const PIECES = [
  '{', '}', '(', ')', '[', ']', ',', ';', '.', ':', '=', '=>', '==', '!=', '<', '>',
  '+', '-', '*', '/', '%', '@', '**', '!', '"a"', '1', '0', '-1', '1e999', 'true',
  'nil', 'x', '_', 'let', 'var', 'fn', 'if', 'else', 'while', 'for', 'in', 'return',
  'match', 'when', 'record', 'agent', 'on', 'spawn', 'using', 'budget', 'steps',
  'grounded', 'region', 'atomic', 'secret', 'authority', 'attempt', 'rescue',
  'invariant', 'variant', 'requires', 'ensures', 'needs', 'fork', 'maybe', 'choose',
  'tensor', 'import', 'as', 'redefine', 'device', '${', '"${x}"', '\\', '#', '//',
];

function soup(rng, length) {
  const out = [];
  for (let i = 0; i < length; i++) out.push(PIECES[Math.floor(rng.next() * PIECES.length)]);
  return out.join(' ');
}

test('random token soup never leaks a JavaScript error', { timeout: 120000 }, () => {
  for (let seed = 0; seed < 400; seed++) {
    const rng = new Rng(seed);
    const source = soup(rng, 4 + Math.floor(rng.next() * 24));
    const e = attempt(source);
    assert.ok(acceptable(e), describeLeak(e, source, seed));
  }
});

test('deeply nested structure does not crash the parser', { timeout: 120000 }, () => {
  for (const depth of [50, 200, 1000]) {
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{ "k": ', ' }']]) {
      const source = `let x = ${open.repeat(depth)}1${close.repeat(depth)}`;
      const e = attempt(source);
      assert.ok(acceptable(e), describeLeak(e, source, depth));
    }
  }
});

test('unterminated everything is a clean syntax error', () => {
  const cases = [
    '"unterminated', '/* unterminated', '"${', '"${1', 'fn f(', '[1, 2', '{ "a":',
    'match x {', 'record P(', 'if true {', 'let', 'let x =', 'fn', '${}', '"\\',
  ];
  for (const source of cases) {
    const e = attempt(source);
    assert.ok(e instanceof SmarshError, describeLeak(e, source, 'n/a'));
    assert.ok(CLEAN_KINDS.has(e.kind) || e.kind === 'NameError',
      `${JSON.stringify(source)} gave ${e.kind}, expected a syntax error`);
    assert.ok(e.line >= 1, `${JSON.stringify(source)} produced no line number`);
  }
});

// ---------------------------------------------------------------------------
// hostile but well-formed programs
// ---------------------------------------------------------------------------

test('numeric edge cases do not leak', () => {
  const cases = [
    'let x = 1e999', 'let x = -1e999', 'let x = 0 / 0.0', 'let x = 1e-999',
    'print(1e308 * 10)', 'print(0.0 / 0.0)', 'print(sqrt(-1))',
    'print(dec("0.0000000000000000000000000000000001"))',
    'print(dec("1") / dec("3"))', 'print((0 - 1) ** 0.5)',
    'let t = tensor [[1e308, 1e308]]\nprint(t @ t.T)',
  ];
  for (const source of cases) {
    const e = attempt(source);
    assert.ok(acceptable(e), describeLeak(e, source, 'numeric'));
  }
});

test('pathological strings do not leak', () => {
  const cases = [
    'print("\\u0000")', 'print("' + 'a'.repeat(10000) + '")',
    'let s = ""\nfor i in range(200) { s = s + "xx" }\nprint(s.len())',
    'print("${"${"}"}")', 'print("a".slice(-999, 999))',
    'print("abc".slice(999))', 'print("".upper())',
  ];
  for (const source of cases) {
    const e = attempt(source);
    assert.ok(acceptable(e), describeLeak(e, source, 'strings'));
  }
});

test('wrong types at every builtin do not leak', () => {
  // Every builtin, called with arguments of the wrong shape.
  const interp = new Interpreter({ out: () => {} });
  const names = [...interp.prelude.vars.keys()];
  interp.devices.shutdown();

  const args = ['nil', '1', '"s"', 'true', '[]', '{ }', '[1, 2]'];
  for (const name of names) {
    for (const a of args) {
      const source = `${name}(${a})`;
      const e = attempt(source, { caps: [] });
      assert.ok(acceptable(e), describeLeak(e, source, name));
    }
  }
});

test('index and member access on every value shape', () => {
  const values = ['nil', '1', '"s"', 'true', '[]', '{ }', 'tensor [1]', 'dec("1")'];
  for (const v of values) {
    for (const access of ['[0]', '[-1]', '["k"]', '[999]', '.nope', '.len()']) {
      const source = `let v = ${v}\nv${access}`;
      const e = attempt(source);
      assert.ok(acceptable(e), describeLeak(e, source, v));
    }
  }
});

test('recursion and mutual recursion terminate cleanly', () => {
  const cases = [
    'fn f() { return f() }\nf()',
    'fn a() { return b() }\nfn b() { return a() }\na()',
    'fn f(n) { return f(n) + 1 }\nf(0)',
  ];
  for (const source of cases) {
    const e = attempt(source);
    assert.ok(acceptable(e), describeLeak(e, source, 'recursion'));
    assert.ok(e !== null, 'unbounded recursion must stop');
  }
});

test('self-referential values do not hang', () => {
  const cases = [
    'var xs = []\nxs.push(xs)\nprint(str(xs).len() > 0)',
    'var m = { }\nm.set("self", m)\nprint(m.len())',
    'var xs = []\nxs.push(xs)\nprint(xs == xs)',
  ];
  for (const source of cases) {
    const e = attempt(source);
    assert.ok(acceptable(e), describeLeak(e, source, 'cyclic'));
  }
});

// ---------------------------------------------------------------------------
// control flow with nowhere to land
//
// `return`, `break` and `continue` are implemented by throwing a signal that
// the owning construct catches. When there is no owning construct the signal
// used to escape as a bare JavaScript object -- no kind, no line, no message.
// A 20,000-case campaign hit it on 5% of generated programs.
// ---------------------------------------------------------------------------

test('a control-flow keyword with no target is a clean error, not a leaked signal', () => {
  const cases = [
    'break',
    'continue',
    'return 1',
    'print(1)\nbreak',
    'if true { break }',
    'atomic { break }',
    'grounded { continue }',
    'region "eu" { return 1 }',
    'fork 2 { break }',
    'fn f() { break }\nf()',
    'fn f() { continue }\nf()',
    'agent A(k) { on go() { break } }\nsend(spawn A(1), "go")\nrun_agents()',
  ];
  for (const source of cases) {
    const e = attempt(source);
    assert.ok(e instanceof SmarshError, describeLeak(e, source, 'control flow'));
    assert.equal(e.kind, 'ControlFlowError', `${JSON.stringify(source)} gave ${e.kind}`);
    assert.ok(e.line >= 1, `${JSON.stringify(source)} produced no line number`);
  }
});

test('a break inside a function does not reach into the caller\'s loop', () => {
  // The dangerous shape: before the fix this silently ended the caller's loop
  // after one pass, an effect the callee has no business having.
  const e = attempt('fn bad() { break }\nvar seen = 0\nfor i in range(3) { seen = seen + 1\n bad() }');
  assert.ok(e instanceof SmarshError);
  assert.equal(e.kind, 'ControlFlowError');
});

test('control flow that does have a target still works', () => {
  const interp = new Interpreter({ out: () => {} });
  try {
    const result = interp.run([
      'fn f() {',
      '  var n = 0',
      '  while true { n = n + 1  if n > 2 { break } }',
      '  for i in range(5) { if i == 1 { continue }  n = n + i }',
      '  return n',
      '}',
      'f()',
    ].join('\n'), 't.smarsh');
    // 3 from the while, then 0 + 2 + 3 + 4 with i == 1 skipped.
    assert.equal(result, 12);
  } finally {
    interp.devices.shutdown();
  }
});

test('check reports a misplaced keyword before the program runs', () => {
  const findings = analyze(parse('atomic { break }', 't.smarsh'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'control flow');
  assert.match(findings[0].message, /no loop/);
});

test('check does not report control flow that is correctly placed', () => {
  const sources = [
    'for i in range(3) { break }',
    'while true { continue }',
    'fn f() { return 1 }',
    'for i in range(3) { atomic { break } }',
    'for i in range(3) { fn f() { return 1 }  f() }',
    'agent A(k) { on go() { return k } }',
  ];
  for (const source of sources) {
    const findings = analyze(parse(source, 't.smarsh')).filter((f) => f.kind === 'control flow');
    assert.equal(findings.length, 0, `${JSON.stringify(source)} was wrongly flagged`);
  }
});

// ---------------------------------------------------------------------------
// the tools must survive the same input
// ---------------------------------------------------------------------------

test('the formatter never leaks on soup, and never invents output', { timeout: 120000 }, () => {
  for (let seed = 0; seed < 200; seed++) {
    const rng = new Rng(seed ^ 0xbeef);
    const source = soup(rng, 4 + Math.floor(rng.next() * 20));
    let formatted = null;
    try {
      formatted = formatSource(source, 'fuzz.smarsh');
    } catch (e) {
      // Only a parse failure, or an explicit refusal to print unknown syntax.
      assert.ok(e instanceof SmarshError || /does not know/.test(e.message),
        describeLeak(e, source, seed));
      continue;
    }
    // Anything it did format must parse back.
    assert.doesNotThrow(() => parse(formatted, 'fuzz.smarsh'),
      `seed ${seed}: formatter produced unparseable output from ${JSON.stringify(source)}`);
  }
});

test('error recovery terminates on soup and stays bounded', { timeout: 120000 }, () => {
  for (let seed = 0; seed < 200; seed++) {
    const rng = new Rng(seed ^ 0x1234);
    const source = soup(rng, 4 + Math.floor(rng.next() * 30));
    const { errors } = parseAll(source, 'fuzz.smarsh');
    assert.ok(Array.isArray(errors), `seed ${seed}: recovery returned nothing`);
    assert.ok(errors.length <= 25, `seed ${seed}: ${errors.length} errors, cap is 25`);
  }
});

test('the lexer never loops on any single character', () => {
  for (let code = 0; code < 0x300; code++) {
    const ch = String.fromCodePoint(code);
    try {
      tokenize(ch);
    } catch (e) {
      assert.ok(e instanceof SmarshError,
        `U+${code.toString(16)} leaked ${e && e.constructor && e.constructor.name}`);
    }
  }
});

// ---------------------------------------------------------------------------
// the allocation budget is the backstop for all of it
// ---------------------------------------------------------------------------

test('an unbounded allocation loop is stopped by a memory budget', () => {
  const e = attempt('budget memory 20000 { var xs = []\n  while true { xs.push(1) } }');
  assert.ok(e instanceof SmarshError);
  assert.equal(e.kind, 'BudgetError');
  assert.match(e.message, /memory/);
});

test('memory budgets nest and only tighten', () => {
  const interp = new Interpreter({ out: () => {} });
  try {
    assert.throws(() => interp.run(
      'budget memory 5000 { budget memory 999999 { var xs = []\n while true { xs.push(1) } } }',
      't.smarsh',
    ));
    assert.ok(interp.allocated < 50000, `the inner budget raised the ceiling (${interp.allocated} bytes)`);
  } finally {
    interp.devices.shutdown();
  }
});

test('allocation accounting is deterministic', () => {
  const measure = () => {
    const interp = new Interpreter({ out: () => {}, seed: 3 });
    interp.run('var xs = []\nfor i in range(500) { xs.push(i) }', 't.smarsh');
    const n = interp.allocated;
    interp.devices.shutdown();
    return n;
  };
  assert.equal(measure(), measure(), 'the same program must account identically every run');
});
