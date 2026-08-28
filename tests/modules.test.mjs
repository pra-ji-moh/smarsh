import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { Interpreter } from '../src/interpreter.js';
import { SmarshError } from '../src/errors.js';
import { Schema, negotiate, adapt } from '../src/schema.js';
import { buildBundle } from '../src/bundle.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Smarsh-mod-'));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  }
  return dir;
}

function runIn(dir, entry, opts = {}) {
  const out = [];
  const interp = new Interpreter({ ...opts, cwd: dir, out: (s) => out.push(s) });
  try {
    const value = interp.run(fs.readFileSync(path.join(dir, entry), 'utf8'), entry);
    return { value, out, interp };
  } finally {
    interp.devices.shutdown();
  }
}

function failsIn(dir, entry, opts = {}) {
  try {
    runIn(dir, entry, opts);
  } catch (e) {
    if (e instanceof SmarshError) return e;
    throw e;
  }
  throw new Error('expected the program to fail, but it ran cleanly');
}

function run(src, opts = {}) {
  const out = [];
  const interp = new Interpreter({ ...opts, out: (s) => out.push(s) });
  try {
    return { value: interp.run(src, '<test>'), out, interp };
  } finally {
    interp.devices.shutdown();
  }
}

function fails(src, opts = {}) {
  try {
    run(src, opts);
  } catch (e) {
    if (e instanceof SmarshError) return e;
    throw e;
  }
  throw new Error('expected the program to fail, but it ran cleanly');
}

// ---------------------------------------------------------------------------
// modules
// ---------------------------------------------------------------------------

test('an import brings a module top level into scope', () => {
  const dir = project({
    'lib.smarsh': 'let rate = 3\nfn triple(x) { return x * rate }',
    'main.smarsh': 'import "./lib.smarsh"\n[triple(5), rate]',
  });
  assert.deepEqual(runIn(dir, 'main.smarsh').value, [15, 3]);
});

test('an aliased import keeps the names together', () => {
  const dir = project({
    'lib.smarsh': 'fn double(x) { return x * 2 }\nlet unit = "m"',
    'main.smarsh': 'import "./lib.smarsh" as lib\n[lib["double"](4), lib["unit"]]',
  });
  assert.deepEqual(runIn(dir, 'main.smarsh').value, [8, 'm']);
});

test('a module cannot see the program that imported it', () => {
  const dir = project({
    'lib.smarsh': 'fn peek() { return secret_value }',
    'main.smarsh': 'let secret_value = 42\nimport "./lib.smarsh"\npeek()',
  });
  assert.equal(failsIn(dir, 'main.smarsh').kind, 'NameError');
});

test('a name collision on import is refused, not silently resolved', () => {
  const dir = project({
    'lib.smarsh': 'fn helper() { return 1 }',
    'main.smarsh': 'fn helper() { return 2 }\nimport "./lib.smarsh"',
  });
  const e = failsIn(dir, 'main.smarsh');
  assert.equal(e.kind, 'ImportError');
  assert.match(e.message, /already declared here/);
});

test('a module runs once even when imported twice', () => {
  const dir = project({
    'lib.smarsh': 'print("side effect")\nlet n = 1',
    'a.smarsh': 'import "./lib.smarsh" as x',
    'main.smarsh': 'import "./a.smarsh" as a\nimport "./lib.smarsh" as b\nb["n"]',
  });
  const { value, out } = runIn(dir, 'main.smarsh');
  assert.equal(value, 1);
  assert.deepEqual(out, ['side effect'], 'the module body should run exactly once');
});

test('identical content at two paths is one module, addressed by hash', () => {
  const body = 'let marker = 7';
  const dir = project({
    'one.smarsh': body,
    'vendor/two.smarsh': body,
    'main.smarsh': 'import "./one.smarsh" as a\nimport "./vendor/two.smarsh" as b\n[a["marker"], b["marker"]]',
  });
  const { value, interp } = runIn(dir, 'main.smarsh');
  assert.deepEqual(value, [7, 7]);
  assert.equal(interp.moduleCache.size, 1, 'the same bytes must not become two modules');
  const paths = [...interp.modulePaths.values()][0];
  assert.equal(paths.length, 2, 'both paths should be recorded against the one hash');
});

test('a different byte is a different module', () => {
  const dir = project({
    'one.smarsh': 'let marker = 7',
    'two.smarsh': 'let marker = 8',
    'main.smarsh': 'import "./one.smarsh" as a\nimport "./two.smarsh" as b\n[a["marker"], b["marker"]]',
  });
  const { value, interp } = runIn(dir, 'main.smarsh');
  assert.deepEqual(value, [7, 8]);
  assert.equal(interp.moduleCache.size, 2);
});

test('an import cycle is refused', () => {
  const dir = project({
    'a.smarsh': 'import "./b.smarsh"\nlet fromA = 1',
    'b.smarsh': 'import "./a.smarsh"\nlet fromB = 2',
    'main.smarsh': 'import "./a.smarsh"',
  });
  const e = failsIn(dir, 'main.smarsh');
  assert.equal(e.kind, 'ImportError');
  assert.match(e.message, /cannot form a cycle/);
});

test('an import cannot escape the program directory', () => {
  const dir = project({ 'main.smarsh': 'import "../outside.smarsh"' });
  const e = failsIn(dir, 'main.smarsh');
  assert.equal(e.kind, 'ImportError');
  assert.match(e.message, /outside/);
});

test('a missing module says so', () => {
  const dir = project({ 'main.smarsh': 'import "./nope.smarsh"' });
  assert.equal(failsIn(dir, 'main.smarsh').kind, 'ImportError');
});

// ---------------------------------------------------------------------------
// schemas
// ---------------------------------------------------------------------------

const S = (name, fields) => new Schema(name, new Map(Object.entries(fields)));

test('a schema checks the shape of a value', () => {
  const { value } = run(`
    let order = schema("Order", { "id": "num", "side": "str" })
    [order.matches({ "id": 1, "side": "buy" }),
     order.matches({ "id": "one", "side": "buy" }),
     order.matches({ "id": 1 })]
  `);
  assert.deepEqual(value, [true, false, false]);
});

test('complaints say what is actually wrong', () => {
  const { value } = run(`
    let order = schema("Order", { "id": "num", "side": "str" })
    order.complaints({ "id": "one" })
  `);
  assert.equal(value.length, 2);
  assert.match(value.join(' '), /should be num/);
  assert.match(value.join(' '), /missing required field 'side'/);
});

test('an added optional field stays compatible', () => {
  const from = S('v1', { id: { kind: 'num', required: true } });
  const to = S('v2', {
    id: { kind: 'num', required: true },
    note: { kind: 'str', required: false },
  });
  const r = negotiate(from, to);
  assert.equal(r.compatible, true);
  assert.deepEqual(r.added, ['note']);
});

test('an added required field is a blocking change and says why', () => {
  const from = S('v1', { id: { kind: 'num', required: true } });
  const to = S('v2', {
    id: { kind: 'num', required: true },
    account: { kind: 'str', required: true },
  });
  const r = negotiate(from, to);
  assert.equal(r.compatible, false);
  assert.match(r.blocking[0], /'account' is required by v2 and v1 does not send it/);
});

test('a removed field is reported as dropped, not as a failure', () => {
  const from = S('v1', {
    id: { kind: 'num', required: true },
    legacy: { kind: 'str', required: true },
  });
  const to = S('v2', { id: { kind: 'num', required: true } });
  const r = negotiate(from, to);
  assert.equal(r.compatible, true);
  assert.deepEqual(r.dropped, ['legacy']);
});

test('a coercible retype is allowed and an impossible one is not', () => {
  const numId = S('a', { id: { kind: 'num', required: true } });
  const strId = S('b', { id: { kind: 'str', required: true } });
  const listId = S('c', { id: { kind: 'list', required: true } });
  assert.equal(negotiate(numId, strId).compatible, true);
  assert.equal(negotiate(numId, listId).compatible, false);
});

test('adapt fills defaults, drops extras and coerces', () => {
  const from = S('v1', {
    id: { kind: 'num', required: true },
    legacy: { kind: 'str', required: true },
  });
  const to = S('v2', {
    id: { kind: 'str', required: true },
    note: { kind: 'str', required: false, fallback: 'none' },
  });
  const out = adapt(new Map([['id', 7], ['legacy', 'x']]), from, to);
  assert.equal(out.get('id'), '7');
  assert.equal(out.get('note'), 'none');
  assert.equal(out.has('legacy'), false);
});

test('adapt refuses a conversion negotiate would have blocked', () => {
  const from = S('v1', { id: { kind: 'num', required: true } });
  const to = S('v2', {
    id: { kind: 'num', required: true },
    account: { kind: 'str', required: true },
  });
  assert.throws(() => adapt(new Map([['id', 1]]), from, to), /cannot read v1 as v2/);
});

test('live records are re-typed in place, and the pause is measured', () => {
  const { value } = run(`
    let v1 = schema("v1", { "id": "num", "old": "str" })
    let v2 = schema("v2", { "id": "str", "note": "str=none" })
    let rows = [{ "id": 1, "old": "a" }, { "id": 2, "old": "b" }]
    let done = migrate(rows, v1, v2)
    [done["count"], done["records"][0]["id"], done["records"][1]["note"], done["nanos"] >= 0]
  `);
  assert.deepEqual(value, [2, '1', 'none', true]);
});

test('an unknown field kind is refused when the schema is built', () => {
  const e = fails('schema("x", { "a": "integer" })');
  assert.equal(e.kind, 'SchemaError');
  assert.match(e.message, /unknown kind 'integer'/);
});

// ---------------------------------------------------------------------------
// simulation
// ---------------------------------------------------------------------------

test('events fire in time order regardless of when they were scheduled', () => {
  const { out } = run(`
    schedule(10, fn() { print("macro: close") })
    schedule(0.001, fn() { print("micro: fill") })
    schedule(0, fn() { print("macro: open") })
    simulate(100)
  `);
  assert.deepEqual(out, ['macro: open', 'micro: fill', 'macro: close']);
});

test('logical time advances to each event', () => {
  const { out } = run(`
    schedule(5, fn() { print(time()) })
    schedule(12, fn() { print(time()) })
    simulate(100)
  `);
  assert.deepEqual(out, ['5', '12']);
});

test('an event may schedule further events', () => {
  const { value, out } = run(`
    fn tick() {
      print(time())
      if time() < 3 { schedule(1, tick) }
    }
    schedule(1, tick)
    simulate(100)
  `);
  assert.deepEqual(out, ['1', '2', '3']);
  assert.equal(value, 3);
});

test('simulate stops at the horizon and leaves later events queued', () => {
  const { value } = run(`
    schedule(1, fn() { })
    schedule(50, fn() { })
    let fired = simulate(10)
    [fired, scheduled(), time()]
  `);
  assert.deepEqual(value, [1, 1, 10]);
});

test('the same simulation replays identically', () => {
  const src = `
    var log = []
    for i in range(5) { schedule(random() * 10, fn() { log.push(time()) }) }
    simulate(20)
    log
  `;
  assert.deepEqual(run(src, { seed: 3 }).value, run(src, { seed: 3 }).value);
});

test('scheduling into the past is refused', () => {
  assert.equal(fails('schedule(-1, fn() { })').kind, 'ValueError');
});

// ---------------------------------------------------------------------------
// cost model
// ---------------------------------------------------------------------------

test('the cost model counts real work and labels its units honestly', () => {
  const { value } = run(`
    fn work(n) { var t = 0  for i in range(n) { t = t + i }  return t }
    work(50)
    let e = energy()
    [e["calls"] >= 1, e["score"] > 0, e["units"].contains("not watts")]
  `);
  assert.deepEqual(value, [true, true, true]);
});

test('more work scores higher', () => {
  const score = (n) => run(`
    fn work(k) { var t = 0  for i in range(k) { t = t + i }  return t }
    work(${n})
    energy()["score"]
  `).value;
  assert.ok(score(200) > score(20));
});

test('tensor work is counted by element operations', () => {
  const { value } = run(`
    let a = zeros([20, 20])
    a @ a
    energy()["tensorOps"]
  `);
  assert.equal(value, 8000);
});

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

test('a bundle is self-contained and produces the same output', { timeout: 120000 }, () => {
  const program = `
    fn fib(n) requires n >= 0 { if n < 2 { return n } return fib(n-1) + fib(n-2) }
    print("fib", fib(10))
    print("tensor", (tensor [[1,2],[3,4]] @ tensor [1,1]).tolist())
    maybe 0.5 { print("took it") } else { print("skipped it") }
  `;
  const bundle = buildBundle(program, 'test.smarsh', { seed: 1 });
  assert.ok(!/^\s*import\s+.*from\s+['"]\./m.test(bundle), 'no relative imports may survive');
  assert.ok(!/^\s*export\s/m.test(bundle), 'no export statements may survive');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Smarsh-bundle-'));
  const file = path.join(dir, 'app.mjs');
  fs.writeFileSync(file, bundle, 'utf8');
  const fromBundle = execFileSync(process.execPath, [file], { encoding: 'utf8' });

  const direct = [];
  const interp = new Interpreter({ seed: 1, out: (s) => direct.push(s) });
  interp.run(program, 'test.smarsh');
  interp.devices.shutdown();

  assert.deepEqual(fromBundle.trim().split(/\r?\n/), direct);
});

test('a bundle reports a failing program the same way', { timeout: 120000 }, () => {
  const bundle = buildBundle('fn f(n) requires n > 0 { return n }\nf(0)', 'bad.smarsh', { seed: 0 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Smarsh-bundle-'));
  const file = path.join(dir, 'bad.mjs');
  fs.writeFileSync(file, bundle, 'utf8');
  try {
    execFileSync(process.execPath, [file], { encoding: 'utf8', stdio: 'pipe' });
    assert.fail('the bundle should have exited non-zero');
  } catch (e) {
    assert.match(e.stderr, /ContractError/);
  }
});
