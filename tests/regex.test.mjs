import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Regex, MAX_REPEAT } from '../src/regex.js';
import { Interpreter } from '../src/interpreter.js';
import { formatSource } from '../src/format.js';
import { parse } from '../src/parser.js';
import { tokenize } from '../src/lexer.js';

// Regular expressions, matched in linear time.
//
// The engine is Thompson's construction rather than a backtracker, and the
// reason is the last section of this file: `(a+)+b` against forty characters is
// milliseconds here and longer than anyone will wait in JavaScript's `RegExp`.
// A runtime whose claim is bounded authority cannot offer an operation whose
// cost is unbounded in its input.
//
// Everything else is the ordinary work of not getting a regex engine wrong,
// which is a place where a subtle bug is a security bug: a pattern that matches
// something it should not is a validator that lets something through.

const found = (pattern, subject) => {
  const m = new Regex(pattern).exec(subject);
  return m === null ? null : subject.slice(m[0][0], m[0][1]);
};

function run(source) {
  const out = [];
  const interp = new Interpreter({ out: (s) => out.push(s), seed: 1 });
  try {
    interp.run(source, 't.smarsh');
    return { out, error: null, message: '' };
  } catch (e) {
    return { out, error: e.kind ?? 'error', message: e.message ?? '' };
  } finally {
    interp.devices.shutdown();
  }
}

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------

test('literals, and where they are found', () => {
  assert.equal(found('abc', 'xxabcyy'), 'abc');
  assert.equal(found('abc', 'xxabyy'), null);
  assert.equal(found('', 'abc'), '');
});

test('the three quantifiers', () => {
  assert.equal(found('a+', 'caaab'), 'aaa');
  assert.equal(found('a*', 'bbb'), '');
  assert.equal(found('ba*', 'bbb'), 'b');
  assert.equal(found('colou?r', 'color'), 'color');
  assert.equal(found('colou?r', 'colour'), 'colour');
});

test('bounded repetition', () => {
  assert.equal(found('a{2}', 'aaa'), 'aa');
  assert.equal(found('a{2,3}', 'aaaa'), 'aaa');
  assert.equal(found('a{2,}', 'aaaa'), 'aaaa');
  assert.equal(found('a{3}', 'aa'), null);
  // A brace that does not open a count is a literal brace, as everywhere else.
  assert.equal(found('a{x', 'a{x'), 'a{x');
});

test('character classes', () => {
  assert.equal(found('[0-9]+', 'id 4711 x'), '4711');
  assert.equal(found('[^0-9]+', '4711abc'), 'abc');
  assert.equal(found('[a-c]+', 'xabcy'), 'abc');
  // A dash at the end is a literal dash, not a broken range.
  assert.equal(found('[a-]+', 'x-a-y'), '-a-');
  assert.equal(found('[]]', ']'), ']');
});

test('the named classes, and their negations', () => {
  assert.equal(found('\\d+', 'a123b'), '123');
  assert.equal(found('\\D+', '123abc'), 'abc');
  assert.equal(found('\\w+', ' hi_there!'), 'hi_there');
  assert.equal(found('\\W+', 'ab!! cd'), '!! ');
  assert.equal(found('\\s+', 'a \t b'), ' \t ');
  assert.equal(found('\\S+', '   abc'), 'abc');
  // And inside a class.
  assert.equal(found('[\\d]+', 'x42'), '42');
  assert.equal(found('[\\d\\s]+', 'x4 2y'), '4 2');
});

test('escapes make a metacharacter ordinary', () => {
  assert.equal(found('a\\.c', 'a.c'), 'a.c');
  assert.equal(found('a\\.c', 'abc'), null, '`\\.` matched any character');
  assert.equal(found('a\\*', 'a*'), 'a*');
  assert.equal(found('\\\\', 'a\\b'), '\\');
  assert.equal(found('\\n', 'a\nb'), '\n');
});

test('the dot matches anything but a newline', () => {
  assert.equal(found('a.c', 'abc'), 'abc');
  assert.equal(found('a.c', 'a\nc'), null);
});

test('alternation prefers its earlier branch', () => {
  assert.equal(found('a|bb', 'xbby'), 'bb');
  assert.equal(found('ab|a', 'ab'), 'ab');
  assert.equal(found('cat|dog|bird', 'a dog here'), 'dog');
});

test('anchors', () => {
  assert.equal(found('^abc', 'abcd'), 'abc');
  assert.equal(found('^abc', 'xabc'), null);
  assert.equal(found('c$', 'abc'), 'c');
  assert.equal(found('c$', 'abcd'), null);
  assert.equal(found('^$', ''), '');
});

test('groups, capturing and not', () => {
  assert.equal(found('(ab)+', 'ababab'), 'ababab');
  assert.equal(found('(?:ab)+', 'abab'), 'abab');
  const re = new Regex('(?:x)(y)');
  assert.equal(re.groups, 1, 'a non-capturing group was counted');
});

test('captures come back with their positions', () => {
  const subject = 'order 12-34 done';
  const m = new Regex('(\\d+)-(\\d+)').exec(subject);
  assert.deepEqual(m.slice(1).map(([a, b]) => subject.slice(a, b)), ['12', '34']);
});

test('a group that did not participate is null, not empty', () => {
  // The difference matters: "matched nothing" and "was not reached" are
  // different answers, and collapsing them loses information.
  const m = new Regex('(a)|(b)').exec('b');
  assert.equal(m[1], null);
  assert.notEqual(m[2], null);
});

test('every match, left to right, without overlapping', () => {
  const subject = 'a1 b22 c333';
  const all = new Regex('\\d+').all(subject).map(([[a, b]]) => subject.slice(a, b));
  assert.deepEqual(all, ['1', '22', '333']);
});

test('a zero-width match still advances', () => {
  // Otherwise `all` never terminates, which is the classic way this goes wrong.
  const all = new Regex('a*').all('bab');
  assert.ok(all.length > 0 && all.length < 10, `${all.length} matches; it did not advance`);
});

// ---------------------------------------------------------------------------
// what it refuses, and why
// ---------------------------------------------------------------------------

test('backreferences are refused, with the reason', () => {
  // Not an implementation limit: backreferences make matching NP-hard, which is
  // what the feature means rather than how it happens to be built.
  assert.throws(() => new Regex('(a+)\\1'), /backreferences are not supported/);
  assert.throws(() => new Regex('(a+)\\1'), /exponential/);
});

test('lookaround is refused, with the reason', () => {
  assert.throws(() => new Regex('(?=x)'), /linear time/);
  assert.throws(() => new Regex('(?!x)'), /linear time/);
  assert.throws(() => new Regex('(?<=x)'), /linear time/);
});

test('a malformed pattern says what is wrong and where', () => {
  const cases = [
    ['(unclosed', /group was never closed/],
    ['[unclosed', /character class was never closed/],
    ['a**', /nothing to repeat/],
    ['*x', /nothing to repeat/],
    ['+x', /nothing to repeat/],
    ['a{2,1}', /upper bound is below/],
    ['[z-a]', /runs backwards/],
    ['a)', /unmatched/],
    ['a\\', /ended after a backslash/],
  ];
  for (const [bad, pattern] of cases) {
    assert.throws(() => new Regex(bad), pattern, `wrong or missing error for: ${bad}`);
  }
  // And the position is in the message, so it can be pointed at.
  assert.throws(() => new Regex('a{2,1}'), /position \d+ of/);
});

test('repetition is bounded', () => {
  // `a{100000}` would otherwise be a way to make the runtime allocate a hundred
  // thousand instructions from six characters of input.
  assert.doesNotThrow(() => new Regex(`a{${MAX_REPEAT}}`));
  assert.throws(() => new Regex(`a{${MAX_REPEAT + 1}}`), /repetition above/);
});

test('a pattern that is not a string is refused', () => {
  assert.throws(() => new Regex(42), /must be a string/);
  assert.throws(() => new Regex(null), /must be a string/);
});

// ---------------------------------------------------------------------------
// the whole reason this is not RegExp
// ---------------------------------------------------------------------------

test('a pattern that is catastrophic elsewhere is not catastrophic here', () => {
  // `(a+)+b` against a run of a's is the textbook ReDoS. A backtracking engine
  // explores every way of splitting the a's between the two quantifiers, which
  // is exponential; V8 takes seconds at 24 characters and hours at 40.
  //
  // This engine runs every thread in lockstep with at most one per instruction,
  // so the work is bounded by (instructions x characters) whatever the input.
  const started = Date.now();
  assert.equal(new Regex('(a+)+b').test('a'.repeat(40)), false);
  const ms = Date.now() - started;
  assert.ok(ms < 2000, `took ${ms} ms; the linear bound is gone`);
});

test('and it stays linear as the subject grows', () => {
  // Doubling the input must roughly double the time, not square it. Measured
  // loosely -- this is a smoke test for an exponential blowup, not a benchmark.
  const re = new Regex('(a+)+b');
  const time = (n) => {
    const t = Date.now();
    re.test('a'.repeat(n));
    return Date.now() - t;
  };
  time(200);                                  // warm
  const small = Math.max(1, time(200));
  const large = Math.max(1, time(400));
  assert.ok(large < small * 12, `200 chars ${small} ms, 400 chars ${large} ms -- not linear`);
});

test('other classic blowups are also fine', () => {
  const started = Date.now();
  for (const [pattern, subject] of [
    ['(a|a)*b', 'a'.repeat(30)],
    ['(a*)*b', 'a'.repeat(30)],
    ['a{1,50}{1,50}c'.replace('{1,50}{1,50}', '{1,50}'), 'a'.repeat(60)],
  ]) {
    new Regex(pattern).test(subject);
  }
  assert.ok(Date.now() - started < 3000, 'one of the classic blowups is still a blowup');
});

// ---------------------------------------------------------------------------
// raw strings, which regular expressions made necessary
// ---------------------------------------------------------------------------

test('a raw string is exactly its characters', () => {
  const r = run('let s = r"a\\tb"\nprint(s)\nprint(str(len(s)))');
  assert.equal(r.error, null);
  assert.equal(r.out[0], 'a\\tb', 'the escape was interpreted');
  assert.equal(r.out[1], '4');
});

test('a raw string does not interpolate', () => {
  const r = run('let x = 1\nprint(r"${x}")');
  assert.deepEqual(r.out, ['${x}']);
});

test('either quote works, so either can appear inside', () => {
  assert.deepEqual(run(`print(r'say "hi"')`).out, ['say "hi"']);
  assert.deepEqual(run(`print(r"it's")`).out, ["it's"]);
});

test('an identifier starting with r is still an identifier', () => {
  // The lexer sees `r` followed by a quote. Anything else is a name, and
  // getting this wrong would break every variable called `rate` or `result`.
  const r = run('let rate = 2\nlet radius = 3\nlet r = 4\nprint(str(rate + radius + r))');
  assert.equal(r.error, null);
  assert.deepEqual(r.out, ['9']);
});

test('an unterminated raw string says so', () => {
  const r = run('let s = r"never closed');
  assert.equal(r.error, 'SyntaxError');
  assert.match(r.message, /never closed/);
});

test('the unknown-escape error points at raw strings', () => {
  // This is how someone writing a pattern finds out the notation exists.
  const r = run('let s = "\\d+"');
  assert.equal(r.error, 'SyntaxError');
});

test('the formatter puts a raw string back the way it was written', () => {
  // Without this, `smarsh fmt` rewrites `r"\d+"` as `"\\d+"` -- same meaning,
  // and it destroys the readability the notation exists for.
  const source = 'let p = r"^\\d{3}-\\d{4}$"\n';
  const formatted = formatSource(source, 't.smarsh');
  assert.match(formatted, /r"\^\\d\{3\}-\\d\{4\}\$"/);
  // And it is stable.
  assert.equal(formatSource(formatted, 't.smarsh'), formatted);
});

test('a raw string containing both quotes falls back to escaping', () => {
  // There is no raw form of it, and emitting `r"..."` with an unescapable quote
  // inside would produce source that does not parse.
  const source = `let s = "a\\"b'c"\n`;
  const formatted = formatSource(source, 't.smarsh');
  assert.doesNotThrow(() => parse(formatted, 't.smarsh'));
});

test('the token carries the flag, and only for raw strings', () => {
  const raw = tokenize('r"x"', 't.smarsh').find((t) => t.type === 'str');
  const plain = tokenize('"x"', 't.smarsh').find((t) => t.type === 'str');
  assert.equal(raw.raw, true);
  assert.notEqual(plain.raw, true);
});

// ---------------------------------------------------------------------------
// through the language
// ---------------------------------------------------------------------------

test('the five entry points do what they say', () => {
  const r = run([
    'print(str(re_test(r"^\\d+$", "123")))',
    'print(re_match(r"(\\w+)@(\\w+)", "me@here")["match"])',
    'print(str(re_all(r"\\d+", "a1 b22").map(fn(x) { return x["match"] })))',
    'print(re_replace(r"\\d+", "a1 b22", "#"))',
    'print(str(re_split(r",\\s*", "a, b,c")))',
  ].join('\n'));
  assert.equal(r.error, null);
  assert.deepEqual(r.out, [
    'true',
    'me@here',
    '["1", "22"]',
    'a# b#',
    '["a", "b", "c"]',
  ]);
});

test('a match reports where it was found', () => {
  const r = run([
    'let m = re_match(r"\\d+", "ab 42 cd")',
    'print(str(m["start"]) + ".." + str(m["end"]))',
  ].join('\n'));
  assert.deepEqual(r.out, ['3..5']);
});

test('no match is nil, not an error', () => {
  const r = run('print(str(re_match(r"z+", "abc") == nil))');
  assert.deepEqual(r.out, ['true']);
});

test('replacement refers to groups with $1', () => {
  assert.deepEqual(run('print(re_replace(r"(\\w+)@(\\w+)", "me@here", "$2/$1"))').out, ['here/me']);
  // And `$$` is a literal dollar, so a replacement containing money is safe.
  assert.deepEqual(run('print(re_replace(r"x", "x", "$$5"))').out, ['$5']);
  // A group that did not participate contributes nothing rather than "null".
  assert.deepEqual(run('print(re_replace(r"(a)|(b)", "b", "[$1]"))').out, ['[]']);
});

test('a bad pattern is an error the program can rescue', () => {
  const r = run([
    'attempt {',
    '  re_test(r"(unclosed", "x")',
    '} rescue e {',
    '  print(e["kind"])',
    '}',
  ].join('\n'));
  assert.deepEqual(r.out, ['RegexError']);
});

test('taint survives a match', () => {
  // A pattern applied to untrusted input yields untrusted results. Without
  // this, matching would be a way to launder provenance.
  const r = run([
    'let m = re_match(r"\\d+", untrusted("id 42"))',
    'print(str(is_tainted(m)))',
    'print(str(is_tainted(re_replace(r"\\d", untrusted("a1"), "x"))))',
  ].join('\n'));
  assert.deepEqual(r.out, ['true', 'true']);
});

test('the arguments are checked', () => {
  assert.equal(run('re_test(1, "x")').error, 'TypeError');
  assert.equal(run('re_test(r"a", 1)').error, 'TypeError');
  assert.equal(run('re_replace(r"a", "a", 1)').error, 'TypeError');
});

test('none of it needs a capability', () => {
  // Matching text is not an effect.
  assert.equal(run('re_test(r"a", "a")').error, null);
});
