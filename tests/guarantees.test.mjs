import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Interpreter } from '../src/interpreter.js';
import { SmarshError } from '../src/errors.js';
import { Decimal } from '../src/decimal.js';

// The four defects found in review, each pinned so it cannot come back.

function run(src, opts = {}) {
  const out = [];
  const interp = new Interpreter({ ...opts, out: (s) => out.push(s) });
  try {
    return { value: interp.run(src, '<t>'), out, interp };
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

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Smarsh-guard-'));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  }
  return dir;
}

// ---------------------------------------------------------------------------
// 1. a module may not borrow its importer's authority
// ---------------------------------------------------------------------------

test('a module cannot perform effects at import time', () => {
  const dir = project({
    'evil.smarsh': 'write("pwned.txt", "ran with the importer\'s capability")\nlet harmless = 1',
    'main.smarsh': 'import "./evil.smarsh" as m\nm["harmless"]',
  });
  const e = (() => {
    try {
      const interp = new Interpreter({ caps: ['fs'], cwd: dir, out: () => {} });
      interp.entryPath = path.join(dir, 'main.smarsh');
      interp.run(fs.readFileSync(path.join(dir, 'main.smarsh'), 'utf8'), 'main.smarsh');
      interp.devices.shutdown();
      return null;
    } catch (err) {
      return err;
    }
  })();
  assert.ok(e instanceof SmarshError, 'the import should have been refused');
  assert.equal(e.kind, 'CapabilityError');
  assert.equal(fs.existsSync(path.join(dir, 'pwned.txt')), false,
    'the module wrote a file using authority it was never granted');
});

test('a module still exports functions that work under the caller capabilities', () => {
  const dir = project({
    'lib.smarsh': 'fn save(text) needs fs { return write("out.txt", text) }\nlet version = 2',
    'main.smarsh': 'import "./lib.smarsh" as lib\n[lib.version, type(lib.save)]',
  });
  const interp = new Interpreter({ caps: ['fs'], cwd: dir, out: () => {} });
  interp.entryPath = path.join(dir, 'main.smarsh');
  try {
    const value = interp.run(fs.readFileSync(path.join(dir, 'main.smarsh'), 'utf8'), 'main.smarsh');
    assert.deepEqual(value, [2, 'fn']);
  } finally {
    interp.devices.shutdown();
  }
});

test('a module loads fine when it needs nothing', () => {
  const dir = project({
    'lib.smarsh': 'let answer = 42',
    'main.smarsh': 'import "./lib.smarsh" as lib\nlib.answer',
  });
  const interp = new Interpreter({ cwd: dir, out: () => {} });
  interp.entryPath = path.join(dir, 'main.smarsh');
  try {
    assert.equal(interp.run(fs.readFileSync(path.join(dir, 'main.smarsh'), 'utf8'), 'main.smarsh'), 42);
  } finally {
    interp.devices.shutdown();
  }
});

// ---------------------------------------------------------------------------
// 2. `let` means immutable, all the way down
// ---------------------------------------------------------------------------

test('a list bound with let cannot be mutated', () => {
  assert.equal(fails('let xs = [1, 2]\nxs.push(3)').kind, 'ImmutableError');
  assert.equal(fails('let xs = [1, 2]\nxs[0] = 9').kind, 'ImmutableError');
  assert.equal(fails('let xs = [1, 2]\nxs.pop()').kind, 'ImmutableError');
});

test('a map bound with let cannot be mutated', () => {
  assert.equal(fails('let m = { "a": 1 }\nm["a"] = 9').kind, 'ImmutableError');
  assert.equal(fails('let m = { "a": 1 }\nm.a = 9').kind, 'ImmutableError');
  assert.equal(fails('let m = { "a": 1 }\nm.set("b", 2)').kind, 'ImmutableError');
  assert.equal(fails('let m = { "a": 1 }\nm.remove("a")').kind, 'ImmutableError');
});

test('the freeze goes all the way down', () => {
  assert.equal(fails('let nested = [[1], [2]]\nnested[0].push(9)').kind, 'ImmutableError');
  assert.equal(fails('let deep = { "xs": [1] }\ndeep["xs"].push(2)').kind, 'ImmutableError');
  assert.equal(fails('let deep = [{ "a": 1 }]\ndeep[0]["a"] = 2').kind, 'ImmutableError');
});

test('var is still mutable, and reading a frozen value is fine', () => {
  assert.deepEqual(run('var xs = [1]\nxs.push(2)\nxs').value, [1, 2]);
  assert.deepEqual(run('let xs = [1, 2, 3]\n[xs.len(), xs[0], xs.map(fn(x) { return x * 2 })]').value,
    [3, 1, [2, 4, 6]]);
});

test('methods that return a new value still work on a frozen one', () => {
  assert.deepEqual(run('let xs = [3, 1, 2]\nxs.sort()').value, [1, 2, 3]);
  assert.deepEqual(run('let xs = [1, 2]\nxs.slice(0, 1)').value, [1]);
  assert.deepEqual(run('let xs = [1, 2]\nxs + [3]').value, [1, 2, 3]);
});

test('the error says what to do about it', () => {
  const e = fails('let xs = []\nxs.push(1)');
  assert.match(e.message, /bound with `let`, which freezes it/);
  assert.match(e.helps.join(' '), /`var`/);
});

// ---------------------------------------------------------------------------
// 3. exact arithmetic
// ---------------------------------------------------------------------------

test('decimals are exact where floats are not', () => {
  assert.equal(run('dec("0.1") + dec("0.2") == dec("0.3")').value, true);
  assert.equal(run('0.1 + 0.2 == 0.3').value, false, 'num is still a float, and still honest about it');
});

test('repeated addition does not drift', () => {
  const { value } = run(`
    var total = dec("0")
    for i in range(1000) { total = total + dec("0.01") }
    [total == dec("10"), total.text()]
  `);
  assert.deepEqual(value, [true, '10.00']);
});

test('money arithmetic keeps its scale', () => {
  assert.equal(run('(dec("12.50") * 3).text()').value, '37.50');
  assert.equal(run('(dec("19.99") - dec("0.99")).text()').value, '19.00');
  assert.equal(run('dec_sum([dec("19.99"), dec("5.01"), dec("0.10")]).text()').value, '25.10');
});

test('decimals carry unbounded integers exactly', () => {
  assert.equal(run('(dec("9007199254740993") + dec("1")).text()').value, '9007199254740994');
  assert.equal(run('(dec("123456789012345678901234567890") * 2).text()').value,
    '246913578024691357802469135780');
});

test('an integer literal too large for num is refused at parse time', () => {
  const e = fails('let n = 9007199254740993');
  assert.equal(e.kind, 'SyntaxError');
  assert.match(e.message, /too large for `num` to hold exactly/);
  assert.match(e.helps.join(' '), /dec\("9007199254740993"\)/);
});

test('mixing a float into exact arithmetic is refused', () => {
  const e = fails('dec("1.00") + 0.1');
  assert.equal(e.kind, 'TypeError');
  assert.match(e.message, /rounding error into exact arithmetic/);
  assert.match(e.helps.join(' '), /dec\("0.1"\)/);
});

test('a whole number is unambiguous, so it lifts', () => {
  assert.equal(run('(dec("1.50") * 2).text()').value, '3.00');
  assert.equal(run('(dec("10") - 3).text()').value, '7');
});

test('division states its scale and rounds half to even', () => {
  assert.equal(run('dec("10").div(dec("3"), 4).text()').value, '3.3333');
  assert.equal(run('dec("2.5").round(0).text()').value, '2');
  assert.equal(run('dec("3.5").round(0).text()').value, '4');
  assert.equal(run('dec("2.675").round(2).text()').value, '2.68');
  assert.equal(fails('dec("1").div(dec("0"), 2)').kind, 'ZeroDivisionError');
});

test('comparison is exact', () => {
  assert.equal(run('dec("1.10") == dec("1.1")').value, true, 'scale must not affect equality');
  assert.equal(run('dec("1.10") > dec("1.09")').value, true);
  assert.deepEqual(run('[dec("-0.5") < dec("0"), dec("0") == dec("-0")]').value, [true, true]);
});

test('converting to num refuses when it would lose precision', () => {
  assert.equal(run('dec("0.5").to_num()').value, 0.5);
  assert.equal(fails('dec("0.1234567890123456789").to_num()').kind, 'ValueError');
});

test('a malformed decimal is rejected', () => {
  assert.equal(fails('dec("twelve")').kind, 'ValueError');
  assert.equal(fails('dec("")').kind, 'ValueError');
});

test('the Decimal type behaves under direct use', () => {
  assert.equal(Decimal.parse('1.5').add(Decimal.parse('2.25')).toString(), '3.75');
  assert.equal(Decimal.parse('-1.5').abs().toString(), '1.5');
  assert.equal(Decimal.parse('1e3').toString(), '1000');
  assert.equal(Decimal.parse('1.5e-2').toString(), '0.015');
  assert.equal(Decimal.parse('0').sign, 0);
});

// ---------------------------------------------------------------------------
// 4. unaudited cryptography is quarantined
// ---------------------------------------------------------------------------

test('the hand-rolled primitives need their own capability', () => {
  for (const call of ['paillier_keygen_insecure(512)', 'zk_public(1)', 'commit(1, 2)']) {
    assert.equal(fails(call, { caps: ['crypto'] }).kind, 'CapabilityError',
      `${call} should not be reachable with only \`crypto\``);
  }
});

test('the platform-backed primitives do not need it', () => {
  const { value } = run(`
    let kp = keypair()
    let sig = sign(kp, "message")
    [verify_signature(kp.public, "message", sig), sha256("x").len()]
  `, { caps: ['crypto'] });
  assert.deepEqual(value, [true, 64]);
});

test('granting both still works end to end', () => {
  const { value } = run(`
    let k = paillier_keygen_insecure(512)
    decrypt(k, encrypt(k, 40) + encrypt(k, 2))
  `, { caps: ['crypto', 'unaudited_crypto'] });
  assert.equal(value, 42);
});
