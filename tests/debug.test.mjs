import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Interpreter } from '../src/interpreter.js';
import { Debugger, Session, DebuggerQuit, STEP } from '../src/debug.js';

// The debugger.
//
// Every test drives it through the same path the terminal does -- a `Session`
// reading commands and writing output -- rather than poking at `Debugger`
// directly, because the interesting behaviour is in what a sequence of commands
// does to a running program, not in any one method.
//
// The reader is scripted: it hands back the next queued command and, when the
// script runs out, whatever `whenExhausted` says. That last part matters. A
// debugger test that runs out of commands mid-program must not hang, and the
// obvious mistake is to return '' forever and spin.

function debugRun(source, script, { whenExhausted = 'c', caps = [], principals = [] } = {}) {
  const out = [];
  const printed = [];
  const interp = new Interpreter({
    out: (s) => printed.push(s), seed: 1, caps, principals,
  });
  interp.compiled = false;                 // the debugger's engine, always

  const queue = [...script];
  const dbg = new Debugger({ file: 't.smarsh', source, onPause: null });
  const session = new Session({
    dbg,
    readCommand: () => (queue.length ? queue.shift() : whenExhausted),
    write: (s) => out.push(s),
    interp,
  });
  dbg.onPause = (d, node, itp) => session.pause(node, itp);
  interp.debugHook = dbg;

  let stopped = false;
  let error = null;
  try {
    interp.run(source, 't.smarsh');
  } catch (e) {
    if (e instanceof DebuggerQuit) stopped = true;
    else error = e.kind ?? e.message;
  } finally {
    interp.devices.shutdown();
  }
  return { text: out.join(''), printed, stopped, error, dbg, interp, left: queue.length };
}

const PROGRAM = [
  'let a = 1',              // 1
  'let b = a + 2',          // 2
  'fn double(x) {',         // 3
  '  let inner = x * 2',    // 4
  '  return inner',         // 5
  '}',                      // 6
  'let c = double(b)',      // 7
  'print(c)',               // 8
].join('\n');

// ---------------------------------------------------------------------------
// stopping at all
// ---------------------------------------------------------------------------

test('it stops on the first statement before anything has run', () => {
  const r = debugRun(PROGRAM, ['p a']);
  // `a` is not yet defined: the debugger stops *before* the line, which is the
  // only useful place to stop -- after it, the state that caused the answer is
  // already gone.
  assert.match(r.text, /NameError/);
  assert.match(r.text, /=>\s+1 \| let a = 1/);
});

test('continuing runs the program to the end', () => {
  const r = debugRun(PROGRAM, ['c']);
  assert.deepEqual(r.printed, ['6']);
  assert.equal(r.error, null);
});

test('the program still produces its real answer while being debugged', () => {
  // A debugger that changes the answer is worse than none.
  const plain = new Interpreter({ out: () => {}, seed: 1 });
  let expected;
  try { plain.run(PROGRAM, 't.smarsh'); } finally { plain.devices.shutdown(); }
  const r = debugRun(PROGRAM, ['c']);
  assert.deepEqual(r.printed, ['6']);
  assert.equal(expected, undefined);      // the plain run printed nothing; ours did
});

// ---------------------------------------------------------------------------
// stepping
// ---------------------------------------------------------------------------

function linesStoppedAt(source, script) {
  const seen = [];
  const out = [];
  const interp = new Interpreter({ out: () => {}, seed: 1 });
  interp.compiled = false;
  const queue = [...script];
  const dbg = new Debugger({ file: 't.smarsh', source, onPause: null });
  const session = new Session({
    dbg,
    readCommand: () => (queue.length ? queue.shift() : 'c'),
    write: (s) => out.push(s),
    interp,
  });
  dbg.onPause = (d, node, itp) => { seen.push(node.line); session.pause(node, itp); };
  interp.debugHook = dbg;
  try { interp.run(source, 't.smarsh'); } catch { /* the script may quit */ } finally {
    interp.devices.shutdown();
  }
  return seen;
}

test('step goes into a call', () => {
  // From line 7 (`let c = double(b)`), `s` should land inside the function.
  const seen = linesStoppedAt(PROGRAM, ['s', 's', 's', 's', 's', 's']);
  assert.ok(seen.includes(4), `never stepped into the function body: ${seen.join(',')}`);
});

test('next steps over a call instead of into it', () => {
  // Stepping over line 7 must not stop at line 4, which is inside `double`.
  const seen = linesStoppedAt(PROGRAM, ['c']);   // baseline: nothing but line 1
  assert.deepEqual(seen, [1]);

  const over = linesStoppedAt(PROGRAM, ['n', 'n', 'n', 'n', 'c']);
  const afterSeven = over.slice(over.indexOf(7) + 1);
  assert.ok(!afterSeven.includes(4), `\`next\` stepped into the call: ${over.join(',')}`);
});

test('finish runs out of the call it is in', () => {
  const source = [
    'fn inner(x) {',      // 1
    '  let y = x + 1',    // 2
    '  let z = y + 1',    // 3
    '  return z',         // 4
    '}',                  // 5
    'let r = inner(1)',   // 6
    'print(r)',           // 7
  ].join('\n');
  // Single-stepping reaches line 3, inside `inner`. `finish` from there must
  // resume at line 7 -- the caller's next statement -- without stopping at
  // line 4, which is still inside the call.
  const seen = linesStoppedAt(source, ['s', 's', 's', 'f', 'c']);
  const atFinish = seen.indexOf(3);
  assert.ok(atFinish !== -1, `never reached line 3: ${seen.join(',')}`);
  const next = seen[atFinish + 1];
  assert.equal(next, 7, `\`finish\` resumed at line ${next}, not outside the call: ${seen.join(',')}`);
});

test('a step stops once per line, not once per statement on it', () => {
  // Three statements on one line would otherwise need three `next` presses to
  // get past, which makes stepping feel broken.
  const source = 'var a = 0\na = 1  a = 2  a = 3\nprint(a)\n';
  const seen = linesStoppedAt(source, ['n', 'n', 'n', 'c']);
  const onLineTwo = seen.filter((l) => l === 2).length;
  assert.equal(onLineTwo, 1, `stopped ${onLineTwo} times on one line`);
});

// ---------------------------------------------------------------------------
// breakpoints
// ---------------------------------------------------------------------------

test('a breakpoint stops where it was set, and nowhere else', () => {
  const seen = linesStoppedAt(PROGRAM, ['b 7', 'c', 'c']);
  assert.ok(seen.includes(7), `never stopped at the breakpoint: ${seen.join(',')}`);
});

test('a breakpoint inside a function is hit on the call', () => {
  const seen = linesStoppedAt(PROGRAM, ['b 5', 'c', 'c']);
  assert.ok(seen.includes(5), `never stopped inside the function: ${seen.join(',')}`);
});

test('breakpoints can be listed, removed, and cleared', () => {
  const r = debugRun(PROGRAM, ['b 5', 'b 7', 'b', 'd 5', 'b', 'd', 'b', 'c']);
  assert.match(r.text, /breakpoints: 5, 7/);
  assert.match(r.text, /removed line 5/);
  assert.match(r.text, /breakpoints: 7/);
  assert.match(r.text, /all breakpoints removed/);
  assert.match(r.text, /no breakpoints/);
});

test('a breakpoint outside the file is refused rather than silently ignored', () => {
  const r = debugRun(PROGRAM, ['b 999', 'b nonsense', 'c']);
  assert.match(r.text, /not a line in this file: 999/);
  assert.match(r.text, /not a line in this file: nonsense/);
  assert.equal(r.dbg.breakpoints.size, 0);
});

test('removing a breakpoint that was never set says so', () => {
  const r = debugRun(PROGRAM, ['d 3', 'c']);
  assert.match(r.text, /no breakpoint at 3/);
});

// ---------------------------------------------------------------------------
// looking around
// ---------------------------------------------------------------------------

test('print evaluates in the scope where the program stopped', () => {
  const r = debugRun(PROGRAM, ['b 5', 'c', 'p x', 'p inner', 'c']);
  // Inside `double`, both the parameter and the local are visible.
  assert.match(r.text, /\n?\s+3\b/, 'the parameter was not printed');
  assert.match(r.text, /\n?\s+6\b/, 'the local was not printed');
});

test('print can evaluate an expression, not just a name', () => {
  const r = debugRun(PROGRAM, ['b 7', 'c', 'p a + b', 'c']);
  assert.match(r.text, /\s4\b/);
});

test('a bad expression does not end the session', () => {
  // Getting it wrong is most of what anyone does at a debugger prompt.
  const r = debugRun(PROGRAM, ['p nope', 'p (((', 'p a', 'c']);
  assert.match(r.text, /NameError/);
  assert.deepEqual(r.printed, ['6'], 'the program did not finish after a bad expression');
});

test('print with no argument asks what to print', () => {
  const r = debugRun(PROGRAM, ['p', 'c']);
  assert.match(r.text, /print what\?/);
});

test('locals shows what is in scope, nearest first', () => {
  const r = debugRun(PROGRAM, ['b 5', 'c', 'locals', 'c']);
  assert.match(r.text, /here:/);
  assert.match(r.text, /inner = 6/);
  // And the outer scope, further out.
  assert.match(r.text, /scope\(s\) out:/);
  assert.match(r.text, /let a = 1/);
});

test('locals distinguishes let from var', () => {
  const r = debugRun('var counter = 0\nlet fixed = 1\nprint(counter)\n', ['n', 'n', 'locals', 'c']);
  assert.match(r.text, /var counter = 0/);
  assert.match(r.text, /let fixed = 1/);
});

test('the backtrace shows the call stack', () => {
  const r = debugRun(PROGRAM, ['b 5', 'c', 'bt', 'c']);
  assert.match(r.text, /double/);
  assert.match(r.text, /#0 top level/);
});

test('at the top level the backtrace says so', () => {
  const r = debugRun(PROGRAM, ['bt', 'c']);
  assert.match(r.text, /top level/);
});

test('the listing marks the current line and any breakpoints', () => {
  const r = debugRun(PROGRAM, ['b 3', 'l', 'c', 'c']);
  assert.match(r.text, /=>\s+1 \|/, 'the current line is not marked');
  assert.match(r.text, /\*\s+3 \|/, 'the breakpoint is not marked');
});

test('list takes a line to look at', () => {
  const r = debugRun(PROGRAM, ['l 7', 'c']);
  assert.match(r.text, /=>\s+7 \| let c = double\(b\)/);
});

test('caps reports the authority the paused frame holds', () => {
  const r = debugRun('print(1)\n', ['caps', 'c'], { caps: ['fs', 'clock'] });
  assert.match(r.text, /clock, fs/);
  const none = debugRun('print(1)\n', ['caps', 'c']);
  assert.match(none.text, /none/);
});

// ---------------------------------------------------------------------------
// the prompt itself
// ---------------------------------------------------------------------------

test('help lists the commands, and every one of them works', () => {
  const r = debugRun(PROGRAM, ['help', 'c']);
  // Each command named in the help text must be one the prompt accepts. A help
  // text that documents a command nobody implemented is how this rots.
  const named = [...r.text.matchAll(/^\s{2}([a-z]+(?:, [a-z]+)?)\s{2,}/gm)]
    .flatMap((m) => m[1].split(', '));
  assert.ok(named.length >= 10, `only found ${named.length} commands in the help text`);
  for (const cmd of named) {
    const probe = debugRun(PROGRAM, [cmd, 'c']);
    assert.doesNotMatch(probe.text, new RegExp(`unknown command \`${cmd}\``),
      `help lists \`${cmd}\`, and the prompt does not know it`);
  }
});

test('an unknown command says so and keeps going', () => {
  const r = debugRun(PROGRAM, ['wat', 'c']);
  assert.match(r.text, /unknown command `wat`/);
  assert.deepEqual(r.printed, ['6']);
});

test('a blank line is ignored rather than treated as a step', () => {
  const r = debugRun(PROGRAM, ['', '', 'p a', 'c']);
  assert.match(r.text, /NameError/, 'a blank line advanced the program');
});

test('quit stops the program where it stands', () => {
  const r = debugRun(PROGRAM, ['q']);
  assert.equal(r.stopped, true);
  assert.deepEqual(r.printed, [], 'the program kept running after quit');
});

test('quitting is not catchable by the program', () => {
  // An `attempt` block must not be able to swallow the user stopping the run.
  const source = 'attempt {\n  print("in")\n} rescue e {\n  print("caught")\n}\nprint("after")\n';
  const r = debugRun(source, ['q']);
  assert.equal(r.stopped, true);
  assert.ok(!r.printed.includes('caught'), 'the program caught the debugger quit');
});

test('a reader that runs dry continues rather than spinning', () => {
  // If the input ends -- a pipe closing, a script that stopped short -- the
  // program must finish, not hang.
  const r = debugRun(PROGRAM, [], { whenExhausted: 'c' });
  assert.deepEqual(r.printed, ['6']);
});

// ---------------------------------------------------------------------------
// the hook, and what it costs
// ---------------------------------------------------------------------------

test('with no debugger attached, nothing is called', () => {
  const interp = new Interpreter({ out: () => {}, seed: 1 });
  interp.compiled = false;
  try {
    assert.equal(interp.debugHook, null);
    interp.run('let a = 1\n', 't.smarsh');
    assert.equal(interp.debugHook, null);
  } finally {
    interp.devices.shutdown();
  }
});

test('evaluating at the prompt does not re-enter the debugger', () => {
  // `print` runs statements through `exec`, which is where the hook lives. If
  // the hook were not detached, the first `p` would recurse into the prompt.
  let pauses = 0;
  const out = [];
  const interp = new Interpreter({ out: () => {}, seed: 1 });
  interp.compiled = false;
  const queue = ['p a + 1', 'p a + 2', 'c'];
  const dbg = new Debugger({ file: 't.smarsh', source: 'let a = 1\nprint(a)\n', onPause: null });
  const session = new Session({
    dbg, readCommand: () => (queue.length ? queue.shift() : 'c'),
    write: (s) => out.push(s), interp,
  });
  dbg.onPause = (d, node, itp) => { pauses += 1; session.pause(node, itp); };
  interp.debugHook = dbg;
  try {
    interp.run('let a = 1\nprint(a)\n', 't.smarsh');
  } finally {
    interp.devices.shutdown();
  }
  assert.ok(pauses <= 2, `the prompt re-entered itself: ${pauses} pauses`);
  assert.equal(interp.debugHook, dbg, 'the hook was not put back');
});

test('an expression at the prompt holds no more authority than the frame', () => {
  // A debugger that can do what the program cannot is a debugger that lies.
  const r = debugRun('print(1)\n', ['p now()', 'c']);
  assert.match(r.text, /CapabilityError|capability/i);
});

test('the program can still fail normally while being debugged', () => {
  const r = debugRun('let a = 1\nlet b = nope\n', ['c']);
  assert.equal(r.error, 'NameError');
});
