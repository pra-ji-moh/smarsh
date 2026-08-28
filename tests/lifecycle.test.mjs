import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Interpreter } from '../src/interpreter.js';
import { SmarshError } from '../src/errors.js';
import { buildCallGraph } from '../src/graph.js';
import { parse } from '../src/parser.js';
import { snapshot, restore } from '../src/snapshot.js';

function run(src, opts = {}) {
  const out = [];
  const interp = new Interpreter({ ...opts, out: (s) => out.push(s) });
  try {
    const value = interp.run(src, '<test>');
    return { value, out, interp };
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
// redefinition
// ---------------------------------------------------------------------------

test('a function can be replaced while the program runs', () => {
  const { value } = run(`
    fn score(x) { return x * 2 }
    let before = score(10)
    redefine fn score(x) { return x * 3 }
    [before, score(10)]
  `);
  assert.deepEqual(value, [20, 30]);
});

test('callers see the new version without being touched', () => {
  const { value } = run(`
    fn base(x) { return x * 2 }
    fn wrapper(x) { return base(x) + 1 }
    let before = wrapper(10)
    redefine fn base(x) { return x * 10 }
    [before, wrapper(10)]
  `);
  assert.deepEqual(value, [21, 101]);
});

test('a replacement may not change the shape of the function', () => {
  const e = fails(`
    fn f(a, b) { return a + b }
    redefine fn f(a) { return a }
  `);
  assert.equal(e.kind, 'RedefineError');
  assert.match(e.message, /would break every call/);
});

test('a replacement may not grant itself new capabilities', () => {
  const e = fails(`
    fn save(x) { return x }
    redefine fn save(x) needs fs { return write("out.txt", x) }
  `, { caps: ['fs'] });
  assert.equal(e.kind, 'RedefineError');
  assert.match(e.message, /may drop capabilities, never add them/);
});

test('dropping a capability is allowed', () => {
  const { value } = run(`
    fn touch(x) needs fs { return x }
    redefine fn touch(x) { return x + 1 }
    touch(1)
  `, { caps: ['fs'] });
  assert.equal(value, 2);
});

test('a replacement inherits the promises the original made', () => {
  const e = fails(`
    fn half(x) requires x >= 0 ensures result >= 0 { return x / 2 }
    redefine fn half(x) { return x - 1000 }
  `);
  assert.equal(e.kind, 'RedefineError');
  assert.match(e.message, /does not keep the contract half would run under/);
});

test('the original is still in place after a rejected replacement', () => {
  const { value } = run(`
    fn half(x) requires x >= 0 ensures result >= 0 { return x / 2 }
    attempt {
      redefine fn half(x) { return x - 1000 }
    } rescue e { }
    half(10)
  `);
  assert.equal(value, 5, 'a refused rewrite must leave the working version running');
});

test('a replacement that keeps its promises goes live', () => {
  const { value } = run(`
    fn half(x) requires x >= 0 ensures result >= 0 { return x / 2 }
    redefine fn half(x) { return x / 4 }
    half(80)
  `);
  assert.equal(value, 20);
});

test('a promise the replacement adds is checked at the swap, not at the first call', () => {
  const e = fails(`
    fn f(x) { return x }
    redefine fn f(x) ensures result > 1000 { return x }
  `);
  assert.equal(e.kind, 'RedefineError');
  assert.match(e.message, /does not keep the contract/);
});

test('a replacement may add a promise it actually keeps', () => {
  const { value } = run(`
    fn f(x) { return x }
    redefine fn f(x) ensures result >= 0 { return abs(x) }
    [f(-7), versions("f")]
  `);
  assert.deepEqual(value, [7, 2]);
});

test('a racy replacement is refused', () => {
  const e = fails(`
    fn go(n) { return n }
    redefine fn go(n) { var acc = 0  fork 3 { acc = acc + 1 }  return acc }
  `);
  assert.equal(e.kind, 'RedefineError');
  assert.match(e.message, /has a race/);
});

test('redefining something that is not a function is refused', () => {
  assert.equal(fails('let x = 5\nredefine fn x() { return 1 }').kind, 'TypeError');
  assert.equal(fails('redefine fn nope() { return 1 }').kind, 'NameError');
});

test('rollback restores the previous version', () => {
  const { value } = run(`
    fn f(x) { return x + 1 }
    redefine fn f(x) { return x + 100 }
    let after = f(0)
    rollback("f")
    [after, f(0), versions("f")]
  `);
  assert.deepEqual(value, [100, 1, 1]);
});

test('rollback with nothing to go back to is an error', () => {
  assert.equal(fails('fn f() { return 1 }\nrollback("f")').kind, 'RedefineError');
});

test('a redefinition reports what it affects', () => {
  const { value } = run(`
    fn a(x) { return x }
    fn b(x) { return a(x) }
    fn c(x) { return b(x) }
    redefine fn a(x) { return x + 1 }
  `);
  assert.deepEqual(value, ['b', 'c']);
});

// ---------------------------------------------------------------------------
// hot-swapping a live agent
// ---------------------------------------------------------------------------

test('an agent handler can be replaced while its state survives', () => {
  const { value } = run(`
    agent Counter() {
      var total = 0
      on add(n) { total = total + n }
    }
    let c = spawn Counter()
    send(c, "add", 5)
    run_agents()
    let before = c.state("total")

    redefine on Counter.add(n) { total = total + (n * 10) }
    send(c, "add", 5)
    run_agents()
    [before, c.state("total")]
  `);
  assert.deepEqual(value, [5, 55], 'the accumulated 5 must survive the swap');
});

test('a handler replacement must match the message shape', () => {
  const e = fails(`
    agent A() { on go(n) { } }
    redefine on A.go(n, m) { }
  `);
  assert.equal(e.kind, 'RedefineError');
});

test('replacing a handler that does not exist is refused', () => {
  const e = fails('agent A() { on go(n) { } }\nredefine on A.stop() { }');
  assert.equal(e.kind, 'RedefineError');
  assert.match(e.message, /no 'stop' handler/);
});

// ---------------------------------------------------------------------------
// call graph
// ---------------------------------------------------------------------------

test('the call graph is derived from the source', () => {
  const g = buildCallGraph(parse(`
    fn leaf(x) { return x }
    fn middle(x) { return leaf(x) }
    fn top(x) { return middle(x) + leaf(x) }
  `, '<t>'));
  assert.deepEqual(g.callees('top').sort(), ['leaf', 'middle']);
  assert.deepEqual(g.callers('leaf'), ['middle', 'top']);
  assert.deepEqual(g.dependents('leaf'), ['middle', 'top']);
});

test('mutual recursion is found and does not hang the walk', () => {
  const g = buildCallGraph(parse(`
    fn even(n) { return odd(n) }
    fn odd(n) { return even(n) }
  `, '<t>'));
  assert.equal(g.cycles().length > 0, true);
  assert.deepEqual(g.dependents('even').sort(), ['even', 'odd']);
});

test('the graph reaches the language and updates on redefinition', () => {
  const { value } = run(`
    fn a(x) { return x }
    fn b(x) { return a(x) }
    let before = callers("a")
    redefine fn b(x) { return x }
    [before, callers("a")]
  `);
  assert.deepEqual(value, [['b'], []]);
});

// ---------------------------------------------------------------------------
// migration
// ---------------------------------------------------------------------------

test('state travels: values, tensors, ledgers, context windows', () => {
  const source = `
    var counter = 0
    var notes = []
    var book = ledger("trades")
    var ctx = context(1000)
    var weightsish = tensor [[1, 2], [3, 4]]
  `;
  const a = new Interpreter({ out: () => {} });
  a.run(`${source}
    counter = 42
    notes.push("one")
    notes.push("two")
    book.append("buy 100")
    ctx.push("remember this")
  `, '<a>');
  const state = snapshot(a);

  const b = new Interpreter({ out: () => {} });
  b.run(source, '<b>');
  restore(b, JSON.parse(JSON.stringify(state)));

  assert.equal(b.globals.get('counter'), 42);
  assert.deepEqual(b.globals.get('notes'), ['one', 'two']);
  assert.equal(b.globals.get('book').length, 1);
  assert.ok(b.globals.get('book').verify(), 'the ledger must still verify after moving');
  assert.ok(b.globals.get('ctx').text().includes('remember this'));
  assert.deepEqual(b.globals.get('weightsish').toNested(), [[1, 2], [3, 4]]);
  a.devices.shutdown();
  b.devices.shutdown();
});

test('the random stream resumes exactly where it left off', () => {
  const a = new Interpreter({ seed: 5, out: () => {} });
  a.run('var xs = []\nfor i in range(3) { xs.push(random()) }', '<a>');
  const state = snapshot(a);
  const nextInA = a.rng.next();

  const b = new Interpreter({ seed: 999, out: () => {} });
  b.run('var xs = []', '<b>');
  restore(b, JSON.parse(JSON.stringify(state)));
  assert.equal(b.rng.next(), nextInA, 'a migrated program must not repeat or skip draws');
  a.devices.shutdown();
  b.devices.shutdown();
});

test('live agents move with their state and their undelivered mail', () => {
  const source = `
    agent Worker(tag) {
      var done = 0
      on task(n) { done = done + n }
    }
  `;
  const a = new Interpreter({ out: () => {} });
  a.run(`${source}
    var w = spawn Worker("alpha")
    send(w, "task", 3)
    run_agents()
    send(w, "task", 9)
  `, '<a>');
  assert.equal(a.scheduler.pending, 1);
  const state = snapshot(a);

  const b = new Interpreter({ out: () => {} });
  b.run(source, '<b>');
  restore(b, JSON.parse(JSON.stringify(state)));

  assert.equal(b.scheduler.agents.length, 1);
  assert.equal(b.scheduler.agents[0].env.vars.get('done').value, 3);
  assert.equal(b.scheduler.pending, 1, 'the queued message must travel too');

  b.run('run_agents()\n', '<b2>');
  assert.equal(b.scheduler.agents[0].env.vars.get('done').value, 12,
    'the migrated agent should finish the work it had queued');
  a.devices.shutdown();
  b.devices.shutdown();
});

test('a snapshot says what it could not carry', () => {
  const a = new Interpreter({ caps: ['crypto'], out: () => {} });
  a.run('var k = keypair()\nvar n = 7', '<a>');
  const state = snapshot(a);
  assert.ok(state.skipped.some((s) => s.startsWith('k')), 'the keypair should be listed as left behind');
  assert.ok('n' in state.globals);
  a.devices.shutdown();
});

test('restoring into a program without the right agent is refused', () => {
  const a = new Interpreter({ out: () => {} });
  a.run('agent Worker() { on go() { } }\nvar w = spawn Worker()', '<a>');
  const state = snapshot(a);
  const b = new Interpreter({ out: () => {} });
  b.run('var x = 1', '<b>');
  assert.throws(() => restore(b, JSON.parse(JSON.stringify(state))), /has no such agent/);
  a.devices.shutdown();
  b.devices.shutdown();
});

test('a snapshot round-trips through the language', () => {
  const { value } = run(`
    var tally = 0
    tally = 17
    let saved = snapshot()
    tally = 0
    restore(saved)
    tally
  `);
  assert.equal(value, 17);
});

test('restoring nonsense is refused', () => {
  assert.equal(fails('restore("not json")').kind, 'RestoreError');
  assert.equal(fails('restore("{\\"version\\": 99}")').kind, 'RestoreError');
});

// ---------------------------------------------------------------------------
// growth
// ---------------------------------------------------------------------------

test('a structure that grows every sample is reported', () => {
  const { value } = run(`
    var log = []
    var stable = [1, 2, 3]
    for i in range(4) {
      log.push(i)
      watch()
    }
    leaks()
  `);
  assert.equal(value.length, 1);
  assert.equal(value[0].get('name'), 'log');
  assert.equal(value[0].get('from'), 1);
  assert.equal(value[0].get('to'), 4);
});

test('leak detection refuses to guess from too few samples', () => {
  const e = fails('var log = []\nwatch()\nwatch()\nleaks()');
  assert.equal(e.kind, 'ValueError');
  assert.match(e.message, /at least 3/);
});

test('a structure that stops growing is not reported', () => {
  const { value } = run(`
    var log = []
    log.push(1)
    watch()
    log.push(2)
    watch()
    watch()
    watch()
    leaks()
  `);
  assert.deepEqual(value, []);
});
