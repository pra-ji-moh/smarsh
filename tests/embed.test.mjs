import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { run, check, Sandbox, PROMPT, verifyManifest } from '../src/index.js';
import { generateKeypair } from '../src/crypto.js';

// Smarsh, embedded.
//
// The CLI is for people. This is the surface for programs, and for the shape the
// language is actually for: a model emits code, something runs it under bounds
// it cannot exceed, and a person reads the receipt. Nobody in that loop learns
// the language.
//
// So the tests are about the properties a caller depends on rather than about
// the language: that a program's own failure is a value and not an exception,
// that the bounds live with the embedder rather than in the code, and that what
// the code *tried* survives to the caller.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// the basic contract
// ---------------------------------------------------------------------------

test('a working program returns its output and its value', () => {
  const r = run('print("hello")\nlet x = 40 + 2\nx');
  assert.equal(r.ok, true);
  assert.deepEqual(r.output, ['hello']);
  assert.equal(r.value, '42');
  assert.equal(r.error, null);
  assert.ok(r.steps > 0);
});

test('a program that fails is a value, not an exception', () => {
  // A model producing broken code is the ordinary case. Making the caller wrap
  // every call in try/catch to handle the ordinary case is a bad API.
  let r;
  assert.doesNotThrow(() => { r = run('let x = nope'); });
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'NameError');
  assert.equal(r.error.line, 1);
  assert.match(r.error.rendered, /not defined/);
});

test('output produced before a failure still comes back', () => {
  // Half a run is still evidence of what happened.
  const r = run('print("first")\nprint("second")\nlet x = nope');
  assert.deepEqual(r.output, ['first', 'second']);
  assert.equal(r.ok, false);
});

test('bad options are the caller\'s bug, and do throw', () => {
  assert.throws(() => run(42), TypeError);
  assert.throws(() => run(null), TypeError);
});

// ---------------------------------------------------------------------------
// the bounds live with the embedder
// ---------------------------------------------------------------------------

test('code cannot grant itself authority the embedder withheld', () => {
  const r = run('read("secret.txt")');
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'CapabilityError');
});

test('a granted capability works, and an ungranted one does not', () => {
  assert.equal(run('now()', { grant: ['clock'] }).ok, true);
  assert.equal(run('now()').ok, false);
});

test('a sandbox applies the same bounds to everything through it', () => {
  const box = new Sandbox({ grant: ['clock'] });
  assert.equal(box.run('now()').ok, true);
  assert.equal(box.run('read("x")').ok, false);
  // And a per-call option can widen it for one call without changing the box.
  assert.equal(box.run('now()', { grant: [] }).ok, false);
  assert.equal(box.run('now()').ok, true, 'the sandbox was mutated by one call');
});

test('the step ceiling stops a program that will not', () => {
  // Without one, generated code can hang the host process, which is not an
  // acceptable default for something whose job is running code it did not write.
  const started = Date.now();
  const r = run('var i = 0\nwhile true { i = i + 1 }', { steps: 50_000 });
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'StepLimitError');
  assert.ok(Date.now() - started < 10_000, 'the ceiling did not fire promptly');
});

test('the network is closed unless a host is named', () => {
  assert.equal(run('http_get("https://example.com")', { grant: ['net'] }).ok, false);
});

// ---------------------------------------------------------------------------
// what it tried: the reason this is not just a sandbox
// ---------------------------------------------------------------------------

test('a refusal reaches the caller as data, not just as a failure', () => {
  // A sandbox says a program failed. This says it tried to reach the network at
  // line 2 and was stopped, which is the difference between "something went
  // wrong" and evidence.
  const r = run('print("working")\nhttp_get("https://analytics.example.com/t")', { grant: [] });
  assert.equal(r.ok, false);
  assert.equal(r.refused.length, 1);
  const [refusal] = r.refused;
  assert.equal(refusal.kind, 'capability');
  assert.equal(refusal.capability, 'net');
  assert.equal(refusal.detail, 'http_get');
  assert.equal(refusal.line, 2);
});

test('a refusal the program caught is still reported', () => {
  // This is the case that matters most: code that swallows its own refusal
  // looks like it behaved. The record does not agree.
  const r = run([
    'attempt { read("secret.txt") } rescue e { print("all fine here") }',
  ].join('\n'), { grant: [] });
  assert.equal(r.ok, true, 'the program handled it and completed');
  assert.deepEqual(r.output, ['all fine here']);
  assert.equal(r.refused.length, 1, 'a swallowed refusal vanished from the record');
  assert.equal(r.refused[0].capability, 'fs');
});

test('a label refusal is reported apart from a capability refusal', () => {
  const r = run([
    'let v = classify("secret", "alice", ["alice"])',
    'attempt { release_to "bob" { print(str(v)) } } rescue e { print("caught") }',
  ].join('\n'));
  const kinds = r.refused.map((x) => x.kind);
  assert.ok(kinds.includes('confidentiality'), `kinds were ${kinds.join(', ')}`);
});

test('a clean run refuses nothing', () => {
  assert.deepEqual(run('print(1)').refused, []);
});

// ---------------------------------------------------------------------------
// checking without running
// ---------------------------------------------------------------------------

test('check reports problems and executes nothing', () => {
  const r = check('print("this must not run")\nlet x = nope');
  assert.equal(r.ok, false);
  assert.ok(r.diagnostics.length > 0);
  assert.equal(r.diagnostics[0].code, 'E0201');
  // A diagnostic carries what a model needs to repair from.
  assert.ok(r.diagnostics[0].line > 0);
  assert.ok('message' in r.diagnostics[0]);
});

test('check accepts a program that is fine', () => {
  assert.equal(check('let x = 1\nprint(x)').ok, true);
});

test('a syntax error is a diagnostic, not a crash', () => {
  const r = check('fn f( {');
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics[0].code, 'E0101');
});

test('checkThenRun does not execute code that fails the check', () => {
  const box = new Sandbox({});
  const r = box.checkThenRun('print("must not appear")\nlet xs = []\nxs.push(1)');
  assert.equal(r.ranAtAll, false);
  assert.deepEqual(r.output, [], 'it ran anyway');
  assert.equal(r.error.kind, 'CheckFailed');
  assert.ok(r.diagnostics.length > 0);
});

test('checkThenRun runs what passes', () => {
  const r = new Sandbox({}).checkThenRun('print("fine")');
  assert.equal(r.ranAtAll, true);
  assert.deepEqual(r.output, ['fine']);
});

// ---------------------------------------------------------------------------
// the receipt
// ---------------------------------------------------------------------------

test('every run produces a manifest, including a failed one', () => {
  for (const source of ['print(1)', 'let x = nope']) {
    const r = run(source);
    assert.ok(r.manifest, `no manifest for: ${source}`);
    assert.ok(r.receipt.length > 0);
  }
  assert.equal(run('print(1)').manifest.outcome, 'completed');
  assert.equal(run('let x = nope').manifest.outcome, 'failed');
});

test('the manifest names the real runtime version', () => {
  // A manifest naming the wrong runtime cannot be replayed. This said 0.0.0
  // when embedded, because the version was a default parameter the CLI supplied
  // and this did not.
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const r = run('print(1)');
  assert.match(r.receipt, new RegExp(`smarsh ${version.replace(/\./g, '\\.')}`));
  assert.notEqual(version, '0.0.0');
});

test('signing actually signs', () => {
  // `buildManifest` takes `signWith`. Passing `key` instead made `sign` produce
  // a silently unsigned manifest, which is the exact failure this project
  // exists to prevent: a claim that is not enforced.
  const keypair = generateKeypair();
  const signed = run('print(1)', { sign: keypair });
  assert.ok(signed.manifest.signature, 'sign produced an unsigned manifest');
  assert.equal(verifyManifest(signed.manifest).ok, true);

  const unsigned = run('print(1)');
  assert.ok(!unsigned.manifest.signature, 'it signed without being asked to');
});

test('the manifest is intact, and detects being edited', () => {
  const r = run('print(1)\nprint(2)');
  assert.equal(verifyManifest(r.manifest).ok, true);
  const tampered = JSON.parse(JSON.stringify(r.manifest));
  if (tampered.events.length > 0) {
    tampered.events[0].event = 'something.else';
    assert.equal(verifyManifest(tampered).ok, false);
  }
});

// ---------------------------------------------------------------------------
// determinism, which is what makes a receipt worth anything
// ---------------------------------------------------------------------------

test('the same code and seed give the same answer', () => {
  const source = 'var t = 0\nfor i in range(20) { t = t + randint(1, 100) }\nt';
  const a = run(source, { seed: 7 });
  const b = run(source, { seed: 7 });
  assert.equal(a.value, b.value);
  assert.equal(a.manifest.program.sha256, b.manifest.program.sha256);
});

test('a different seed gives a different answer', () => {
  const source = 'var t = 0\nfor i in range(20) { t = t + randint(1, 100) }\nt';
  assert.notEqual(run(source, { seed: 1 }).value, run(source, { seed: 2 }).value);
});

test('both engines give the same answer through this API', () => {
  const source = 'fn f(n) { if n < 2 { return n } return f(n-1) + f(n-2) }\nf(12)';
  assert.equal(run(source, { engine: 'fast' }).value, run(source, { engine: 'tree' }).value);
});

// ---------------------------------------------------------------------------
// the prompt
// ---------------------------------------------------------------------------

test('the reference is importable, and is the shipped one', () => {
  // An embedder should not have to find docs/for-llms.md on disk or vendor a
  // copy that goes stale.
  assert.equal(typeof PROMPT, 'string');
  assert.ok(PROMPT.length > 5000, `the page is only ${PROMPT.length} characters`);
  const onDisk = fs.readFileSync(path.join(ROOT, 'docs', 'for-llms.md'), 'utf8');
  assert.equal(PROMPT, onDisk, 'the importable page has drifted from the documented one');
});

test('it behaves as a string, because that is what it is', () => {
  // An earlier version returned a proxy pretending to be one, which breaks on
  // concatenation and on `typeof` -- both of which an embedder does immediately.
  assert.equal(typeof PROMPT, 'string');
  assert.ok(`${PROMPT}`.includes('Smarsh'));
  assert.ok((`prefix ${PROMPT}`).startsWith('prefix '));
});

// ---------------------------------------------------------------------------
// the package can actually be imported
// ---------------------------------------------------------------------------

test('package.json points at this module', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.main, './src/index.js');
  assert.equal(pkg.exports['.'], './src/index.js');
  assert.ok(fs.existsSync(path.join(ROOT, pkg.main)));
  // And the files list must ship what the entry point needs at run time.
  assert.ok(pkg.files.includes('src/'));
  assert.ok(pkg.files.includes('docs/'), 'PROMPT reads from docs/, which is not shipped');
});
