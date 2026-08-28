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

// Every .smarsh file in the repository, discovered rather than listed.
//
// This used to be a hardcoded list, and a new example escaped it: the formatter
// silently replaced unfamiliar syntax with `<ReleaseTo>` placeholders and no
// test noticed, because the file was not on the list. A coverage list that has
// to be maintained by hand is a coverage list that will be wrong.
function allSourceFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) allSourceFiles(full, found);
    else if (entry.name.endsWith('.smarsh')) found.push(full);
  }
  return found;
}

const ALL_SOURCES = [
  ...allSourceFiles(path.join(ROOT, 'examples')),
  ...allSourceFiles(path.join(ROOT, 'std')),
].sort();

// What each example needs to run is read out of its own header, not kept in a
// list here. The list drifted -- a new example that needed capabilities was
// simply run without them and failed, and the same pattern had already been
// removed from CI for the same reason.
const INVOCATION = /^\/\/\s*(?:node\s+bin\/smarsh\.mjs|smarsh)\s+run\s+\S+(.*)$/;

function grantsFor(source) {
  const caps = [];
  const principals = [];
  const foreign = [];
  const lines = source.split(/\r?\n/).slice(0, 16);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim();
    if (!line.startsWith('//')) continue;
    const m = INVOCATION.exec(line);
    if (!m) continue;

    // A wrapped command line, continued on the next comment line. Same rule as
    // tools/run-examples.mjs, which is what actually runs them.
    let rest = m[1];
    while (rest.trimEnd().endsWith('\\')) {
      rest = rest.trimEnd().slice(0, -1);
      const next = (lines[++n] ?? '').trim();
      if (!next.startsWith('//')) break;
      rest += ` ${next.replace(/^\/\/\s*/, '')}`;
    }

    const flags = rest.split(/\s+/);
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === '--grant') caps.push(...(flags[++i] ?? '').split(','));
      if (flags[i] === '--principal') principals.push(...(flags[++i] ?? '').split(','));
      if (flags[i] === '--foreign') foreign.push(...(flags[++i] ?? '').split(','));
    }
  }
  return {
    caps: caps.filter(Boolean),
    principals: principals.filter(Boolean),
    foreign: foreign.filter(Boolean),
  };
}

// Excluded on purpose: these do not produce comparable output twice.
// contracts.smarsh ships deliberate failures; agents.smarsh contains a planted
// race; crypto and devices read entropy and machine state.
const NOT_COMPARABLE = new Set(['contracts.smarsh', 'agents.smarsh', 'crypto.smarsh', 'devices.smarsh']);
const RUNNABLE = ALL_SOURCES.filter((f) => f.includes('examples')
  && !NOT_COMPARABLE.has(path.basename(f)));

function runSource(source, file, cwd) {
  const out = [];
  const { caps, principals, foreign } = grantsFor(source);
  const interp = new Interpreter({ out: (s) => out.push(s), cwd, caps, principals, foreign });
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
  const out = formatSource(source, 't.smarsh');
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
  assert.ok(ALL_SOURCES.length >= 12, `only found ${ALL_SOURCES.length} .smarsh files`);
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
  const out = formatSource(source, 't.smarsh');
  assert.ok(!out.includes('{ ... }'), 'the body was replaced with a placeholder');
  assert.match(out, /base \+ noise/);
  assert.doesNotThrow(() => parse(out, 't.smarsh'));
});

test('blank lines the author wrote are kept', () => {
  const source = 'let a = 1\n\nlet b = 2\n';
  assert.equal(formatSource(source, 't.smarsh'), 'let a = 1\n\nlet b = 2\n');
});

test('the canonical layout is applied', () => {
  const messy = 'let    x=1;\nfn   f(a,b){return a+b}\n';
  const out = formatSource(messy, 't.smarsh');
  assert.match(out, /^let x = 1$/m);
  assert.match(out, /^fn f\(a, b\) \{$/m);
  assert.match(out, /^ {2}return a \+ b$/m);
});

test('types and contracts survive formatting', () => {
  const source = 'fn area(w: num, h: num) -> num requires w > 0 ensures result > 0 { return w * h }\n';
  const out = formatSource(source, 't.smarsh');
  assert.match(out, /fn area\(w: num, h: num\) -> num/);
  assert.match(out, /requires w > 0/);
  assert.match(out, /ensures result > 0/);
  assert.doesNotThrow(() => parse(out, 't.smarsh'));
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
  const out = formatSource(source, 't.smarsh');
  assert.doesNotThrow(() => parse(out, 't.smarsh'));
  assert.match(out, /record Point\(x: num, y: num\)/);
  assert.match(out, /when x == y/);
  assert.match(out, /\$\{x\}/);
  assert.ok(isStable(source, 't.smarsh'));
});

// ---------------------------------------------------------------------------
// the test runner
// ---------------------------------------------------------------------------

function scratch(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Smarsh-tests-'));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body, 'utf8');
  }
  return dir;
}

test('discovery finds only *_test.smarsh', () => {
  const dir = scratch({
    'a_test.smarsh': 'fn test_x() { }',
    'b_test.smarsh': 'fn test_y() { }',
    'helper.smarsh': 'let x = 1',
  });
  assert.deepEqual(discover(dir).map((f) => path.basename(f)), ['a_test.smarsh', 'b_test.smarsh']);
});

test('passing and failing tests are reported separately', () => {
  const dir = scratch({
    'x_test.smarsh': [
      'fn test_passes() { assert(1 + 1 == 2, "arithmetic works") }',
      'fn test_fails() { assert(false, "this one is meant to fail") }',
    ].join('\n'),
  });
  const r = runFile(path.join(dir, 'x_test.smarsh'));
  assert.deepEqual(r.passed.map((t) => t.name), ['test_passes']);
  assert.deepEqual(r.failed.map((t) => t.name), ['test_fails']);
  assert.match(r.failed[0].error.message, /this one is meant to fail/);
});

test('contracts in the file under test are exercised automatically', () => {
  const dir = scratch({
    'c_test.smarsh': 'fn scale(x, k) requires k > 0 ensures result >= x { return x * k }',
  });
  const r = runFile(path.join(dir, 'c_test.smarsh'), { trials: 80 });
  assert.equal(r.proved.length, 1);
  assert.ok(r.proved[0].violations.length > 0,
    'the runner should find the counterexample without a test being written');
});

test('a correct contract passes without ceremony', () => {
  const dir = scratch({
    'd_test.smarsh': 'fn absolute(x) ensures result >= 0 { if x < 0 { return -x } return x }',
  });
  const r = runFile(path.join(dir, 'd_test.smarsh'), { trials: 80 });
  assert.equal(r.proved[0].violations.length + r.proved[0].crashes.length, 0);
});

test('static problems are reported without stopping the tests', () => {
  const dir = scratch({
    'e_test.smarsh': [
      'fn typed(x: num) -> str { return x }',
      'fn test_still_runs() { assert(true, "ok") }',
    ].join('\n'),
  });
  const r = runFile(path.join(dir, 'e_test.smarsh'));
  assert.equal(r.static.length, 1);
  assert.deepEqual(r.passed.map((t) => t.name), ['test_still_runs']);
});

test('a test taking arguments is skipped with a reason, not silently ignored', () => {
  const dir = scratch({ 'f_test.smarsh': 'fn test_needs_args(a) { }' });
  const r = runFile(path.join(dir, 'f_test.smarsh'));
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].why, /takes none/);
});

test('the summary is clean only when everything is', () => {
  const good = scratch({ 'g_test.smarsh': 'fn test_ok() { assert(true, "fine") }' });
  const bad = scratch({ 'h_test.smarsh': 'fn test_no() { assert(false, "nope") }' });
  assert.equal(formatResults([runFile(path.join(good, 'g_test.smarsh'))]).ok, true);
  assert.equal(formatResults([runFile(path.join(bad, 'h_test.smarsh'))]).ok, false);
});

// ---------------------------------------------------------------------------
// the standard library
// ---------------------------------------------------------------------------

test('the standard library is importable and its own tests pass', () => {
  const r = runFile(path.join(ROOT, 'std', 'std_test.smarsh'));
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.static, []);
  assert.ok(r.passed.length >= 15, `expected the std suite to run, saw ${r.passed.length} tests`);
});

test('std modules resolve from anywhere, not just next to the program', () => {
  const dir = scratch({ 'main.smarsh': 'import "std/math" as math\nmath.mean([2, 4])' });
  assert.equal(runSource(fs.readFileSync(path.join(dir, 'main.smarsh'), 'utf8'), path.join(dir, 'main.smarsh'), dir).length, 0);
  const out = [];
  const interp = new Interpreter({ out: (s) => out.push(s), cwd: dir });
  interp.entryPath = path.join(dir, 'main.smarsh');
  try {
    assert.equal(interp.run('import "std/math" as math\nmath.mean([2, 4])', 'main.smarsh'), 3);
  } finally {
    interp.devices.shutdown();
  }
});

test('a module reached by dot access behaves like a namespace', () => {
  const out = [];
  const interp = new Interpreter({ out: (s) => out.push(s), cwd: ROOT });
  interp.entryPath = path.join(ROOT, 'main.smarsh');
  try {
    assert.deepEqual(interp.run('import "std/list" as list\nlist.take([1,2,3], 2)', 'main.smarsh'), [1, 2]);
  } finally {
    interp.devices.shutdown();
  }
});

// ---------------------------------------------------------------------------
// the CLI's three lists of commands
// ---------------------------------------------------------------------------

test('every command that dispatches is also accepted, and documented', () => {
  // `lsp` was fully implemented, dispatched, and rejected with "unknown
  // command" -- because the set of valid names is a separate list from the
  // dispatch, and only one of them knew. That is the third time in this project
  // a rule has lived in two places with one of them stale, so it is asserted
  // rather than remembered.
  const cli = fs.readFileSync(path.join(ROOT, 'bin', 'smarsh.mjs'), 'utf8');

  const accepted = new Set(
    [...(/const commands = new Set\(\[([\s\S]*?)\]\)/.exec(cli)?.[1] ?? '')
      .matchAll(/'([a-z-]+)'/g)].map((m) => m[1]),
  );
  const dispatched = new Set(
    [...cli.matchAll(/command === '([a-z-]+)'\)/g)].map((m) => m[1]),
  );
  const documented = new Set(
    [...(/const HELP = `([\s\S]*?)`;/.exec(cli)?.[1] ?? '')
      .matchAll(/^\s{2}smarsh ([a-z-]+)/gm)].map((m) => m[1]),
  );

  assert.ok(accepted.size > 10, 'could not find the accepted-command list');
  assert.ok(dispatched.size > 10, 'could not find the dispatch');
  assert.ok(documented.size > 10, 'could not find the help text');

  const missingFromAccepted = [...dispatched].filter((c) => !accepted.has(c));
  assert.deepEqual(missingFromAccepted, [],
    `dispatched but rejected as unknown: ${missingFromAccepted.join(', ')}`);

  const missingFromDispatch = [...accepted].filter((c) => !dispatched.has(c));
  assert.deepEqual(missingFromDispatch, [],
    `accepted but does nothing: ${missingFromDispatch.join(', ')}`);

  const undocumented = [...dispatched].filter((c) => !documented.has(c));
  assert.deepEqual(undocumented, [],
    `works but is not in the help text: ${undocumented.join(', ')}`);
});

test('every flag the help text advertises is parsed', () => {
  // The other half of the same trap: `--verbose` was documented and dispatched
  // on, and the parser had never heard of it.
  const cli = fs.readFileSync(path.join(ROOT, 'bin', 'smarsh.mjs'), 'utf8');
  const help = /const HELP = `([\s\S]*?)`;/.exec(cli)[1];
  const advertised = new Set([...help.matchAll(/^\s{2}(--[a-z-]+)/gm)].map((m) => m[1]));
  const parsed = new Set([...cli.matchAll(/a === '(--[a-z-]+)'/g)].map((m) => m[1]));

  assert.ok(advertised.size > 5, 'could not find the options in the help text');
  const unparsed = [...advertised].filter((f) => !parsed.has(f));
  assert.deepEqual(unparsed, [], `advertised but never parsed: ${unparsed.join(', ')}`);
});

test('the language server starts as a real process and answers on the wire', async () => {
  // Every other LSP test drives the server in-process. This one is the whole
  // path an editor takes: spawn the CLI, write framed bytes to its stdin, read
  // framed bytes from its stdout. The in-process tests all passed while this
  // was completely broken.
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'smarsh.mjs'), 'lsp'],
    { stdio: ['pipe', 'pipe', 'pipe'] });

  const frame = (m) => {
    const b = Buffer.from(JSON.stringify(m), 'utf8');
    return Buffer.concat([Buffer.from(`Content-Length: ${b.length}\r\n\r\n`, 'ascii'), b]);
  };

  const seen = [];
  let buf = Buffer.alloc(0);
  child.stdout.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    for (;;) {
      const h = buf.indexOf('\r\n\r\n');
      if (h < 0) break;
      const n = Number(/Content-Length:\s*(\d+)/.exec(buf.subarray(0, h).toString('ascii'))[1]);
      if (buf.length < h + 4 + n) break;
      seen.push(JSON.parse(buf.subarray(h + 4, h + 4 + n).toString('utf8')));
      buf = buf.subarray(h + 4 + n);
    }
  });

  try {
    child.stdin.write(frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    child.stdin.write(frame({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri: 'file:///t.smarsh', languageId: 'smarsh', version: 1,
          text: 'fn f() {\n  return nope\n}\n',
        },
      },
    }));

    // Wait for the diagnostics rather than for a fixed delay: a slow machine
    // should make this slower, not flaky.
    const deadline = Date.now() + 20000;
    const published = () => seen.find((m) => m.method === 'textDocument/publishDiagnostics');
    while (!published() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const init = seen.find((m) => m.id === 1);
    assert.ok(init, 'the server never answered initialize');
    assert.equal(init.result.serverInfo.name, 'smarsh-lsp');

    const note = published();
    assert.ok(note, 'the server never published diagnostics');
    assert.equal(note.params.diagnostics[0].code, 'E0201');
    assert.equal(note.params.diagnostics[0].range.start.line, 1);
  } finally {
    child.kill();
  }
});
