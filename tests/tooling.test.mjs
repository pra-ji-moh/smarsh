import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Interpreter } from '../src/interpreter.js';
import { formatSource, isStable, statementPrinterFor } from '../src/format.js';
import { parse } from '../src/parser.js';
import { tokenize } from '../src/lexer.js';
import { discover, runFile, format as formatResults } from '../src/testrunner.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

// Every .sarvm file in the repository, discovered rather than listed.
//
// This used to be a hardcoded list, and a new example escaped it: the formatter
// silently replaced unfamiliar syntax with `<ReleaseTo>` placeholders and no
// test noticed, because the file was not on the list. A coverage list that has
// to be maintained by hand is a coverage list that will be wrong.
function allLumeFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) allLumeFiles(full, found);
    else if (entry.name.endsWith('.sarvm')) found.push(full);
  }
  return found;
}

const ALL_SOURCES = [
  ...allLumeFiles(path.join(ROOT, 'examples')),
  ...allLumeFiles(path.join(ROOT, 'std')),
].sort();

// Runnable without capabilities and without side effects, so behaviour can be
// compared before and after formatting.
const NEEDS_GRANTS = new Set([
  'crypto.sarvm', 'interop.sarvm', 'devices.sarvm', 'depth.sarvm', 'regulated.sarvm',
]);
const RUNNABLE = ALL_SOURCES.filter((f) => {
  const name = path.basename(f);
  return f.includes('examples') && !NEEDS_GRANTS.has(name)
    && !['contracts.sarvm', 'agents.sarvm'].includes(name);
});

function runSource(source, file, cwd) {
  const out = [];
  const interp = new Interpreter({ out: (s) => out.push(s), cwd });
  interp.entryPath = file;
  try {
    interp.run(source, path.basename(file));
    return out;
  } finally {
    interp.devices.shutdown();
  }
}

// ---------------------------------------------------------------------------
// the formatter
// ---------------------------------------------------------------------------

test('formatted output still parses', () => {
  for (const file of ALL_SOURCES) {
    const source = fs.readFileSync(file, 'utf8');
    const formatted = formatSource(source, path.basename(file));
    assert.doesNotThrow(() => parse(formatted, path.basename(file)),
      `formatting ${path.basename(file)} produced source that will not parse`);
  }
});

test('formatting is idempotent', () => {
  for (const file of ALL_SOURCES) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(isStable(source, path.basename(file)),
      `formatting ${path.basename(file)} twice changed it the second time`);
  }
});

// The guarantee that matters: reformatting must not change what a program does.
test('a formatted program behaves identically', () => {
  for (const file of RUNNABLE) {
    const source = fs.readFileSync(file, 'utf8');
    const cwd = path.dirname(file);
    const before = runSource(source, file, cwd);
    const after = runSource(formatSource(source, path.basename(file)), file, cwd);
    assert.deepEqual(after, before, `${path.basename(file)} behaves differently after formatting`);
  }
});

test('comments survive formatting', () => {
  const source = [
    '// a leading comment',
    'let x = 1  // trailing on the same line',
    '',
    '// about the function',
    'fn f() {',
    '  // inside',
    '  return x',
    '}',
    '',
  ].join('\n');
  const out = formatSource(source, 't.sarvm');
  assert.match(out, /\/\/ a leading comment/);
  assert.match(out, /let x = 1 {2}\/\/ trailing on the same line/);
  assert.match(out, /\/\/ about the function/);
  assert.match(out, /\/\/ inside/);
});

test('no comment is lost from any real file', () => {
  for (const file of ALL_SOURCES) {
    const source = fs.readFileSync(file, 'utf8');
    const before = tokenize(source).comments.length;
    const after = tokenize(formatSource(source, path.basename(file))).comments.length;
    assert.equal(after, before, `${path.basename(file)} lost ${before - after} comment(s)`);
  }
});

test('every file in the repository is covered by these tests', () => {
  // Guards the guard: if the discovery above ever silently finds nothing, the
  // formatter tests would all pass vacuously.
  assert.ok(ALL_SOURCES.length >= 12, `only found ${ALL_SOURCES.length} .sarvm files`);
  assert.ok(RUNNABLE.length >= 5, `only ${RUNNABLE.length} are behaviour-tested`);
});

test('the formatter knows every piece of syntax the language has', () => {
  // The failure mode this prevents: emitting `<ReleaseTo>` and calling it
  // formatted. The formatter now throws on an unknown node, so this passing
  // means every construct in the repository has a printer.
  for (const file of ALL_SOURCES) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotThrow(() => formatSource(source, path.basename(file)),
      `the formatter does not know some syntax in ${path.basename(file)}`);
  }
});

test('a construct the formatter does not know stops it rather than being papered over', () => {
  assert.throws(
    () => statementPrinterFor({ type: 'SomethingTheFormatterHasNeverSeen', line: 1 }),
    /does not know the statement/,
  );
});

test('a multi-statement lambda body is not thrown away', () => {
  // This used to emit a literal `{ ... }`, deleting the body outright.
  const source = 'let scores = fork 3 { let base = 0.4\n  let noise = 0.1\n  base + noise }\n';
  const out = formatSource(source, 't.sarvm');
  assert.ok(!out.includes('{ ... }'), 'the body was replaced with a placeholder');
  assert.match(out, /base \+ noise/);
  assert.doesNotThrow(() => parse(out, 't.sarvm'));
});

test('blank lines the author wrote are kept', () => {
  const source = 'let a = 1\n\nlet b = 2\n';
  assert.equal(formatSource(source, 't.sarvm'), 'let a = 1\n\nlet b = 2\n');
});

test('the canonical layout is applied', () => {
  const messy = 'let    x=1;\nfn   f(a,b){return a+b}\n';
  const out = formatSource(messy, 't.sarvm');
  assert.match(out, /^let x = 1$/m);
  assert.match(out, /^fn f\(a, b\) \{$/m);
  assert.match(out, /^ {2}return a \+ b$/m);
});

test('types and contracts survive formatting', () => {
  const source = 'fn area(w: num, h: num) -> num requires w > 0 ensures result > 0 { return w * h }\n';
  const out = formatSource(source, 't.sarvm');
  assert.match(out, /fn area\(w: num, h: num\) -> num/);
  assert.match(out, /requires w > 0/);
  assert.match(out, /ensures result > 0/);
  assert.doesNotThrow(() => parse(out, 't.sarvm'));
});

test('precedence is preserved, with parentheses only where needed', () => {
  assert.match(formatSource('let x = (1 + 2) * 3\n', 't'), /\(1 \+ 2\) \* 3/);
  assert.match(formatSource('let x = 1 + 2 * 3\n', 't'), /1 \+ 2 \* 3/);
  assert.match(formatSource('let x = 1 + (2 * 3)\n', 't'), /1 \+ 2 \* 3/);
});

test('records, matches and interpolation round-trip', () => {
  const source = [
    'record Point(x: num, y: num)',
    'fn f(p) {',
    '  return match p {',
    '    Point(0, 0) => "origin",',
    '    Point(x, y) when x == y => "diag ${x}",',
    '    _ => "other"',
    '  }',
    '}',
    '',
  ].join('\n');
  const out = formatSource(source, 't.sarvm');
  assert.doesNotThrow(() => parse(out, 't.sarvm'));
  assert.match(out, /record Point\(x: num, y: num\)/);
  assert.match(out, /when x == y/);
  assert.match(out, /\$\{x\}/);
  assert.ok(isStable(source, 't.sarvm'));
});

// ---------------------------------------------------------------------------
// the test runner
// ---------------------------------------------------------------------------

function scratch(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Sarvm-tests-'));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body, 'utf8');
  }
  return dir;
}

test('discovery finds only *_test.sarvm', () => {
  const dir = scratch({
    'a_test.sarvm': 'fn test_x() { }',
    'b_test.sarvm': 'fn test_y() { }',
    'helper.sarvm': 'let x = 1',
  });
  assert.deepEqual(discover(dir).map((f) => path.basename(f)), ['a_test.sarvm', 'b_test.sarvm']);
});

test('passing and failing tests are reported separately', () => {
  const dir = scratch({
    'x_test.sarvm': [
      'fn test_passes() { assert(1 + 1 == 2, "arithmetic works") }',
      'fn test_fails() { assert(false, "this one is meant to fail") }',
    ].join('\n'),
  });
  const r = runFile(path.join(dir, 'x_test.sarvm'));
  assert.deepEqual(r.passed.map((t) => t.name), ['test_passes']);
  assert.deepEqual(r.failed.map((t) => t.name), ['test_fails']);
  assert.match(r.failed[0].error.message, /this one is meant to fail/);
});

test('contracts in the file under test are exercised automatically', () => {
  const dir = scratch({
    'c_test.sarvm': 'fn scale(x, k) requires k > 0 ensures result >= x { return x * k }',
  });
  const r = runFile(path.join(dir, 'c_test.sarvm'), { trials: 80 });
  assert.equal(r.proved.length, 1);
  assert.ok(r.proved[0].violations.length > 0,
    'the runner should find the counterexample without a test being written');
});

test('a correct contract passes without ceremony', () => {
  const dir = scratch({
    'd_test.sarvm': 'fn absolute(x) ensures result >= 0 { if x < 0 { return -x } return x }',
  });
  const r = runFile(path.join(dir, 'd_test.sarvm'), { trials: 80 });
  assert.equal(r.proved[0].violations.length + r.proved[0].crashes.length, 0);
});

test('static problems are reported without stopping the tests', () => {
  const dir = scratch({
    'e_test.sarvm': [
      'fn typed(x: num) -> str { return x }',
      'fn test_still_runs() { assert(true, "ok") }',
    ].join('\n'),
  });
  const r = runFile(path.join(dir, 'e_test.sarvm'));
  assert.equal(r.static.length, 1);
  assert.deepEqual(r.passed.map((t) => t.name), ['test_still_runs']);
});

test('a test taking arguments is skipped with a reason, not silently ignored', () => {
  const dir = scratch({ 'f_test.sarvm': 'fn test_needs_args(a) { }' });
  const r = runFile(path.join(dir, 'f_test.sarvm'));
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].why, /takes none/);
});

test('the summary is clean only when everything is', () => {
  const good = scratch({ 'g_test.sarvm': 'fn test_ok() { assert(true, "fine") }' });
  const bad = scratch({ 'h_test.sarvm': 'fn test_no() { assert(false, "nope") }' });
  assert.equal(formatResults([runFile(path.join(good, 'g_test.sarvm'))]).ok, true);
  assert.equal(formatResults([runFile(path.join(bad, 'h_test.sarvm'))]).ok, false);
});

// ---------------------------------------------------------------------------
// the standard library
// ---------------------------------------------------------------------------

test('the standard library is importable and its own tests pass', () => {
  const r = runFile(path.join(ROOT, 'std', 'std_test.sarvm'));
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.static, []);
  assert.ok(r.passed.length >= 15, `expected the std suite to run, saw ${r.passed.length} tests`);
});

test('std modules resolve from anywhere, not just next to the program', () => {
  const dir = scratch({ 'main.sarvm': 'import "std/math" as math\nmath.mean([2, 4])' });
  assert.equal(runSource(fs.readFileSync(path.join(dir, 'main.sarvm'), 'utf8'), path.join(dir, 'main.sarvm'), dir).length, 0);
  const out = [];
  const interp = new Interpreter({ out: (s) => out.push(s), cwd: dir });
  interp.entryPath = path.join(dir, 'main.sarvm');
  try {
    assert.equal(interp.run('import "std/math" as math\nmath.mean([2, 4])', 'main.sarvm'), 3);
  } finally {
    interp.devices.shutdown();
  }
});

test('a module reached by dot access behaves like a namespace', () => {
  const out = [];
  const interp = new Interpreter({ out: (s) => out.push(s), cwd: ROOT });
  interp.entryPath = path.join(ROOT, 'main.sarvm');
  try {
    assert.deepEqual(interp.run('import "std/list" as list\nlist.take([1,2,3], 2)', 'main.sarvm'), [1, 2]);
  } finally {
    interp.devices.shutdown();
  }
});
