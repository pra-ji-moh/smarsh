import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// `--json` is the interface a program uses to drive this one, and most Smarsh
// will be written by a program.
//
// The rendered output draws a caret under a span with box characters, which is
// right for a terminal and unusable to anything that has to act on it. These
// tests treat the JSON shape as a contract: a generator that reads `line` and
// `code` to fix its own output must not have those disappear or be renamed.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'smarsh.mjs');

let dir;
const write = (name, body) => {
  if (!dir) dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarsh-json-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
};

function cli(args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? '') };
  }
}

const json = (args) => {
  const r = cli(args);
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(r.out); },
    '--json did not produce parseable JSON: ' + r.out.slice(0, 400));
  return { ...r, json: parsed };
};

test('check --json reports a problem as data', () => {
  const f = write('bad.smarsh', 'let z = undefined_name\n');
  const { json: j, code } = json(['check', f, '--json']);
  assert.equal(code, 1, 'a file with a problem must exit non-zero');
  assert.equal(j.ok, false);
  assert.equal(j.command, 'check');
  assert.equal(j.diagnostics.length, 1);
  const d = j.diagnostics[0];
  assert.equal(d.code, 'E0201');
  assert.equal(d.title, 'name not found');
  assert.equal(d.severity, 'error');
  assert.equal(d.line, 1);
  assert.ok(d.column >= 1, 'a column is what an editor needs');
  assert.match(d.message, /undefined_name/);
  assert.equal(d.explain, 'smarsh explain E0201');
});

test('check --json on a clean file says so', () => {
  const f = write('good.smarsh', 'let x = 1\nprint(x)\n');
  const { json: j, code } = json(['check', f, '--json']);
  assert.equal(code, 0);
  assert.equal(j.ok, true);
  assert.deepEqual(j.diagnostics, []);
});

test('check --json carries the suggestion, which is the point of it', () => {
  const f = write('typo.smarsh', 'let total = 1\nprint(totl)\n');
  const { json: j } = json(['check', f, '--json']);
  const d = j.diagnostics.find((x) => x.code === 'E0201');
  assert.ok(d, 'the typo was not reported');
  assert.ok(d.helps.length > 0, 'no suggestion offered');
  assert.match(d.helps.join(' '), /total/);
});

test('run --json separates what the program printed from how it failed', () => {
  const f = write('fail.smarsh', [
    'fn half(x) requires x > 0 { return x / 2 }',
    'print("before")',
    'print(half(0 - 4))',
  ].join('\n'));
  const { json: j, code } = json(['run', f, '--json']);
  assert.equal(code, 1);
  assert.equal(j.ok, false);
  assert.deepEqual(j.stdout, ['before'], 'output up to the failure is kept');
  assert.equal(j.failure.kind, 'ContractError');
  assert.equal(j.failure.code, 'E0401');
  assert.equal(j.failure.line, 3);
  assert.ok(j.failure.stack.length > 0, 'a stack is what locates the caller');
  assert.equal(j.failure.stack[0].function, 'half');
});

test('run --json on success reports the output and how to replay it', () => {
  const f = write('ok.smarsh', 'print(1 + 1)\n');
  const { json: j, code } = json(['run', f, '--json']);
  assert.equal(code, 0);
  assert.equal(j.ok, true);
  assert.equal(j.failure, null);
  assert.deepEqual(j.stdout, ['2']);
  assert.equal(j.replay.seed, 0);
  assert.ok(j.work.steps > 0);
});

test('run --json reports a refused capability as such', () => {
  const f = write('caps.smarsh', 'fn save(t) { write("out.txt", t) }\nsave("x")\n');
  const { json: j } = json(['run', f, '--json']);
  assert.equal(j.ok, false);
  assert.equal(j.failure.kind, 'CapabilityError');
  assert.equal(j.failure.code, 'E0402');
  assert.match(j.failure.message, /fs/);
});

test('run --json still produces one JSON document when nothing is wrong', () => {
  const f = write('quiet.smarsh', 'let x = 1\n');
  const r = cli(['run', f, '--json']);
  assert.doesNotThrow(() => JSON.parse(r.out), 'stdout must be exactly one document');
});

test('test --json names what failed and why', () => {
  const f = write('demo_test.smarsh', [
    'fn double(x) requires x >= 0 ensures result == x * 2 { return x + x }',
    '',
    'fn test_passes() { assert(double(2) == 4, "two doubled") }',
    '',
    'fn test_fails() { assert(double(3) == 7, "this one is wrong") }',
  ].join('\n'));
  const { json: j, code } = json(['test', f, '--json']);
  assert.equal(code, 1);
  assert.equal(j.ok, false);
  assert.equal(j.totals.passed, 1);
  assert.equal(j.totals.failed, 1);
  const file = j.files[0];
  assert.deepEqual(file.passed, ['test_passes']);
  assert.equal(file.failed[0].name, 'test_fails');
  assert.equal(file.failed[0].kind, 'AssertError');
  assert.match(file.failed[0].message, /this one is wrong/);
  assert.ok(file.failed[0].line >= 1);
});

test('test --json reports a contract counterexample with its arguments', () => {
  const f = write('broken_test.smarsh', [
    'fn triple(x) requires x >= 0 ensures result == x * 3 { return x * 2 }',
    '',
    'fn test_nothing() { assert(true, "placeholder") }',
  ].join('\n'));
  const { json: j } = json(['test', f, '--json']);
  assert.equal(j.ok, false);
  assert.ok(j.totals.counterexamples > 0, 'the broken contract was not caught');
  const c = j.files[0].contracts.find((x) => x.name === 'triple');
  assert.ok(c.counterexamples.length > 0);
  assert.ok(c.counterexamples[0].arguments !== undefined,
    'a counterexample without its arguments cannot be acted on');
});

test('every --json command uses the same shape for a failure', () => {
  const bad = write('shape.smarsh', 'fn f(x) requires x > 0 { return x }\nf(0 - 1)\n');
  const run = json(['run', bad, '--json']).json.failure;
  const chk = json(['check', write('shape2.smarsh', 'let a = nope\n'), '--json']).json.diagnostics[0];
  for (const key of ['severity', 'code', 'message', 'file', 'line', 'helps', 'notes', 'explain']) {
    assert.ok(key in run, "run's failure is missing " + key);
    assert.ok(key in chk, "check's diagnostic is missing " + key);
  }
});
