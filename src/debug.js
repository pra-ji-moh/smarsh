import fs from 'node:fs';

import { positionOf } from './diagnostics.js';
import { stringify, unwrap } from './values.js';

// A debugger.
//
// "Serious work is impossible without one" is not an exaggeration: without
// stepping, the only way to find out what a program did is to add prints and
// run it again, and every one of those runs is a guess. Contracts and the audit
// trail say what a program was *allowed* to do; a debugger is how you find out
// why it did the wrong thing inside those bounds.
//
// The design is shaped by one constraint: this interpreter is synchronous.
// There is no way to suspend a JavaScript call stack and resume it later
// without rewriting every evaluator as a generator, which would cost speed
// everywhere to serve a feature almost never switched on. So pausing means
// *blocking* -- the debugger reads its next command synchronously, from inside
// the paused program's own stack frame. That is why `Session` takes a
// `readCommand` that returns a string rather than a promise, and it is why the
// whole thing works in a terminal without any async plumbing.
//
// The cost when it is off is one comparison against null in `exec`. Measured
// against HEAD across the eleven benchmark shapes, seven interleaved samples per
// side: 0.0% on the total, and every individual shape inside the noise. That is
// the number, not an expectation -- `tools/ab.mjs` exists because three earlier
// performance claims in this project were wrong.

export const STEP = {
  RUN: 'run',            // until a breakpoint
  IN: 'step',            // the next statement, wherever it is
  OVER: 'next',          // the next statement at this depth or shallower
  OUT: 'finish',         // the next statement shallower than this one
};

export class Debugger {
  constructor({ file, source, onPause }) {
    this.file = file;
    this.source = source;
    this.lines = source.split('\n');
    this.onPause = onPause;

    this.breakpoints = new Set();     // line numbers
    this.mode = STEP.IN;              // stop on the first statement
    this.depthAtStep = 0;
    this.lastLine = -1;
    this.stopped = false;
    this.finished = false;
  }

  addBreakpoint(line) {
    const n = Number(line);
    if (!Number.isInteger(n) || n < 1 || n > this.lines.length) return null;
    this.breakpoints.add(n);
    return n;
  }

  removeBreakpoint(line) { return this.breakpoints.delete(Number(line)); }

  clearBreakpoints() { this.breakpoints.clear(); }

  // Called before every statement. Hot enough that the cheap tests come first:
  // most calls are in RUN mode with no breakpoints, and return on the first
  // comparison.
  onStatement(node, interp) {
    const line = node.line;
    if (line === undefined) return;

    let hit = false;
    if (this.breakpoints.size > 0 && this.breakpoints.has(line)) {
      hit = true;
    } else if (this.mode === STEP.IN) {
      hit = true;
    } else if (this.mode === STEP.OVER) {
      hit = interp.callDepth <= this.depthAtStep;
    } else if (this.mode === STEP.OUT) {
      hit = interp.callDepth < this.depthAtStep;
    }
    if (!hit) return;

    // A single source line can be several statements. Stopping on each of them
    // makes `next` feel broken, so a step stops once per line -- unless the
    // user asked for this line with a breakpoint.
    if (this.mode !== STEP.RUN && line === this.lastLine && !this.breakpoints.has(line)) return;

    this.lastLine = line;
    this.mode = STEP.RUN;
    this.onPause(this, node, interp);
  }

  // --- what the paused program can be asked -------------------------------

  // The source, with a marker on the line about to run.
  listing(around, radius = 4) {
    const first = Math.max(1, around - radius);
    const last = Math.min(this.lines.length, around + radius);
    const out = [];
    for (let n = first; n <= last; n++) {
      const mark = n === around ? '=>' : '  ';
      const bp = this.breakpoints.has(n) ? '*' : ' ';
      out.push(`${mark}${bp}${String(n).padStart(4)} | ${this.lines[n - 1]}`);
    }
    return out;
  }

  // Every binding visible from where the program stopped, nearest scope first.
  // Walking outward rather than flattening means a shadowed name is reported at
  // the scope that actually wins, which is the answer to the question being
  // asked.
  scopes(interp) {
    const out = [];
    let env = interp.env;
    let depth = 0;
    while (env && env !== interp.prelude) {
      const names = [];
      // `vars` converts a small scope to a Map permanently. That is a real cost
      // to impose on a program being debugged, and it is the right trade: the
      // alternative is reaching into the private arrays, which would make this
      // the second thing that has to know Env's representation.
      for (const [name, slot] of env.vars) {
        names.push({ name, value: slot.value, mutable: slot.mutable });
      }
      if (names.length) out.push({ depth, names: names.sort((a, b) => a.name.localeCompare(b.name)) });
      env = env.parent;
      depth += 1;
    }
    return out;
  }

  // The call stack, innermost last, the way a stack trace reads.
  backtrace(interp) {
    const frames = interp.frames.slice(0, interp.frameTop).map((f) => ({ ...f }));
    return frames;
  }

  // Evaluate an expression where the program stopped.
  //
  // Deliberately not sandboxed beyond what the program itself can do: it runs
  // in the paused frame, holding exactly the capabilities that frame holds, so
  // `read("x")` in the debugger is refused for the same reason it would be
  // refused one line further down. A debugger that can do more than the program
  // is a debugger that lies about the program.
  evaluate(expression, interp) {
    // Imported lazily: the parser is not needed unless someone actually asks a
    // question, and `debug.js` is imported by the interpreter's own hook path.
    return interp.runExpression(expression);
  }
}

// ---------------------------------------------------------------------------
// the terminal front end
// ---------------------------------------------------------------------------

const HELP = `
  c, continue        run until the next breakpoint
  s, step            the next statement, into calls
  n, next            the next statement, over calls
  f, finish          run until this call returns
  b, break <line>    set a breakpoint          (b with no argument: list them)
  d, delete <line>   remove one                (d with no argument: all of them)
  l, list [line]     source around here
  p, print <expr>    evaluate, where the program is stopped
  locals             every binding in scope, nearest first
  bt, backtrace      the call stack
  caps               capabilities this frame holds
  q, quit            stop the program
  h, help            this
`.trim();

// A synchronous line reader.
//
// `readline` is asynchronous, and by the time a callback ran the program would
// already have continued. Reading the file descriptor directly is what lets the
// debugger stop *inside* the statement it is stopped at.
export function makeSyncReader({ fd = 0, write = (s) => process.stdout.write(s) } = {}) {
  let pending = '';
  return function readCommand(prompt) {
    write(prompt);
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        return line.replace(/\r$/, '');
      }
      const buf = Buffer.alloc(1024);
      let n;
      try {
        n = fs.readSync(fd, buf, 0, buf.length, null);
      } catch (e) {
        // EOF on a pipe, or the terminal went away. Treat it as "continue and
        // stop asking", which ends the session rather than spinning.
        if (e.code === 'EAGAIN') continue;
        return null;
      }
      if (n === 0) return pending.length ? pending : null;
      pending += buf.subarray(0, n).toString('utf8');
    }
  };
}

export class Session {
  constructor({ dbg, readCommand, write, interp }) {
    this.dbg = dbg;
    this.readCommand = readCommand;
    this.write = write;
    this.interp = interp;
    this.quit = false;
  }

  line(s = '') { this.write(`${s}\n`); }

  // One pause. Returns when the program should continue.
  pause(node, interp) {
    if (this.quit) throw new DebuggerQuit();
    this.line();
    for (const l of this.dbg.listing(node.line)) this.line(l);

    for (;;) {
      const raw = this.readCommand(`(smarsh:${node.line}) `);
      if (raw === null) { this.dbg.mode = STEP.RUN; return; }      // stream ended
      const input = raw.trim();
      if (input === '') continue;

      const [cmd, ...rest] = input.split(/\s+/);
      const arg = rest.join(' ');

      switch (cmd) {
        case 'c': case 'continue':
          this.dbg.mode = STEP.RUN;
          return;

        case 's': case 'step':
          this.dbg.mode = STEP.IN;
          return;

        case 'n': case 'next':
          this.dbg.mode = STEP.OVER;
          this.dbg.depthAtStep = interp.callDepth;
          return;

        case 'f': case 'finish':
          this.dbg.mode = STEP.OUT;
          this.dbg.depthAtStep = interp.callDepth;
          return;

        case 'b': case 'break': {
          if (!arg) {
            const bps = [...this.dbg.breakpoints].sort((a, b) => a - b);
            this.line(bps.length ? `breakpoints: ${bps.join(', ')}` : 'no breakpoints');
            break;
          }
          const set = this.dbg.addBreakpoint(arg);
          this.line(set ? `breakpoint at line ${set}` : `not a line in this file: ${arg}`);
          break;
        }

        case 'd': case 'delete':
          if (!arg) { this.dbg.clearBreakpoints(); this.line('all breakpoints removed'); break; }
          this.line(this.dbg.removeBreakpoint(arg) ? `removed line ${arg}` : `no breakpoint at ${arg}`);
          break;

        case 'l': case 'list':
          for (const l of this.dbg.listing(arg ? Number(arg) : node.line)) this.line(l);
          break;

        case 'p': case 'print': {
          if (!arg) { this.line('print what?'); break; }
          try {
            this.line(`  ${stringify(unwrap(this.dbg.evaluate(arg, interp)), 0)}`);
          } catch (e) {
            // A failed expression must not kill the session: getting it wrong
            // is most of what anyone does at a debugger prompt.
            this.line(`  ${e.kind ?? 'error'}: ${e.message}`);
          }
          break;
        }

        case 'locals': {
          const scopes = this.dbg.scopes(interp);
          if (scopes.length === 0) { this.line('  nothing in scope'); break; }
          for (const scope of scopes) {
            this.line(scope.depth === 0 ? '  here:' : `  ${scope.depth} scope(s) out:`);
            for (const b of scope.names) {
              const kind = b.mutable ? 'var' : 'let';
              this.line(`    ${kind} ${b.name} = ${safeStringify(b.value)}`);
            }
          }
          break;
        }

        case 'bt': case 'backtrace': {
          const frames = this.dbg.backtrace(interp);
          if (frames.length === 0) { this.line('  top level'); break; }
          frames.forEach((f, i) => this.line(`  #${frames.length - i} ${f.name} (line ${f.line})`));
          this.line(`  #0 top level`);
          break;
        }

        case 'caps': {
          const caps = [...interp.caps].sort();
          this.line(`  ${caps.length ? caps.join(', ') : 'none'}`);
          break;
        }

        case 'q': case 'quit':
          this.quit = true;
          throw new DebuggerQuit();

        case 'h': case 'help': case '?':
          this.line(HELP);
          break;

        default:
          this.line(`unknown command \`${cmd}\` -- \`help\` lists them`);
      }
    }
  }
}

// Stopping the program from the prompt. Not a SmarshError: it is not a fault in
// the program, and it must not be catchable by an `attempt` block in it.
export class DebuggerQuit extends Error {
  constructor() {
    super('stopped from the debugger');
    this.name = 'DebuggerQuit';
  }
}

function safeStringify(v) {
  try {
    const s = stringify(unwrap(v), 1);
    return s.length > 120 ? `${s.slice(0, 117)}...` : s;
  } catch {
    // A value whose printer throws should not take the debugger with it.
    return '<unprintable>';
  }
}

export { positionOf };
