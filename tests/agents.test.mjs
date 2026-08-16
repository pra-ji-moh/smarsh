import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Interpreter } from '../src/interpreter.js';
import { PedagError } from '../src/errors.js';
import { parse } from '../src/parser.js';
import { analyze } from '../src/analysis.js';

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

const KEEPER = `
  agent Keeper(name) {
    var seen = 0
    var total = 0
    on record(n) { seen = seen + 1  total = total + n }
    on audit() { send(sender, "result", name, total) }
  }
`;

// ---------------------------------------------------------------------------
// agents
// ---------------------------------------------------------------------------

test('an agent starts with the state its constructor set up', () => {
  const { value } = run(`${KEEPER}
    let k = spawn Keeper("london")
    [k.state("name"), k.state("seen"), k.state("total")]
  `);
  assert.deepEqual(value, ['london', 0, 0]);
});

test('messages are queued and then delivered', () => {
  const { value } = run(`${KEEPER}
    let k = spawn Keeper("a")
    send(k, "record", 100)
    send(k, "record", 50)
    let queued = pending()
    let done = run_agents()
    [queued, done, k.state("seen"), k.state("total"), pending()]
  `);
  assert.deepEqual(value, [2, 2, 2, 150, 0]);
});

test('agents reply to each other, with sender bound automatically', () => {
  const { value } = run(`${KEEPER}
    agent Auditor() {
      var got = []
      on begin(k) { send(k, "audit") }
      on result(who, total) { got.push(who + ":" + str(total)) }
    }
    let k = spawn Keeper("tokyo")
    let a = spawn Auditor()
    send(k, "record", 900)
    send(a, "begin", k)
    run_agents()
    a.state("got")
  `);
  assert.deepEqual(value, ['tokyo:900']);
});

test('a message sent from the top level has no sender', () => {
  const e = fails(`${KEEPER}
    let k = spawn Keeper("a")
    send(k, "audit")
    run_agents()
  `);
  assert.equal(e.kind, 'AgentError');
  assert.match(e.message, /came from the top level/);
});

test('delivery is deterministic: round-robin in spawn order', () => {
  const src = `
    agent Logger(tag) {
      on note(target) { send(target, "write", tag) }
    }
    agent Sink() {
      var order = []
      on write(tag) { order.push(tag) }
    }
    let sink = spawn Sink()
    let a = spawn Logger("a")
    let b = spawn Logger("b")
    let c = spawn Logger("c")
    send(a, "note", sink)
    send(b, "note", sink)
    send(c, "note", sink)
    run_agents()
    sink.state("order")
  `;
  assert.deepEqual(run(src).value, ['a', 'b', 'c']);
  assert.deepEqual(run(src, { seed: 77 }).value, run(src, { seed: 4 }).value);
});

test('an agent cannot write anything outside its own state', () => {
  const e = fails(`
    var shared = 0
    agent Rogue() { on grab() { shared = shared + 1 } }
    send(spawn Rogue(), "grab")
    run_agents()
  `);
  assert.equal(e.kind, 'AgentIsolationError');
  assert.match(e.message, /'shared' belongs to the scope outside it/);
});

test('an agent cannot mutate a shared structure either', () => {
  const e = fails(`
    var shared = [1, 2]
    agent Rogue() { on grab() { shared[0] = 99 } }
    send(spawn Rogue(), "grab")
    run_agents()
  `);
  assert.equal(e.kind, 'AgentIsolationError');
});

test('an agent can still read globals and call the program functions', () => {
  const { value } = run(`
    let rate = 3
    fn scale(n) { return n * rate }
    agent Worker() {
      var out = 0
      on go(n) { out = scale(n) }
    }
    let w = spawn Worker()
    send(w, "go", 7)
    run_agents()
    w.state("out")
  `);
  assert.equal(value, 21);
});

test('sending an unhandled message is caught at the send', () => {
  const e = fails(`${KEEPER}
    send(spawn Keeper("a"), "explode")
  `);
  assert.equal(e.kind, 'AgentError');
  assert.match(e.message, /no handler for 'explode'/);
});

test('handler arity is checked on delivery', () => {
  const e = fails(`${KEEPER}
    send(spawn Keeper("a"), "record", 1, 2)
    run_agents()
  `);
  assert.equal(e.kind, 'ArityError');
});

test('a ping-pong dialogue terminates', () => {
  const { value } = run(`
    agent Player(tag) {
      var hits = 0
      on ping(n) {
        hits = hits + 1
        if n > 0 { send(sender, "ping", n - 1) }
      }
      on start(other, n) { send(other, "ping", n) }
    }
    let a = spawn Player("a")
    let b = spawn Player("b")
    send(a, "start", b, 6)
    run_agents()
    [a.state("hits"), b.state("hits")]
  `);
  assert.deepEqual(value, [3, 4]);
});

test('a never-settling agent system is stopped', () => {
  const e = fails(`
    agent Loop() { on go() { send(self, "go") } }
    send(spawn Loop(), "go")
    run_agents(500)
  `);
  assert.equal(e.kind, 'AgentError');
  assert.match(e.message, /probably looping/);
});

test('a stopped agent accepts no more messages', () => {
  const { value } = run(`${KEEPER}
    let k = spawn Keeper("a")
    k.stop()
    send(k, "record", 5)
    [run_agents(), k.state("total")]
  `);
  assert.deepEqual(value, [0, 0]);
});

// ---------------------------------------------------------------------------
// budgets
// ---------------------------------------------------------------------------

test('a budget stops a runaway loop', () => {
  const e = fails('budget steps 2000 { while true { let x = 1 } }');
  assert.equal(e.kind, 'BudgetError');
  assert.match(e.message, /2000 steps/);
});

test('a loop with an empty body still costs steps', () => {
  const e = fails('budget steps 2000 { while true { } }');
  assert.equal(e.kind, 'BudgetError');
});

test('code inside a budget cannot catch its own stop', () => {
  const { value } = run(`
    var rescued = false
    attempt {
      budget steps 800 {
        attempt {
          while true { let x = 1 }
        } rescue e {
          rescued = true
        }
      }
    } rescue outer { }
    rescued
  `);
  assert.equal(value, false, 'an inner attempt must not be able to swallow a budget stop');
});

test('the supervisor outside the budget does catch it', () => {
  const { value } = run(`
    var caught = nil
    attempt {
      budget steps 800 { while true { let x = 1 } }
    } rescue e {
      caught = e["kind"]
    }
    caught
  `);
  assert.equal(value, 'BudgetError');
});

test('a nested budget can only tighten, never loosen', () => {
  const { interp } = run(`
    attempt {
      budget steps 500 {
        budget steps 9999999 { while true { let x = 1 } }
      }
    } rescue e { }
    1
  `);
  assert.ok(interp.steps < 5000, `the inner budget should not have raised the ceiling (used ${interp.steps})`);
});

test('a token budget bounds what may enter context windows', () => {
  const e = fails(`
    budget tokens 40 {
      let ctx = context(100000)
      for i in range(60) { ctx.push("another long line of retrieved evidence goes here") }
    }
  `);
  assert.equal(e.kind, 'BudgetError');
  assert.match(e.message, /40 tokens/);
});

test('a budget that is not exceeded is invisible', () => {
  const { value } = run('budget steps 100000 { var n = 0  for i in range(10) { n = n + i }  n }');
  assert.equal(value, 45);
});

test('budgets reject nonsense', () => {
  assert.equal(fails('budget steps 0 { }').kind, 'ValueError');
  assert.equal(fails('budget gallons 5 { }').kind, 'SyntaxError');
});

// ---------------------------------------------------------------------------
// profiler
// ---------------------------------------------------------------------------

test('the profiler records calls and steps per function', () => {
  const out = [];
  const interp = new Interpreter({ out: (s) => out.push(s) });
  interp.profiling = true;
  interp.run('fn work(n) { var t = 0  for i in range(n) { t = t + i }  return t }\nwork(5)\nwork(5)', '<t>');
  const rec = interp.profile.get('work');
  assert.equal(rec.calls, 2);
  assert.ok(rec.steps > 10);
  assert.ok(rec.nanos > 0n);
});

test('profiling is off unless asked for', () => {
  const { interp } = run('fn f() { return 1 }\nf()');
  assert.equal(interp.profile.size, 0);
});

// ---------------------------------------------------------------------------
// static analysis
// ---------------------------------------------------------------------------

const check = (src) => analyze(parse(src, '<t>'));

test('a fork writing an outer variable is reported', () => {
  const findings = check('var tally = 0\nfork 4 { tally = tally + 1 }');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'race');
  assert.match(findings[0].message, /'tally'/);
});

test('a fork writing into an outer structure is reported', () => {
  const findings = check('var seen = [0,0]\nfork 2 { seen[_] = 1 }');
  assert.equal(findings.filter((f) => f.kind === 'race').length, 1);
});

test('a fork using only its own locals is not reported', () => {
  assert.deepEqual(check('fork 4 { var local = 0  local = local + _  local }'), []);
});

test('shadowing does not produce a false alarm', () => {
  assert.deepEqual(check('var x = 0\nfork 4 { var x = 1  x = x + 1  x }'), []);
});

test('reading an outer variable is fine', () => {
  assert.deepEqual(check('let base = 10\nfork 4 { base + _ }'), []);
});

test('the race checker reports only races; arity belongs to the type checker', () => {
  assert.deepEqual(check('fn add(a, b) { return a + b }\nadd(1)'), []);
});

test('a correct program checks clean', () => {
  assert.deepEqual(check('fn add(a, b) { return a + b }\nprint(add(1, 2))'), []);
});
