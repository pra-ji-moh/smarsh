import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The command-line contract.
//
// This is the interface everything that is not JavaScript uses, and it is the
// reason there are no language bindings. A Python, Go or Rust caller runs a
// process and parses JSON; if that gives them everything a Node caller gets,
// nobody needs a binding, and Smarsh stays bound to no ecosystem.
//
// That only holds while the contract is complete. It was not: `--json` reported
// `"ok": true` for a program that tried to read a file it was not granted,
// caught its own error and carried on. The refusal existed in the embedding
// API and nowhere on the command line, which is precisely the gap that makes
// people ask for bindings.
//
// So these tests treat the JSON as a published interface rather than as an
// implementation detail. A field disappearing from it is a breaking change for
// callers this project will never see.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'smarsh.mjs');

function cli(args, { code = null } = {}) {
  let file = null;
  if (code !== null) {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'smarsh-contract-')), 'p.smarsh');
    fs.writeFileSync(file, code);
    args = [args[0], file, ...args.slice(1)];
  }
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out);
  } catch (e) {
    // A failing program exits non-zero and still prints its JSON. That is the
    // contract: the document is the answer, the exit code is a convenience.
    if (e.stdout) return JSON.parse(e.stdout);
    throw e;
  } finally {
    if (file) fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// the shape callers depend on
// ---------------------------------------------------------------------------

test('run --json has every field a caller needs', () => {
  const r = cli(['run', '--json'], { code: 'print("hi")\n42\n' });
  for (const key of ['ok', 'command', 'file', 'outcome', 'stdout', 'failure',
    'replay', 'work', 'refused', 'manifest']) {
    assert.ok(key in r, `\`${key}\` is missing from run --json`);
  }
  assert.equal(r.ok, true);
  assert.equal(r.command, 'run');
  assert.equal(r.outcome, 'completed');
  assert.deepEqual(r.stdout, ['hi']);
  assert.equal(r.failure, null);
});

test('what a program tried and was refused is in the document', () => {
  // The test this file exists for. A program that catches its own
  // CapabilityError and carries on looks like it behaved; the record does not
  // agree with it, and a caller in any language can see that.
  const r = cli(['run', '--json'], {
    code: [
      'print("working")',
      'attempt { read("/etc/passwd") } rescue e { print("done") }',
      'attempt { http_get("https://exfil.test/") } rescue e { print("done") }',
    ].join('\n'),
  });

  assert.equal(r.ok, true, 'the program handled both and completed');
  assert.deepEqual(r.stdout, ['working', 'done', 'done']);

  assert.equal(r.refused.length, 2, 'a swallowed refusal vanished from the contract');
  const caps = r.refused.map((x) => x.capability).sort();
  assert.deepEqual(caps, ['fs', 'net']);
  for (const refusal of r.refused) {
    assert.equal(refusal.kind, 'capability');
    assert.ok(refusal.line > 0, 'a refusal with no line is not actionable');
    assert.ok(refusal.message.length > 0);
  }
});

test('a label refusal is reported apart from a capability refusal', () => {
  const r = cli(['run', '--json'], {
    code: [
      'let v = classify("secret", "alice", ["alice"])',
      'attempt { release_to "bob" { print(str(v)) } } rescue e { print("caught") }',
    ].join('\n'),
  });
  assert.ok(r.refused.some((x) => x.kind === 'confidentiality'),
    `kinds were ${r.refused.map((x) => x.kind).join(', ')}`);
});

test('a clean run refuses nothing, and says so as an empty list', () => {
  // Not `null`, not a missing key. A caller should not have to special-case it.
  const r = cli(['run', '--json'], { code: 'print(1)\n' });
  assert.deepEqual(r.refused, []);
});

test('the record comes back on stdout, not only to a file', () => {
  // A caller that is not going to read a file still gets the evidence.
  const r = cli(['run', '--json'], { code: 'print(1)\n' });
  assert.ok(r.manifest, 'no manifest in the document');
  assert.ok(Array.isArray(r.manifest.events));
  assert.ok(r.manifest.program?.sha256, 'the manifest does not identify the program');
  assert.equal(r.manifest.outcome, 'completed');
});

test('a failing program still produces a complete document', () => {
  const r = cli(['run', '--json'], { code: 'print("before")\nlet x = nope\n' });
  assert.equal(r.ok, false);
  // `outcome` names the kind as well: "failed: NameError". `ok` is the boolean
  // a caller switches on, and `failure.kind` is the machine-readable kind, so
  // this field is the human-readable summary of both.
  assert.match(r.outcome, /^failed: /);
  assert.deepEqual(r.stdout, ['before'], 'output before the failure was lost');
  assert.equal(r.failure.kind, 'NameError');
  assert.ok(r.failure.line > 0);
  assert.ok(r.manifest, 'a failed run produced no record');
});

test('replay carries everything needed to run it again', () => {
  const r = cli(['run', '--json', '--seed', '7', '--grant', 'clock'], { code: 'print(1)\n' });
  assert.equal(r.replay.seed, 7);
  assert.deepEqual(r.replay.capabilities, ['clock']);
  assert.deepEqual(r.replay.principals, []);
});

test('work reports what the run cost', () => {
  const r = cli(['run', '--json'], { code: 'var t = 0\nfor i in range(50) { t = t + i }\n' });
  assert.ok(r.work.steps > 50, `only ${r.work.steps} steps counted`);
  assert.equal(typeof r.work.calls, 'number');
  assert.equal(typeof r.work.contracts_checked, 'number');
});

// ---------------------------------------------------------------------------
// check, the other half of a generate-and-repair loop
// ---------------------------------------------------------------------------

test('check --json reports problems a model can repair from', () => {
  const r = cli(['check', '--json'], { code: 'fn f() {\n  return nope\n}\n' });
  assert.equal(r.ok, false);
  assert.ok(r.diagnostics.length > 0);
  const [d] = r.diagnostics;
  for (const key of ['severity', 'code', 'message', 'line', 'column']) {
    assert.ok(key in d, `\`${key}\` is missing from a diagnostic`);
  }
  assert.equal(d.code, 'E0201');
  assert.equal(d.line, 2);
});

test('check --json on a clean file says so', () => {
  const r = cli(['check', '--json'], { code: 'let x = 1\nprint(x)\n' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.diagnostics, []);
});

// ---------------------------------------------------------------------------
// the whole point: no bindings needed
// ---------------------------------------------------------------------------

test('everything a caller needs is JSON on stdout', () => {
  // If this holds, a wrapper in any language is a process call and a parse.
  // That is why there are no bindings, and why there should not be: an SDK
  // binds this to an ecosystem, and the format binds it to none.
  const r = cli(['run', '--json'], {
    code: 'attempt { read("x") } rescue e { print("ok") }\n',
  });

  const asText = JSON.stringify(r);
  assert.doesNotThrow(() => JSON.parse(asText), 'the document does not round-trip');

  // The four questions a caller has, all answerable from the document alone.
  assert.equal(typeof r.ok, 'boolean', 'did it complete?');
  assert.ok(Array.isArray(r.stdout), 'what did it say?');
  assert.ok(Array.isArray(r.refused), 'what did it try?');
  assert.ok(r.manifest !== undefined, 'what is the evidence?');
});

test('the exit code agrees with the document', () => {
  // A caller that only checks the exit code must not disagree with one that
  // reads the JSON.
  const ok = execFileSync(process.execPath, [CLI, 'eval', 'print(1)', '--json'], { encoding: 'utf8' });
  assert.equal(JSON.parse(ok).ok, true);

  let failed = null;
  try {
    execFileSync(process.execPath, [CLI, 'eval', 'nope', '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    failed = e;
  }
  assert.ok(failed, 'a failing program exited zero');
  assert.equal(JSON.parse(failed.stdout).ok, false);
});

test('eval answers in the same shape as run', () => {
  // `eval` takes the source directly, so a caller in another language needs no
  // temporary file. It used to ignore `--json` completely and print the
  // program's raw output instead, which is the unpredictability that makes
  // people reach for bindings rather than shelling out.
  const r = JSON.parse(execFileSync(
    process.execPath,
    [CLI, 'eval', [
      'print("hi")',
      'attempt { read("x") } rescue e { print("caught") }',
      '42',
    ].join('\n'), '--json'],
    { encoding: 'utf8' },
  ));

  assert.equal(r.command, 'eval');
  assert.equal(r.ok, true);
  assert.deepEqual(r.stdout, ['hi', 'caught']);
  assert.equal(r.value, '42');
  assert.equal(r.refused.length, 1, 'a swallowed refusal is missing from eval');
  assert.equal(r.refused[0].capability, 'fs');
  assert.ok(r.manifest);

  // Every field `run` promises, `eval` promises too.
  for (const key of ['ok', 'command', 'file', 'outcome', 'stdout', 'failure',
    'replay', 'work', 'refused', 'manifest']) {
    assert.ok(key in r, `\`${key}\` is in run --json and missing from eval --json`);
  }
});

test('eval honours the flags it advertises', () => {
  // It used to accept only --seed and --grant, silently dropping the rest.
  const granted = JSON.parse(execFileSync(process.execPath,
    [CLI, 'eval', 'now()', '--json', '--grant', 'clock'], { encoding: 'utf8' }));
  assert.equal(granted.ok, true);
  assert.deepEqual(granted.replay.capabilities, ['clock']);

  const withPrincipal = JSON.parse(execFileSync(process.execPath,
    [CLI, 'eval', 'print(str(acting_for()))', '--json', '--principal', 'alice'],
    { encoding: 'utf8' }));
  assert.deepEqual(withPrincipal.replay.principals, ['alice']);
});
