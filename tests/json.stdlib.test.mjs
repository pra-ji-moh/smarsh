import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Interpreter } from '../src/interpreter.js';
import { parseJson, writeJson, isJsonable } from '../src/json.js';
import { Decimal } from '../src/decimal.js';

// JSON, which is the thing a program needs before it can talk to anything else.
//
// The parser is hand-written rather than `JSON.parse` for three reasons, and
// each one is a group of tests below: the errors say where, a fractional number
// stays exact, and taint survives the parse.

function run(source, { caps = [] } = {}) {
  const out = [];
  const interp = new Interpreter({ out: (s) => out.push(s), caps, seed: 1 });
  try {
    interp.run(source, 't.smarsh');
    return { out, error: null, message: '' };
  } catch (e) {
    return { out, error: e.kind ?? 'error', message: e.message ?? '' };
  } finally {
    interp.devices.shutdown();
  }
}

const B = String.fromCharCode(92);

// ---------------------------------------------------------------------------
// it parses what JSON is
// ---------------------------------------------------------------------------

test('the whole grammar round-trips', () => {
  const cases = [
    '{}', '[]', 'null', 'true', 'false', '0', '-0', '123', '-123',
    '1e10', '1E-5', '-2.5e+3', '"x"', `"${B}n${B}t${B}${B}"`,
    '[1,2,3]', '{"a":1}', '[[[[1]]]]', '{"a":{"b":{"c":[1,{"d":null}]}}}',
  ];
  for (const c of cases) {
    assert.doesNotThrow(() => parseJson(c), `refused valid JSON: ${c}`);
  }
});

test('whitespace is permitted where JSON permits it, and nowhere else', () => {
  assert.doesNotThrow(() => parseJson(' \t\r\n{ "a" : [ 1 , 2 ] } \n'));
  // A vertical tab is not JSON whitespace, however much it looks like one.
  // Written as an escape rather than the character: an invisible control
  // character in source is a puzzle for whoever reads this next.
  const VT = String.fromCharCode(11);
  assert.throws(() => parseJson(`${VT}1`), /cannot start a value/);
  assert.doesNotThrow(() => parseJson('\t\r\n 1'));
});

test('a unicode escape becomes the character', () => {
  assert.equal(parseJson(`"${B}u00e9"`), 'é');
  assert.equal(parseJson(`"caf${B}u00e9"`), 'café');
});

test('every escape JSON defines is handled, and nothing else is', () => {
  const map = { '"': '"', [B]: B, '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
  for (const [esc, expected] of Object.entries(map)) {
    assert.equal(parseJson(`"${B}${esc}"`), expected, `\\${esc} was not handled`);
  }
  for (const bad of ['q', 'x', '0', 'a']) {
    assert.throws(() => parseJson(`"${B}${bad}"`), /is not an escape/);
  }
});

test('a raw control character inside a string is refused', () => {
  assert.throws(() => parseJson('"a\nb"'), /control character/);
});

// ---------------------------------------------------------------------------
// it refuses what JSON is not, and says where
// ---------------------------------------------------------------------------

test('malformed input is refused with a position', () => {
  const cases = [
    ['{"a":}', /cannot start a value/],
    ['{"a":1,}', /object key must be a string/],
    ['[1,]', /cannot start a value/],
    ['[1 2]', /expected `,` or `\]`/],
    ['{"a"1}', /expected `:`/],
    ['{a:1}', /object key must be a string/],
    ['01', /after the value ended/],
    ['1.', /digit after the decimal point/],
    ['.5', /cannot start a value/],
    ['tru', /expected `true`/],
    ['', /ended early/],
    ['"unterminated', /never closed/],
    ['{"a":1', /never closed/],
    ['[1,2', /never closed/],
    ['1 2', /after the value ended/],
  ];
  for (const [bad, pattern] of cases) {
    assert.throws(() => parseJson(bad), pattern, `wrong or missing error for: ${bad}`);
  }
});

test('every error carries a line and a column into the JSON', () => {
  // "Unexpected token } at position 47" is the message this exists to avoid.
  try {
    parseJson('{\n  "a": 1,\n  "b": }\n}');
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.jsonLine, 3);
    assert.ok(e.jsonColumn > 1);
    assert.match(e.message, /line 3, column \d+ of the JSON/);
  }
});

test('nesting is bounded rather than trusted', () => {
  // Otherwise a payload from outside is a stack overflow in the host process,
  // which is a crash rather than an error a program can handle.
  const deep = '['.repeat(5000) + ']'.repeat(5000);
  assert.throws(() => parseJson(deep), /nests deeper than/);
  // And the bound is well above anything real.
  assert.doesNotThrow(() => parseJson('['.repeat(150) + ']'.repeat(150)));
});

// ---------------------------------------------------------------------------
// numbers, which is where JSON.parse loses money
// ---------------------------------------------------------------------------

test('a fractional literal comes back exact, not as a float', () => {
  const v = parseJson('{"total":19.99}').get('total');
  assert.ok(v instanceof Decimal, `19.99 parsed as ${v?.constructor?.name}`);
  assert.equal(String(v), '19.99');
});

test('trailing zeros survive, which is the whole point', () => {
  // JSON.parse('{"a":1.10}').a is 1.1. That is a different number to an
  // accountant, and this language has a type that knows it.
  assert.equal(String(parseJson('{"a":1.10}').get('a')), '1.10');
  assert.equal(JSON.parse('{"a":1.10}').a, 1.1);
});

test('an exponent means the author meant a float, so it stays one', () => {
  assert.equal(typeof parseJson('1e10'), 'number');
  assert.equal(typeof parseJson('2.5e3'), 'number');
  // Whereas a plain fraction does not.
  assert.ok(parseJson('2.5') instanceof Decimal);
});

test('an integer stays an ordinary number', () => {
  assert.equal(parseJson('42'), 42);
  assert.equal(parseJson('-7'), -7);
  assert.equal(parseJson('0'), 0);
});

test('a decimal round-trips back to the same text', () => {
  for (const n of ['19.99', '0.1', '1.10', '100.000', '-3.50']) {
    assert.equal(writeJson(parseJson(n)), n);
  }
});

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

test('writing produces something this parser reads back', () => {
  const value = parseJson('{"a":[1,2,{"b":null}],"c":true,"d":"x","e":1.50}');
  assert.deepEqual(parseJson(writeJson(value)), value);
});

test('indenting is optional and does not change the meaning', () => {
  const value = parseJson('{"a":[1,2]}');
  const flat = writeJson(value);
  const pretty = writeJson(value, { indent: 2 });
  assert.ok(pretty.includes('\n'));
  assert.ok(!flat.includes('\n'));
  assert.deepEqual(parseJson(pretty), parseJson(flat));
});

test('a value containing itself is refused rather than overflowing', () => {
  const m = new Map();
  m.set('self', m);
  assert.throws(() => writeJson(m), /contains itself/);
  const a = [];
  a.push(a);
  assert.throws(() => writeJson(a), /contains itself/);
});

test('a repeated value that is not a cycle is fine', () => {
  // The cycle check must not mistake sharing for recursion.
  const shared = new Map([['x', 1]]);
  assert.doesNotThrow(() => writeJson([shared, shared]));
  assert.equal(writeJson([shared, shared]), '[{"x":1},{"x":1}]');
});

test('what JSON cannot spell is refused, and says so', () => {
  assert.throws(() => writeJson(Infinity), /no way to spell it/);
  assert.throws(() => writeJson(NaN), /no way to spell it/);
});

test('is_json answers before the attempt', () => {
  assert.equal(isJsonable([1, 2, new Map([['a', 'b']])]), true);
  assert.equal(isJsonable(Infinity), false);
  assert.equal(isJsonable(NaN), false);
  const cyclic = [];
  cyclic.push(cyclic);
  assert.equal(isJsonable(cyclic), false);
});

// ---------------------------------------------------------------------------
// through the language
// ---------------------------------------------------------------------------

test('a program can parse, index and write JSON', () => {
  const r = run([
    'let d = json_parse("{\\"total\\": 19.99, \\"items\\": [1, 2]}")',
    'print(str(d["total"]))',
    'print(str(len(d["items"])))',
    'print(to_json(d))',
  ].join('\n'));
  assert.equal(r.error, null);
  assert.deepEqual(r.out, ['19.99', '2', '{"total":19.99,"items":[1,2]}']);
});

test('parsed money is exact money', () => {
  const r = run([
    'let d = json_parse("{\\"a\\": 19.99}")',
    'print(str(d["a"] + 0.01d))',
  ].join('\n'));
  assert.deepEqual(r.out, ['20.00']);
});

test('a record can be written, and comes back as a map', () => {
  const r = run([
    'record Point(x, y)',
    'print(to_json(Point(1, 2)))',
  ].join('\n'));
  assert.deepEqual(r.out, ['{"x":1,"y":2}']);
});

test('to_json takes an indent width, within reason', () => {
  assert.match(run('print(to_json([1], 2))').out[0], /\[\n {2}1\n\]/);
  assert.equal(run('print(to_json([1], 99))').error, 'ValueError');
  assert.equal(run('print(to_json([1], -1))').error, 'ValueError');
  assert.equal(run('print(to_json([1], 2, 3))').error, 'ArityError');
});

test('a malformed payload is an error the program can rescue', () => {
  const r = run([
    'attempt {',
    '  json_parse("{oops}")',
    '} rescue e {',
    '  print(e["kind"])',
    '}',
  ].join('\n'));
  assert.equal(r.error, null);
  assert.deepEqual(r.out, ['JsonError']);
});

test('json_parse insists on a string', () => {
  assert.equal(run('json_parse(1)').error, 'TypeError');
  assert.equal(run('json_parse([1])').error, 'TypeError');
});

// ---------------------------------------------------------------------------
// the part that would be a hole in the model
// ---------------------------------------------------------------------------

test('taint survives the parse', () => {
  // `untrusted(body)` then `json_parse` must not launder anything. This is the
  // single most important test in this file: without it, every taint check in
  // the language can be bypassed by round-tripping through JSON.
  const r = run([
    'let raw = untrusted("{\\"user\\": \\"admin\\"}")',
    'let d = json_parse(raw)',
    'print(str(is_tainted(d)))',
  ].join('\n'));
  assert.deepEqual(r.out, ['true']);
});

test('and the taint reaches the values inside, not only the container', () => {
  const r = run([
    'let d = json_parse(untrusted("{\\"user\\": \\"admin\\"}"))',
    'print(str(is_tainted(d["user"])))',
  ].join('\n'));
  assert.deepEqual(r.out, ['true'], 'indexing an untrusted document handed back a clean value');
});

test('a grounded block refuses a parsed untrusted payload', () => {
  const r = run([
    'let d = json_parse(untrusted("{\\"a\\": 1}"))',
    'grounded { print(str(d)) }',
  ].join('\n'));
  assert.equal(r.error, 'TaintError');
});

test('clean input stays clean', () => {
  const r = run('print(str(is_tainted(json_parse("{\\"a\\":1}"))))');
  assert.deepEqual(r.out, ['false']);
});

test('writing keeps the taint of what went in', () => {
  const r = run([
    'let d = json_parse(untrusted("{\\"a\\": 1}"))',
    'print(str(is_tainted(to_json(d))))',
  ].join('\n'));
  assert.deepEqual(r.out, ['true'], 'to_json laundered an untrusted value');
});

test('none of it needs a capability', () => {
  // Parsing text is not an effect, and requiring a grant for it would make the
  // capability list mean less everywhere else.
  assert.equal(run('json_parse("{}")').error, null);
  assert.equal(run('to_json([1])').error, null);
});
