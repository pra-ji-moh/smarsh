import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Interpreter } from '../src/interpreter.js';
import { PedagError } from '../src/errors.js';
import { ContextWindow, Ledger, countTokens } from '../src/values.js';
import { Tensor } from '../src/tensor.js';
import { proveSource } from '../src/prove.js';

function run(src, opts = {}) {
  const out = [];
  const interp = new Interpreter({ ...opts, out: (s) => out.push(s) });
  const value = interp.run(src, '<test>');
  return { value, out, interp };
}

function fails(src, opts = {}) {
  try {
    run(src, opts);
  } catch (e) {
    if (e instanceof PedagError) return e;
    throw e;
  }
  throw new Error('expected the program to fail, but it ran cleanly');
}

// ---------------------------------------------------------------------------
// core language
// ---------------------------------------------------------------------------

test('arithmetic respects precedence', () => {
  assert.equal(run('1 + 2 * 3').value, 7);
  assert.equal(run('(1 + 2) * 3').value, 9);
  assert.equal(run('2 ** 3 ** 2').value, 512);      // right associative
  assert.equal(run('-2 ** 2').value, -4);           // ** binds tighter than unary -
  assert.equal(run('7 % 3').value, 1);
  assert.equal(run('10 / 4').value, 2.5);
});

test('division by zero is an error, not Infinity', () => {
  assert.equal(fails('1 / 0').kind, 'ZeroDivisionError');
  assert.equal(fails('1 % 0').kind, 'ZeroDivisionError');
});

test('let cannot be reassigned, var can', () => {
  assert.equal(fails('let x = 1\nx = 2').kind, 'ImmutableError');
  assert.equal(run('var x = 1\nx = 2\nx').value, 2);
});

test('redeclaring in the same scope is an error', () => {
  assert.equal(fails('let x = 1\nlet x = 2').kind, 'NameError');
});

test('shadowing in an inner scope is allowed', () => {
  assert.equal(run('let x = 1\nif true { let x = 2 }\nx').value, 1);
});

test('closures capture their environment', () => {
  const { value } = run(`
    fn adder(n) { return fn(x) { return x + n } }
    let add5 = adder(5)
    add5(3)
  `);
  assert.equal(value, 8);
});

test('recursion works and is depth limited', () => {
  assert.equal(run('fn f(n) { if n < 2 { return n } return f(n-1) + f(n-2) }\nf(15)').value, 610);
  assert.equal(fails('fn f(n) { return f(n+1) }\nf(0)').kind, 'RecursionError');
});

test('loops, break and continue', () => {
  const { value } = run(`
    var total = 0
    for i in range(10) {
      if i == 3 { continue }
      if i == 7 { break }
      total = total + i
    }
    total
  `);
  assert.equal(value, 0 + 1 + 2 + 4 + 5 + 6);
});

test('slice takes one or two bounds, and counts back from the end', () => {
  assert.equal(run('"provenance".slice(-4)').value, 'ance');
  assert.equal(run('"provenance".slice(0, 4)').value, 'prov');
  assert.deepEqual(run('[1,2,3,4,5].slice(2)').value, [3, 4, 5]);
  assert.deepEqual(run('[1,2,3,4,5].slice(-2)').value, [4, 5]);
  assert.equal(fails('"abc".slice()').kind, 'ArityError');
});

test('strings, lists and maps carry methods', () => {
  assert.equal(run('"pedag".upper()').value, 'PEDAG');
  assert.deepEqual(run('[3,1,2].sort()').value, [1, 2, 3]);
  assert.equal(run('[1,2,3].reduce(fn(a,b){ return a + b }, 0)').value, 6);
  assert.equal(run('var m = {"a": 1}\nm["b"] = 2\nm.len()').value, 2);
  assert.equal(fails('let m = {"a": 1}\nm["zz"]').kind, 'KeyError');
});

test('arity mismatches are caught', () => {
  assert.equal(fails('fn f(a, b) { return a }\nf(1)').kind, 'ArityError');
});

test('syntax errors name the line', () => {
  const e = fails('let x = 1\nlet = 5');
  assert.equal(e.kind, 'SyntaxError');
  assert.equal(e.line, 2);
});

test('attempt/rescue catches a failure and exposes its kind', () => {
  const { out } = run(`
    attempt { 1 / 0 } rescue e { print(e["kind"]) }
  `);
  assert.deepEqual(out, ['ZeroDivisionError']);
});

test('attempt does not swallow return', () => {
  assert.equal(run('fn f() { attempt { return 42 } rescue e { return 0 } }\nf()').value, 42);
});

// ---------------------------------------------------------------------------
// tensors
// ---------------------------------------------------------------------------

test('tensor literals infer shape and reject ragged input', () => {
  assert.deepEqual(run('(tensor [[1,2,3],[4,5,6]]).shape').value, [2, 3]);
  assert.equal(fails('tensor [[1,2],[3]]').kind, 'ShapeError');
});

test('matmul handles rank-1 and rank-2 and reports bad shapes', () => {
  assert.deepEqual(run('(tensor [[1,2],[3,4]] @ tensor [1,1]).tolist()').value, [3, 7]);
  assert.equal(run('tensor [1,2,3] @ tensor [1,1,1]').value.rank, 0);
  const e = fails('tensor [[1,2,3]] @ tensor [[1,2,3]]');
  assert.equal(e.kind, 'ShapeError');
  assert.match(e.message, /inner sizes 3 and 1 differ/);
});

test('elementwise operators broadcast', () => {
  assert.deepEqual(run('(tensor [[1,2],[3,4]] * 2).tolist()').value, [[2, 4], [6, 8]]);
  assert.deepEqual(run('(tensor [[1,2],[3,4]] + tensor [10,20]).tolist()').value, [[11, 22], [13, 24]]);
  assert.equal(fails('tensor [1,2,3] + tensor [1,2]').kind, 'ShapeError');
});

test('tensors are immutable', () => {
  assert.equal(fails('let t = tensor [1,2,3]\nt[0] = 9').kind, 'ImmutableError');
});

test('softmax sums to one and argmax finds the peak', () => {
  const { value } = run('let s = softmax(tensor [1, 3, 2])\n[s.sum(), argmax(s)]');
  assert.ok(Math.abs(value[0] - 1) < 1e-12);
  assert.equal(value[1], 1);
});

// ---------------------------------------------------------------------------
// probabilistic control flow
// ---------------------------------------------------------------------------

test('the same seed replays the same branches', () => {
  const src = `
    var log = []
    for i in range(20) {
      maybe 0.5 { log.push("y") } else { log.push("n") }
    }
    log.join("")
  `;
  assert.equal(run(src, { seed: 3 }).value, run(src, { seed: 3 }).value);
});

test('different seeds take different branches', () => {
  const src = `
    var log = []
    for i in range(20) { maybe 0.5 { log.push("y") } else { log.push("n") } }
    log.join("")
  `;
  const seen = new Set([1, 2, 3, 4, 5].map((seed) => run(src, { seed }).value));
  assert.ok(seen.size > 1, 'expected at least two distinct branch traces across seeds');
});

test('maybe rejects a probability outside 0..1', () => {
  assert.equal(fails('maybe 1.5 { print("x") }').kind, 'ValueError');
});

test('choose picks one arm and only evaluates that arm', () => {
  const { out, value } = run(`
    choose {
      1 => "always",
      0 => print("never runs")
    }
  `);
  assert.equal(value, 'always');
  assert.deepEqual(out, []);
});

test('choose rejects all-zero weights', () => {
  assert.equal(fails('choose { 0 => 1, 0 => 2 }').kind, 'ValueError');
});

test('branch decisions are recorded in the trace', () => {
  const { interp } = run('maybe 0.5 { print("a") } else { print("b") }');
  assert.equal(interp.trace.branches.length, 1);
  assert.equal(interp.trace.branches[0].kind, 'maybe');
  assert.equal(interp.trace.branches[0].line, 1);
});

// ---------------------------------------------------------------------------
// fork
// ---------------------------------------------------------------------------

test('fork returns one result per path and binds the path index', () => {
  assert.deepEqual(run('fork 4 { _ }').value, [0, 1, 2, 3]);
});

test('forked paths get independent random streams', () => {
  const { value } = run('fork 4 { random() }');
  assert.equal(new Set(value).size, 4, 'each path should draw differently');
});

test('fork is reproducible and does not disturb the outer stream', () => {
  const src = 'let a = fork 3 { random() }\nlet b = random()\n[a, b]';
  assert.deepEqual(run(src, { seed: 9 }).value, run(src, { seed: 9 }).value);
  assert.equal(run('random()', { seed: 9 }).value, run('fork 2 { random() }\nrandom()', { seed: 9 }).value);
});

test('path scope does not leak', () => {
  assert.equal(fails('fork 2 { let inner = 1 }\ninner').kind, 'NameError');
});

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

test('an effect without the capability is refused', () => {
  const e = fails('fn f() { return write("x.txt", "hi") }\nf()');
  assert.equal(e.kind, 'CapabilityError');
  assert.match(e.message, /needs the 'fs' capability/);
});

test('a granted capability reaches a function that declares it', () => {
  assert.deepEqual(run('fn f() needs fs { return caps() }\nf()', { caps: ['fs'] }).value, ['fs']);
});

test('capabilities attenuate: a callee cannot use what it did not declare', () => {
  const e = fails(`
    fn inner() needs clock { return now() }
    fn outer() needs fs { return inner() }
    outer()
  `, { caps: ['fs', 'clock'] });
  assert.equal(e.kind, 'CapabilityError');
  assert.match(e.message, /this frame holds fs/);
});

test('the top level holds only what was granted', () => {
  assert.deepEqual(run('caps()', { caps: ['fs', 'clock'] }).value, ['clock', 'fs']);
  assert.deepEqual(run('caps()').value, []);
});

// ---------------------------------------------------------------------------
// provenance
// ---------------------------------------------------------------------------

test('labels attach and survive arithmetic', () => {
  assert.deepEqual(run('labels(ungrounded(1))').value, ['ungrounded']);
  assert.deepEqual(run('labels(ungrounded(1) + 1)').value, ['ungrounded']);
  assert.deepEqual(run('labels(untrusted("a") + "b")').value, ['untrusted']);
});

test('labels survive method calls', () => {
  assert.deepEqual(run('labels(untrusted("abc").upper())').value, ['untrusted']);
});

test('labels merge from both operands', () => {
  const { value } = run('labels(ungrounded(1) + untrusted(2))');
  assert.deepEqual([...value].sort(), ['ungrounded', 'untrusted']);
});

test('a grounded block refuses ungrounded and untrusted values', () => {
  assert.equal(fails('let r = ungrounded("x")\ngrounded { print(r) }').kind, 'TaintError');
  assert.equal(fails('let r = untrusted("x")\ngrounded { print(r) }').kind, 'TaintError');
});

test('a grounded block accepts clean values', () => {
  assert.deepEqual(run('grounded { print("fine") }').out, ['fine']);
});

test('trust launders a value, demands a reason, and is logged', () => {
  const { interp } = run(`
    let r = ungrounded("x")
    let ok = trust(r, "verified against the filing")
    grounded { print(ok) }
  `);
  assert.equal(interp.trace.laundered.length, 1);
  assert.deepEqual(interp.trace.laundered[0].cleared, ['ungrounded']);
  assert.equal(interp.trace.laundered[0].reason, 'verified against the filing');
  assert.equal(fails('trust(ungrounded(1), "")').kind, 'ValueError');
});

test('region tags block cross-jurisdiction reads', () => {
  const e = fails('let r = restrict("x", "eu")\nregion "us" { print(r) }');
  assert.equal(e.kind, 'TaintError');
  assert.match(e.message, /restricted to 'eu'.*region 'us'/);
  assert.deepEqual(run('let r = restrict("x", "eu")\nregion "eu" { print("ok") }').out, ['ok']);
});

test('regions nest and restore', () => {
  const { out } = run(`
    let eu = restrict("a", "eu")
    region "eu" {
      region "eu" { print("inner") }
      print("outer")
    }
    print(eu)
  `);
  assert.equal(out.length, 3);
});

// ---------------------------------------------------------------------------
// contracts
// ---------------------------------------------------------------------------

test('a precondition rejects a bad call', () => {
  const e = fails('fn f(n) requires n > 0 { return n }\nf(0)');
  assert.equal(e.kind, 'ContractError');
  assert.match(e.message, /requires n > 0/);
});

test('a postcondition catches a wrong result', () => {
  const e = fails('fn f(n) ensures result > n { return n - 1 }\nf(5)');
  assert.equal(e.kind, 'ContractError');
  assert.match(e.message, /promised result > n, but returned 4/);
});

test('contracts that hold do not interfere', () => {
  assert.equal(run('fn f(n) requires n > 0 ensures result > n { return n + 1 }\nf(5)').value, 6);
});

// ---------------------------------------------------------------------------
// context windows and token accounting
// ---------------------------------------------------------------------------

test('token counting is deterministic and roughly proportional', () => {
  assert.equal(countTokens(''), 0);
  assert.equal(countTokens('hello'), countTokens('hello'));
  assert.ok(countTokens('hello world this is a longer sentence') > countTokens('hello'));
});

test('a context window evicts to stay inside its budget', () => {
  const c = new ContextWindow(20);
  for (let i = 0; i < 20; i++) c.push(`entry number ${i} with some words in it`);
  assert.ok(c.tokens <= 20, `expected <= 20 tokens, got ${c.tokens}`);
  assert.ok(c.evicted > 0);
});

test('pinned entries are never evicted', () => {
  const c = new ContextWindow(15);
  c.push('system instructions that must not be dropped', true);
  for (let i = 0; i < 10; i++) c.push(`chatter ${i}`);
  assert.ok(c.text().includes('system instructions'));
});

test('a context refuses a non-positive budget and unknown policies', () => {
  assert.equal(fails('context(0)').kind, 'ValueError');
  assert.equal(fails('context(10, "lru")').kind, 'ValueError');
});

test('the language exposes token counts', () => {
  assert.equal(run('tokens("hello world")').value, countTokens('hello world'));
  assert.equal(run('let c = context(100)\nc.push("hello world")\nc.tokens').value, countTokens('hello world'));
});

// ---------------------------------------------------------------------------
// ledger
// ---------------------------------------------------------------------------

test('a ledger verifies its own chain', () => {
  const l = new Ledger('t');
  l.append('a');
  l.append('b');
  l.append('c');
  assert.equal(l.length, 3);
  assert.ok(l.verify());
});

test('tampering with a ledger entry breaks verification', () => {
  const l = new Ledger('t');
  l.append('a');
  l.append('b');
  l.entries[0].payload = 'not a';
  assert.equal(l.verify(), false);
});

test('ledgers are reachable from the language', () => {
  assert.equal(run('let b = ledger("x")\nb.append("one")\nb.verify()').value, true);
});

// ---------------------------------------------------------------------------
// prove
// ---------------------------------------------------------------------------

test('prove finds a genuine postcondition violation', () => {
  const reports = proveSource(`
    fn scale(x, k) requires k > 0 ensures result >= x { return x * k }
  `, { trials: 100 });
  const scale = reports.find((r) => r.name === 'scale');
  assert.ok(scale.violations.length > 0, 'expected a counterexample for scale');
  assert.match(scale.violations[0].message, /promised result >= x/);
});

test('prove leaves a correct function alone', () => {
  const reports = proveSource(`
    fn abs_(x) ensures result >= 0 { if x < 0 { return -x } return x }
  `, { trials: 100 });
  const r = reports.find((x) => x.name === 'abs_');
  assert.equal(r.violations.length + r.crashes.length, 0);
  assert.ok(r.accepted > 0);
});

test('prove skips effectful functions instead of calling them', () => {
  const reports = proveSource(`
    fn persist(x) needs fs requires x != nil { write("out.txt", str(x)) return true }
  `, { trials: 10 });
  assert.match(reports.find((r) => r.name === 'persist').skipped, /needs fs/);
});

test('prove is reproducible for a given seed', () => {
  const src = 'fn scale(x, k) requires k > 0 ensures result >= x { return x * k }';
  const a = proveSource(src, { trials: 50, seed: 4 });
  const b = proveSource(src, { trials: 50, seed: 4 });
  assert.deepEqual(a[0].violations, b[0].violations);
});

// ---------------------------------------------------------------------------
// tensor unit checks
// ---------------------------------------------------------------------------

test('broadcasting rules match the usual convention', () => {
  assert.deepEqual(Tensor.broadcastShape([2, 3], [3]), [2, 3]);
  assert.deepEqual(Tensor.broadcastShape([2, 1], [1, 3]), [2, 3]);
  assert.throws(() => Tensor.broadcastShape([2, 3], [4]), /cannot broadcast/);
});

test('transpose round-trips', () => {
  const t = Tensor.fromNested([[1, 2, 3], [4, 5, 6]]);
  assert.deepEqual(t.transpose().transpose().toNested(), t.toNested());
  assert.deepEqual(t.transpose().shape, [3, 2]);
});
