import { Tensor } from './tensor.js';
import { Rng } from './rng.js';
import { pedagError, PedagError, ReturnSignal, BreakSignal, ContinueSignal, BudgetExceeded } from './errors.js';
import { AgentTemplate, Scheduler } from './agents.js';
import { DeviceRegistry } from './devices.js';
import { CallGraph } from './graph.js';
import { closestName } from './diagnostics.js';
import { RecordType, RecordValue, ChoiceType, recordsEqual } from './records.js';
import { analyze } from './analysis.js';
import { exercise } from './exercise.js';
import {
  PedagFunction, NativeFunction, Tainted, ContextWindow, Ledger,
  unwrap, retaint, stringify, typeName, withArticle, truthy, countTokens, freezeDeep, assertMutable,
} from './values.js';
import { installBuiltins } from './builtins.js';
import { runBody, runProgram, compileExpr } from './compile.js';
import { parse } from './parser.js';
import { Cipher, Secret, heAdd, heAddPlain, heMulPlain } from './crypto.js';
import { Liquid } from './temporal.js';
import { Decimal, decimalBinary } from './decimal.js';
import { Labelled, Label, stripLabel, relabel } from './labels.js';
import { Env } from './env.js';

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const STD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'std');

export { Env };

// ---------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------

// Shared, never mutated: the capability set of a function that declares none.
const EMPTY_CAPS = new Set();

// `return`, `break` and `continue` are implemented by throwing, which works
// only while there is something to catch them. At the top level -- or in a
// function body with no enclosing loop -- nothing is, and the raw signal
// escaped to the user as a bare JavaScript object with no kind, no line and no
// message.
//
// Found by fuzzing: 1,060 of 20,000 generated programs leaked one of these
// three. They become ordinary failures here, and `check` reports them
// statically before the program is ever run.
function controlFlowEscape(e, line) {
  if (e instanceof ReturnSignal) {
    return pedagError('ControlFlowError', '`return` outside a function', e.line ?? line)
      .help('the last expression at the top level is already the program\'s result');
  }
  if (e instanceof BreakSignal) {
    return pedagError('ControlFlowError', '`break` outside a loop', e.line ?? line)
      .help('`break` needs an enclosing `while` or `for` to leave');
  }
  if (e instanceof ContinueSignal) {
    return pedagError('ControlFlowError', '`continue` outside a loop', e.line ?? line)
      .help('`continue` needs an enclosing `while` or `for` to continue');
  }
  return null;
}

// The interpreter recurses through JS frames, so a runaway Pēdāg recursion can
// exhaust the host stack before the interpreter's own depth guard fires.
// Either way the program gets one answer with one name.
function asPedagFailure(e, line) {
  if (e instanceof RangeError && /call stack/i.test(e.message)) {
    return pedagError('RecursionError', 'the call stack went too deep', line);
  }
  return e;
}

// Can a call's frame outlive the call?
//
// Only if something inside the body captures it. A function or agent declared
// in the body closes over the frame; everything else -- calls, blocks, loops --
// either gets its own scope or is finished before the call returns. When
// nothing captures it, the frame is reusable and a call need not allocate one.
//
// Computed once per declaration and cached on it.
function framesEscape(decl) {
  if (decl.framesEscape !== undefined) return decl.framesEscape;
  let found = false;
  const walk = (n) => {
    if (found || n === null || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const c of n) walk(c); return; }
    if (n.type === 'Fn' || n.type === 'FnDecl' || n.type === 'AgentDecl' || n.type === 'Spawn') {
      found = true;
      return;
    }
    for (const v of Object.values(n)) if (v !== null && typeof v === 'object') walk(v);
  };
  walk(decl.body);
  // Contracts used to disqualify a function here, out of caution. They do not
  // need to: `requires` runs in the frame itself, `old()` captures values
  // rather than scopes, and the `ensures` scope holding `result` has the frame
  // as its parent and is gone when the call is. None of it outlives the call.
  decl.framesEscape = found;
  return found;
}

export class Interpreter {
  constructor({
    seed = 0, caps = [], principals = [],
    out = (s) => process.stdout.write(`${s}\n`), cwd = process.cwd(),
  } = {}) {
    this.seed = seed;
    this.rng = new Rng(seed);
    // Builtins live in their own scope beneath the program's globals, so a
    // program is free to use `log` or `sample` as a name of its own.
    this.prelude = new Env(null);
    this.globals = new Env(this.prelude);
    this.env = this.globals;
    this.cwd = cwd;
    this.out = out;

    // Capabilities held by the frame currently executing. The top level holds
    // exactly what the CLI granted; each function body holds exactly what it
    // declared with `needs` -- never more, even if its caller held more.
    this.caps = new Set(caps);
    this.grantedCaps = new Set(caps);

    this.groundedDepth = 0;
    this.regionStack = [];
    this.txnStack = [];        // open `atomic` blocks and the ledgers they hold
    this.secretScopes = [];    // open `secret` blocks and what they must shred
    this.logicalTime = 0;      // advanced only by advance(); never a wall clock
    this.oldValues = null;     // pre-state captured for old(), during `ensures`
    this.allocated = 0;        // estimated bytes the program has grown
    this.hasMemoryBudget = false;

    // The decentralized label model: principals this run may act for, those it
    // is acting for right now, and the party data is currently being released to.
    this.grantedAuthority = new Set(principals);
    this.authority = new Set();
    this.releaseStack = [];

    this.devices = new DeviceRegistry();
    this.scheduler = new Scheduler();
    this.agentBoundary = null; // the state scope of the agent currently running
    this.currentAgent = null;  // who `sender` will be on messages sent from here
    this.budgets = [];         // open `budget` blocks
    this.profiling = false;
    this.profile = new Map();  // function name -> { calls, steps, nanos }
    this.callDepth = 0;
    // Deliberately low, and the reason matters.
    //
    // This was 2000, which no run ever reached: both engines exhausted the
    // JavaScript stack first and surfaced that as a RecursionError. So the real
    // recursion limit was however many host frames happened to be available,
    // which differs between the two engines (the compiled one uses fewer frames
    // per call), between platforms, and even between runs on one machine
    // depending on how deep the stack already was. Measured here: the
    // tree-walker died at 422 on one run and 652 on another.
    //
    // A language that signs a manifest claiming a run replays from its seed
    // cannot have a recursion limit that is a property of the machine. 300 is
    // below the worst host ceiling observed anywhere, so this counter is what
    // fires, identically, every time.
    //
    // Raising it means using fewer host frames per Pēdāg call, not raising the
    // number. See LIMITATIONS.md.
    this.maxCallDepth = 300;
    this.frames = [];          // the live call stack, for stack traces
    // Bound methods, kept against the value they belong to. See `member`.
    this.methodCache = new WeakMap();
    this.frameTop = 0;         // how many of them are live; the rest are pooled

    // Closure compilation. On by default; `--engine tree` turns it off, which
    // is how the two are compared. The tree-walker remains the specification --
    // see src/compile.js and tools/differential.mjs.
    this.compiled = true;
    this.retval = null;   // the value carried by a compiled `return`
    this.sigLine = null;  // the line a compiled signal came from

    // The REPL redefines names at the top level; a script may not.
    this.allowRedeclare = false;
    // `prove` caps how long a generated call may run before it is abandoned.
    this.steps = 0;
    // One number that compiled code compares against, so charging a step is a
    // single property load and a single compare. It is the step limit while
    // nothing else needs looking at, and -1 whenever a budget is open, which
    // sends every tick to `tickDue`. Three loads at every statement made the
    // statement closures big enough to cost more than the call they replaced.
    this.tickCheck = Infinity;
    this.stepLimit = Infinity;

    this.trace = {
      branches: [], forks: 0, calls: 0, contracts: 0,
      laundered: [], redefinitions: [], declassifications: [],
      grantUses: [], revocations: [],
      // What the audit record is assembled from.
      effects: [],        // every capability exercised or refused
      crossings: [],      // every data boundary a labelled value met
    };
    this.graph = new CallGraph();
    this.versions = new Map();  // function name -> every version it has had
    this.watches = [];          // growth samples, for leak detection

    this.fileStack = [];
    this.moduleCache = new Map();    // content hash -> exported scope
    this.modulePaths = new Map();    // content hash -> every path it was found at
    this.moduleLoading = new Set();

    this.events = [];           // the discrete-event queue
    this.eventSeq = 0;
    this.cost = { steps: 0, calls: 0, tensorOps: 0, dispatches: 0, tokens: 0 };

    installBuiltins(this);
  }

  // --- top level -----------------------------------------------------------

  run(source, file = '<script>') {
    const program = parse(source, file);
    // `entryPath` is the resolved location of the file being run, which is not
    // always derivable from `file` -- the CLI passes a path relative to the
    // shell's directory while cwd is already the file's own directory.
    this.fileStack.push(this.entryPath ?? path.resolve(this.cwd, path.basename(file)));
    let last = null;
    try {
      if (this.compiled) last = runProgram(this, program);
      else for (const stmt of program.body) last = this.exec(stmt);
    } catch (e) {
      throw controlFlowEscape(e, null) ?? asPedagFailure(e, null);
    } finally {
      this.fileStack.pop();
    }
    return last;
  }

  // --- statements ----------------------------------------------------------

  // One unit of work. Charged per statement AND per loop iteration -- a loop
  // with an empty body still costs something, or `while true { }` would spin
  // forever underneath a budget that never noticed.
  // What is left once the counter has already been advanced.
  //
  // Compiled code inlines the fast half -- bump the counter, and check in one
  // comparison whether anything is due -- so this runs only when the step limit
  // has actually been passed or a budget is open. It must not advance the
  // counter again; the caller already did.
  tickDue(node) {
    if (this.steps > this.stepLimit) {
      throw pedagError('StepLimitError', `this call ran past ${this.stepLimit} steps and was abandoned`, node.line);
    }
    for (let i = 0; i < this.budgets.length; i++) {
      const b = this.budgets[i];
      if (b.kind !== 'steps') continue;
      if (++b.used > b.limit) throw new BudgetExceeded(b);
    }
  }

  get stepLimit() { return this._stepLimit; }

  set stepLimit(v) {
    this._stepLimit = v;
    this.retuneTick();
  }

  // Kept in step with the step limit and with whether any budget is open.
  retuneTick() {
    this.tickCheck = this.budgets.length === 0 ? this._stepLimit : -1;
  }

// A contract is an expression, and it was the last one still being walked.
  //
  // `requires`, `ensures`, record invariants and loop invariants all ran on the
  // tree-walking evaluator regardless of which engine the program was using --
  // 18% of a contract-heavy workload sat in `evaluate` for that reason alone.
  // They compile like anything else now, cached on the node, so a contract
  // checked on every call is compiled once.
  contractValue(expr) {
    return this.compiled ? compileExpr(expr)(this) : this.evaluate(expr);
  }

  tick(node) {
    if (++this.steps > this.stepLimit) {
      throw pedagError('StepLimitError', `this call ran past ${this.stepLimit} steps and was abandoned`, node.line);
    }
    // Almost every program has no budget open; do not walk an empty array
    // several hundred thousand times to discover that.
    if (this.budgets.length === 0) return;
    for (let i = 0; i < this.budgets.length; i++) {
      const b = this.budgets[i];
      if (b.kind !== 'steps') continue;
      if (++b.used > b.limit) throw new BudgetExceeded(b);
    }
  }

  // A block only needs a scope of its own if it actually binds something.
  // Most do not, and an Env plus its Map is a real allocation to skip.
  blockBinds(block) {
    if (block.bindsNames === undefined) {
      block.bindsNames = block.body.some((s) => s.type === 'Declare' || s.type === 'FnDecl'
        || s.type === 'AgentDecl' || s.type === 'Import');
    }
    return block.bindsNames;
  }

  scopeFor(block) {
    return this.blockBinds(block) ? new Env(this.env) : this.env;
  }

  // A loop body may reuse one scope per loop unless it creates closures, which
  // would then all capture the same cell instead of one per iteration.
  capturesScope(block) {
    if (block.makesClosures === undefined) {
      let found = false;
      const walk = (n) => {
        if (found || !n || typeof n !== 'object') return;
        if (Array.isArray(n)) { for (const c of n) walk(c); return; }
        if (n.type === 'Fn' || n.type === 'FnDecl' || n.type === 'AgentDecl' || n.type === 'Spawn') {
          found = true;
          return;
        }
        for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v);
      };
      walk(block);
      block.makesClosures = found;
    }
    return block.makesClosures;
  }

  exec(node) {
    this.tick(node);
    switch (node.type) {
      case 'Declare': {
        const value = this.evaluate(node.value);
        // `let` means immutable, and that has to include what it holds.
        if (!node.mutable && value !== null && typeof value === 'object') freezeDeep(value);
        this.redeclareIfAllowed(node.name);
        this.env.declare(node.name, value, node.mutable, node.line);
        return null;
      }

      case 'FnDecl': {
        const fn = new PedagFunction(node.fn, this.env);
        this.redeclareIfAllowed(node.fn.name);
        this.env.declare(node.fn.name, fn, false, node.line);
        this.graph.define(node.fn.name, node.fn);
        return null;
      }

      case 'RecordDecl': {
        const type = new RecordType(node.name, node.fields, node.line);
        type.invariants = node.invariants ?? [];
        type.closure = this.env;
        this.redeclareIfAllowed(node.name);
        this.env.declare(node.name, type, false, node.line);
        return null;
      }

      case 'ChoiceDecl': {
        const choice = new ChoiceType(node.name, node.line);
        this.redeclareIfAllowed(node.name);
        this.env.declare(node.name, choice, false, node.line);

        for (const v of node.variants) {
          const type = new RecordType(v.name, v.fields, v.line);
          type.invariants = v.invariants ?? [];
          type.closure = this.env;
          type.choice = choice;
          choice.variants.set(v.name, type);
          this.redeclareIfAllowed(v.name);
          // A variant carrying nothing is a value, not a constructor: there is
          // only one of it, so it is written `Empty`, not `Empty()`. Built once
          // and shared, which makes it identical to itself as well as equal.
          const bound = v.fields.length === 0 ? new RecordValue(type, []) : type;
          this.env.declare(v.name, bound, false, v.line);
        }
        return null;
      }

      case 'Redefine':
        return this.redefine(node);

      case 'Import':
        return this.importModule(node);

      case 'If': {
        if (truthy(this.guard(this.evaluate(node.test), node.line, 'condition'))) {
          return this.execBlock(node.then, this.scopeFor(node.then));
        }
        if (node.alt) {
          return node.alt.type === 'Block'
            ? this.execBlock(node.alt, this.scopeFor(node.alt))
            : this.exec(node.alt);
        }
        return null;
      }

      case 'While': {
        // Each pass must start with the bindings the last one made cleared,
        // or the second iteration redeclares a name that is still there.
        // Clearing one scope is cheaper than allocating a new one per pass.
        const fresh = this.capturesScope(node.body);
        const binds = this.blockBinds(node.body);
        const shared = !fresh && binds ? new Env(this.env) : null;
        const loop = this.beginLoopContracts(node);
        while (truthy(this.guard(this.evaluate(node.test), node.line, 'condition'))) {
          this.tick(node);
          this.stepLoopContracts(node, loop);
          let env;
          if (fresh) env = new Env(this.env);
          else if (binds) { shared.clearVars(); env = shared; }
          else env = this.env;
          try {
            this.execBlock(node.body, env);
            this.checkLoopInvariants(node, 'after a pass');
          } catch (e) {
            if (e instanceof BreakSignal) break;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return null;
      }

      case 'For': {
        const iterable = this.guard(this.evaluate(node.iter), node.line, 'loop subject');
        const seq = this.toIterable(iterable, node.line);
        // One scope for the whole loop, unless the body makes closures -- then
        // each iteration needs its own cell for them to capture.
        const fresh = this.capturesScope(node.body);
        const binds = this.blockBinds(node.body);
        let shared = null;
        let slot = null;
        if (!fresh) {
          shared = new Env(this.env);
          shared.declare(node.name, null, false, node.line);
          slot = shared.own(node.name);
        }
        const loop = this.beginLoopContracts(node);
        for (const item of seq) {
          this.tick(node);
          let env;
          if (fresh) {
            env = new Env(this.env);
            env.declare(node.name, item, false, node.line);
          } else {
            if (binds) { shared.clearVars(); shared.putSlot(node.name, slot); }
            slot.value = item;
            env = shared;
          }
          this.stepLoopContracts(node, loop);
          try {
            this.execBlock(node.body, env);
            this.checkLoopInvariants(node, 'after a pass');
          } catch (e) {
            if (e instanceof BreakSignal) break;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return null;
      }

      case 'Return':
        throw new ReturnSignal(node.value ? this.evaluate(node.value) : null, node.line);

      case 'Break': throw new BreakSignal(node.line);
      case 'Continue': throw new ContinueSignal(node.line);

      case 'Block':
        return this.execBlock(node, this.scopeFor(node));

      case 'Maybe': {
        const p = this.asNumber(this.evaluate(node.prob), 'a maybe probability', node.line);
        if (p < 0 || p > 1) {
          throw pedagError('ValueError', `maybe needs a probability in 0..1, got ${p}`, node.line);
        }
        const draw = this.rng.next();
        const taken = draw < p;
        this.trace.branches.push({ line: node.line, kind: 'maybe', p, draw, taken });
        if (taken) return this.execBlock(node.then, new Env(this.env));
        if (node.alt) {
          return node.alt.type === 'Block'
            ? this.execBlock(node.alt, new Env(this.env))
            : this.exec(node.alt);
        }
        return null;
      }

      // Catches failures the runtime raised. Break/continue/return pass
      // straight through -- they are control flow, not failure.
      case 'Attempt': {
        try {
          return this.execBlock(node.body, new Env(this.env));
        } catch (raw) {
          const e = asPedagFailure(raw, node.line);
          if (!(e instanceof PedagError)) throw e;
          const env = new Env(this.env);
          const info = new Map();
          info.set('kind', e.kind);
          info.set('message', e.message);
          info.set('line', e.line ?? 0);
          env.declare(node.name, info, false, node.line);
          return this.execBlock(node.handler, env);
        }
      }

      case 'AgentDecl': {
        const template = new AgentTemplate(node.name, node.stateDecls, node.handlers, node.line);
        template.params = node.params;
        this.redeclareIfAllowed(node.name);
        this.env.declare(node.name, template, false, node.line);
        return null;
      }

      // A hard ceiling on what the code inside may consume. It cannot be
      // raised from inside, and `attempt` inside cannot catch the stop --
      // BudgetExceeded is not a PedagError. Only this boundary turns it into an
      // ordinary failure, for whoever set the budget to handle.
      case 'Budget': {
        const requested = this.asNumber(this.evaluate(node.amount), 'a budget', node.line);
        if (requested <= 0) {
          throw pedagError('ValueError', `a budget must be positive, got ${requested}`, node.line);
        }
        // A nested budget can only tighten, never loosen.
        let limit = Math.floor(requested);
        for (const outer of this.budgets) {
          if (outer.kind === node.kind) limit = Math.min(limit, outer.limit - outer.used);
        }
        const budget = { kind: node.kind, limit: Math.max(limit, 0), used: 0, line: node.line };
        this.budgets.push(budget);
        this.retuneTick();
        const savedMemoryFlag = this.hasMemoryBudget;
        if (node.kind === 'memory') this.hasMemoryBudget = true;
        try {
          return this.execBlock(node.body, new Env(this.env));
        } catch (e) {
          if (e instanceof BudgetExceeded && e.budget === budget) {
            throw pedagError('BudgetError',
              `this block was stopped after using its whole budget of ${budget.limit} ${budget.kind}`, node.line);
          }
          throw e;
        } finally {
          this.budgets.pop();
          this.retuneTick();
          this.hasMemoryBudget = savedMemoryFlag;
        }
      }

      // All the ledger appends inside this block land, or none of them do.
      // A ledger is enrolled the first time it is written to, and every
      // enrolled ledger is committed together at the end.
      // Same code, different substrate. The results must not depend on which.
      case 'Device': {
        const name = stringify(unwrap(this.evaluate(node.target)), 0);
        const threads = node.threads
          ? Math.trunc(this.asNumber(this.evaluate(node.threads), 'a thread count', node.line))
          : null;
        const previous = this.devices.active;
        this.devices.active = name === 'workers'
          ? this.devices.ensureWorkers(threads, node.line)
          : this.devices.get(name, node.line);
        try {
          return this.execBlock(node.body, new Env(this.env));
        } finally {
          this.devices.active = previous;
        }
      }

      case 'Atomic': {
        const enrolled = new Set();
        this.txnStack.push(enrolled);
        try {
          const result = this.execBlock(node.body, new Env(this.env));
          for (const l of enrolled) l.commit();
          return result;
        } catch (e) {
          for (const l of enrolled) l.rollback();
          throw e;
        } finally {
          this.txnStack.pop();
        }
      }

      // Every secret created inside this block has its bytes zeroed on the way
      // out, including when the block exits by failing.
      case 'Secret': {
        const held = [];
        this.secretScopes.push(held);
        try {
          return this.execBlock(node.body, new Env(this.env));
        } finally {
          this.secretScopes.pop();
          for (const s of held) s.shred();
        }
      }

      // Hold a delegated capability, for this block and no longer. The grant is
      // spent on entry, so a use-limited one is consumed even if the body
      // fails, which is the conservative direction.
      case 'Using': {
        const grant = unwrap(this.evaluate(node.grant));
        if (!grant || grant.pedagType !== 'grant') {
          throw pedagError('TypeError',
            `\`using\` needs a grant, got ${typeName(grant)}`, node.line)
            .at(node.span)
            .help('`grant("fs")` makes one, from a frame that already holds it');
        }
        const why = grant.reasonUnusable(this.logicalTime);
        if (why) {
          throw pedagError('CapabilityError',
            `this grant of \`${grant.capability}\` cannot be used: ${why}`, node.line)
            .at(node.span)
            .withLabel('grant is not live');
        }
        grant.spend();
        this.trace.grantUses.push({ line: node.line, capability: grant.capability });

        const saved = this.caps;
        this.caps = new Set([...this.caps, grant.capability]);
        try {
          return this.execBlock(node.body, this.scopeFor(node.body));
        } finally {
          this.caps = saved;
        }
      }

      // Acting for a principal. Authority is not ambient: the run has to have
      // been started with it, and it lasts only for this block.
      case 'Authority': {
        const who = stringify(unwrap(this.evaluate(node.who)), 0);
        if (!this.grantedAuthority.has(who)) {
          throw pedagError('AuthorityError',
            `this run does not act for \`${who}\``, node.line)
            .at(node.span)
            .help(`start it with --principal ${who}`)
            .note('authority is granted at the boundary, like a capability, and cannot be taken from inside');
        }
        const had = this.authority.has(who);
        this.authority.add(who);
        try {
          return this.execBlock(node.body, this.scopeFor(node.body));
        } finally {
          if (!had) this.authority.delete(who);
        }
      }

      // The point where data would actually leave to a party.
      case 'ReleaseTo': {
        const to = stringify(unwrap(this.evaluate(node.to)), 0);
        this.releaseStack.push(to);
        try {
          return this.execBlock(node.body, this.scopeFor(node.body));
        } finally {
          this.releaseStack.pop();
        }
      }

      case 'Grounded': {
        this.groundedDepth += 1;
        try {
          return this.execBlock(node.body, new Env(this.env));
        } finally {
          this.groundedDepth -= 1;
        }
      }

      case 'Region': {
        this.regionStack.push(node.name);
        try {
          return this.execBlock(node.body, new Env(this.env));
        } finally {
          this.regionStack.pop();
        }
      }

      case 'ExprStmt':
        return this.evaluate(node.expr);

      default:
        throw pedagError('InternalError', `unhandled statement ${node.type}`, node.line);
    }
  }

  // Every name the program could have meant here, for suggestions.
  visibleNames() {
    const names = new Set();
    let env = this.env;
    while (env) {
      for (const key of env.vars.keys()) names.add(key);
      env = env.parent;
    }
    return names;
  }

  unknownName(node) {
    const err = pedagError('NameError', `\`${node.name}\` is not defined`, node.line)
      .at(node.span)
      .withLabel('not found in this scope');

    const near = closestName(node.name, this.visibleNames());
    if (near) {
      const isBuiltin = this.prelude.vars.has(near);
      err.help(`there is a ${isBuiltin ? 'builtin' : 'name in scope'} with a similar spelling: \`${near}\``);
    }
    if (this.agentBoundary) {
      err.note('inside an agent handler only the agent\'s own state and the program\'s globals are in scope');
    }
    return err;
  }

  redeclareIfAllowed(name) {
    if (this.allowRedeclare && this.env === this.globals) this.env.deleteVar(name);
  }

  execBlock(block, env) {
    const saved = this.env;
    this.env = env;
    try {
      let last = null;
      for (const stmt of block.body) {
        const v = this.exec(stmt);
        last = stmt.type === 'ExprStmt' ? v : null;
      }
      return last;
    } finally {
      this.env = saved;
    }
  }

  // --- expressions ---------------------------------------------------------

  evaluate(node) {
    switch (node.type) {
      case 'Num': return node.value;

      // Built once and cached on the node: a literal in a loop should not
      // reparse its digits on every pass.
      case 'DecLit': return node.dec ?? (node.dec = Decimal.parse(node.value, node.line));
      case 'Str': return node.value;
      case 'Bool': return node.value;
      case 'Nil': return null;

      case 'Ident': {
        const slot = this.env.slot(node.name);
        if (!slot) throw this.unknownName(node);
        return slot.value;
      }

      case 'ListLit': {
        const items = node.elements.map((e) => this.evaluate(e));
        this.spendMemory(32 + items.length * 8);
        return items;
      }

      case 'MapLit': {
        const m = new Map();
        for (const { key, value } of node.entries) {
          m.set(String(unwrap(this.evaluate(key))), this.evaluate(value));
        }
        return m;
      }

      case 'TensorLit': {
        const raw = this.evaluate(node.value);
        return this.toTensor(raw, node.line);
      }

      case 'Fn':
        return new PedagFunction(node, this.env);

      case 'Unary': {
        const v = this.guard(this.evaluate(node.operand), node.line, 'operand');
        const u = unwrap(v);
        if (node.op === 'not') return retaint(!truthy(u), v);
        if (u instanceof Tensor) return retaint(u.map((x) => -x), v);
        // Negating money is ordinary -- a refund, a credit, a reversal -- and
        // it used to be a TypeError, which meant writing `dec("0") - amount`.
        if (u instanceof Decimal) return retaint(u.negate(), v);
        return retaint(-this.asNumber(u, 'operand of -', node.line), v);
      }

      case 'Logical': {
        const left = this.guard(this.evaluate(node.left), node.line, 'operand');
        if (node.op === 'and' && !truthy(left)) return left;
        if (node.op === 'or' && truthy(left)) return left;
        return this.guard(this.evaluate(node.right), node.line, 'operand');
      }

      case 'Binary': {
        const l = this.guard(this.evaluate(node.left), node.line, 'operand');
        const r = this.guard(this.evaluate(node.right), node.line, 'operand');
        return this.binary(node.op, l, r, node.line);
      }

      case 'Assign': return this.assign(node);

      case 'Call': return this.evalCall(node);

      case 'Index': {
        const obj = this.guard(this.evaluate(node.object), node.line, 'indexed value');
        const idx = node.indices.map((e) => this.guard(this.evaluate(e), node.line, 'index'));
        return retaint(this.index(unwrap(obj), idx.map(unwrap), node.line), obj, ...idx);
      }

      case 'Member': {
        const obj = this.guard(this.evaluate(node.object), node.line, 'value');
        const m = this.member(unwrap(obj), node.name, node.line);
        // A method reached through a tainted value returns tainted results:
        // laundering must be explicit, and `.upper()` is not laundering.
        if (obj instanceof Tainted && m instanceof NativeFunction) {
          const wrapped = new NativeFunction(m.name, m.arity,
            (args, line, itp) => retaint(m.fn(args, line, itp), obj), m.needs);
          wrapped.transparent = m.transparent;
          return wrapped;
        }
        return retaint(m, obj);
      }

      case 'Spawn': {
        const template = unwrap(this.env.get(node.name, node.line));
        if (!(template instanceof AgentTemplate)) {
          throw pedagError('TypeError', `'${node.name}' is ${withArticle(template)}, not an agent`, node.line);
        }
        const args = node.args.map((a) => this.evaluate(a));
        if (args.length !== template.params.length) {
          throw pedagError('ArityError',
            `agent ${template.name} takes ${template.params.length} argument${template.params.length === 1 ? '' : 's'}, got ${args.length}`, node.line);
        }

        // The agent's private scope. Its parent is globals, so it can call the
        // program's functions -- but writing anything up there is refused.
        const state = new Env(this.globals);
        for (let i = 0; i < args.length; i++) {
          state.declare(template.params[i], args[i], false, node.line);
        }
        const savedEnv = this.env;
        const savedBoundary = this.agentBoundary;
        this.env = state;
        this.agentBoundary = state;
        try {
          for (const stmt of template.stateDecls) this.exec(stmt);
        } finally {
          this.env = savedEnv;
          this.agentBoundary = savedBoundary;
        }
        return this.scheduler.spawn(template, state);
      }

      case 'Template': {
        let out = '';
        let tainted = null;
        for (const part of node.parts) {
          if (part.kind === 'text') { out += part.value; continue; }
          const v = this.guard(this.evaluate(part.expr), part.line, 'interpolated value');
          if (v instanceof Tainted) tainted = tainted ? retaint(null, tainted, v) : v;
          out += stringify(unwrap(v), 0);
        }
        // Interpolating an untrusted value produces an untrusted string: a
        // label must not be lost just because the value passed through text.
        return tainted ? retaint(out, tainted) : out;
      }

      // Arms are tried in order; the first whose pattern fits, and whose guard
      // holds, wins. Bindings made by the pattern are visible in the guard and
      // in the body, and nowhere else.
      case 'Match': {
        const subject = this.guard(this.evaluate(node.subject), node.line, 'matched value');
        for (const arm of node.arms) {
          const bindings = new Map();
          if (!this.matchPattern(arm.pattern, unwrap(subject), bindings)) continue;
          const env = new Env(this.env);
          for (const [name, value] of bindings) env.declare(name, value, false, arm.line);
          if (arm.guard) {
            const saved = this.env;
            this.env = env;
            let ok;
            try { ok = truthy(this.evaluate(arm.guard)); } finally { this.env = saved; }
            if (!ok) continue;
          }
          const saved = this.env;
          this.env = env;
          try { return this.evaluate(arm.body); } finally { this.env = saved; }
        }
        throw pedagError('MatchError',
          `no arm of this match fits ${stringify(unwrap(subject), 1)}`, node.line)
          .at(node.span)
          .withLabel('nothing matched')
          .help('add a `_ => ...` arm to cover the rest');
      }

      case 'Choose': {
        const weights = node.arms.map((a) => this.asNumber(this.evaluate(a.weight), 'a choose weight', node.line));
        for (const w of weights) {
          if (w < 0) throw pedagError('ValueError', 'choose weights cannot be negative', node.line);
        }
        const total = weights.reduce((a, b) => a + b, 0);
        if (total <= 0) throw pedagError('ValueError', 'choose weights must add up to more than 0', node.line);
        const draw = this.rng.next() * total;
        let acc = 0;
        let picked = node.arms.length - 1;
        for (let i = 0; i < weights.length; i++) {
          acc += weights[i];
          if (draw < acc) { picked = i; break; }
        }
        this.trace.branches.push({
          line: node.line, kind: 'choose', p: weights[picked] / total, draw: draw / total, taken: picked,
        });
        return this.evaluate(node.arms[picked].value);
      }

      // Fan out n independent reasoning paths. Each path gets its own child
      // scope and its own RNG stream derived from the current one, so paths
      // diverge from each other but the whole fan-out replays identically.
      // Paths are evaluated in order, not on OS threads -- see README.
      case 'Fork': {
        const n = Math.trunc(this.asNumber(this.evaluate(node.count), 'a fork count', node.line));
        if (n < 0) throw pedagError('ValueError', 'cannot fork a negative number of paths', node.line);
        if (n > 100000) throw pedagError('ValueError', `refusing to fork ${n} paths`, node.line);
        const parentRng = this.rng;
        const results = [];
        try {
          for (let i = 0; i < n; i++) {
            this.rng = parentRng.fork(i);
            const env = new Env(this.env);
            env.declare('_', i, false, node.line);
            results.push(this.execBlock(node.body, env));
          }
        } finally {
          this.rng = parentRng;
        }
        this.trace.forks += n;
        return results;
      }

      default:
        throw pedagError('InternalError', `unhandled expression ${node.type}`, node.line);
    }
  }

  // Does `value` fit `pattern`? Collects bindings as it goes; on failure the
  // half-filled bindings are discarded with the arm, so a partial match can
  // never leak a name.
  matchPattern(pattern, value, bindings) {
    switch (pattern.kind) {
      case 'wildcard': return true;

      case 'bind': {
        // A variant carrying nothing is written `Empty`, with no parentheses,
        // which is syntactically indistinguishable from a new binding. Treated
        // as a binding it would match *anything*: `match s { Empty => 0,
        // Circle(r) => r * r }` returned 0 for a Circle, silently, because the
        // first arm swallowed it. A pattern that looks like it tests for a
        // specific value must not be a catch-all.
        //
        // So a name already bound to a nullary variant is a test for that
        // variant. The check is deliberately narrow -- the name has to resolve
        // to a RecordValue belonging to a choice and carrying no fields -- so
        // an ordinary `let Empty = 5` still binds, as any other name would.
        const existing = this.env.slot(pattern.name);
        const known = existing ? unwrap(existing.value) : null;
        if (known instanceof RecordValue && known.type.choice && known.type.fields.length === 0) {
          return value instanceof RecordValue && value.type === known.type;
        }
        bindings.set(pattern.name, value);
        return true;
      }

      case 'literal': return this.deepEquals(value, pattern.value);

      case 'list': {
        if (!Array.isArray(value) || value.length !== pattern.items.length) return false;
        for (let i = 0; i < pattern.items.length; i++) {
          if (!this.matchPattern(pattern.items[i], unwrap(value[i]), bindings)) return false;
        }
        return true;
      }

      case 'record': {
        if (!(value instanceof RecordValue)) return false;
        if (value.type.name !== pattern.name) return false;
        if (pattern.fields.length !== value.type.fields.length) {
          throw pedagError('MatchError',
            `\`${pattern.name}\` has ${value.type.fields.length} field${value.type.fields.length === 1 ? '' : 's'}, but the pattern lists ${pattern.fields.length}`,
            pattern.line);
        }
        for (let i = 0; i < pattern.fields.length; i++) {
          if (!this.matchPattern(pattern.fields[i], unwrap(value.values[i]), bindings)) return false;
        }
        return true;
      }

      default: return false;
    }
  }

  // --- assignment ----------------------------------------------------------

  assign(node) {
    const value = this.evaluate(node.value);
    const t = node.target;

    if (t.type === 'Ident') {
      this.checkAgentWrite(t.name, node.line);
      this.env.assign(t.name, value, node.line);
      return value;
    }

    if (t.type === 'Index') {
      let base = t.object;
      while (base && (base.type === 'Index' || base.type === 'Member')) base = base.object;
      if (base && base.type === 'Ident') this.checkAgentWrite(base.name, node.line);
      const obj = unwrap(this.evaluate(t.object));
      const idx = t.indices.map((e) => unwrap(this.evaluate(e)));
      if (obj instanceof Tensor) {
        throw pedagError('ImmutableError',
          'tensors are immutable; build a new one instead of writing into this one', node.line);
      }
      if (Array.isArray(obj)) {
        assertMutable(obj, 'this list', node.line, pedagError);
        let i = Math.trunc(this.asNumber(idx[0], 'a list index', node.line));
        if (i < 0) i += obj.length;
        if (i < 0 || i >= obj.length) {
          throw pedagError('IndexError', `list index ${idx[0]} out of range (length ${obj.length})`, node.line);
        }
        obj[i] = value;
        return value;
      }
      if (obj instanceof Map) {
        assertMutable(obj, 'this map', node.line, pedagError);
        obj.set(String(idx[0]), value);
        return value;
      }
      throw pedagError('TypeError', `cannot index-assign into ${withArticle(obj)}`, node.line);
    }

    // Member assignment is for maps only; everything else exposes methods, not
    // writable fields.
    const obj = unwrap(this.evaluate(t.object));
    if (obj instanceof Map) {
      assertMutable(obj, 'this map', node.line, pedagError);
      obj.set(t.name, value);
      return value;
    }
    throw pedagError('TypeError', `cannot assign to '.${t.name}' on ${withArticle(obj)}`, node.line);
  }

  // --- calls ---------------------------------------------------------------

  evalCall(node) {
    // `old(x)` is not a function; it is a reference to the pre-state, captured
    // before the body ran. Outside a postcondition it means nothing.
    if (node.callee.type === 'Ident' && node.callee.name === 'old') {
      if (this.oldValues && this.oldValues.has(node)) return this.oldValues.get(node);
      if (!this.oldValues) {
        throw pedagError('ContractError',
          'old() only means something inside an `ensures` clause', node.line)
          .at(node.span)
          .help('it names the value an expression had when the function was entered');
      }
    }

    const calleeVal = this.evaluate(node.callee);
    const callee = unwrap(calleeVal);
    const transparent = callee instanceof NativeFunction && callee.transparent;
    // A plain loop rather than .map: this runs on every call in the program,
    // and the callback would allocate a closure each time.
    const argNodes = node.args;
    const args = new Array(argNodes.length);
    for (let i = 0; i < argNodes.length; i++) {
      const v = this.evaluate(argNodes[i]);
      args[i] = transparent ? v : this.guard(v, node.line, 'argument');
    }
    return this.callValue(callee, args, node.line, this.calleeName(node.callee));
  }

  calleeName(node) {
    if (node.type === 'Ident') return node.name;
    if (node.type === 'Member') return node.name;
    return 'this value';
  }

// The call a program actually makes, most of the time.
  //
  // `callValue` has to cope with everything callable: record constructors,
  // builtins, capability attenuation, preconditions, postconditions, `old()`,
  // profiling. A named function with no capabilities and no contract -- which
  // is nearly every function, and all the hot ones -- needs none of it, and was
  // paying for the dispatch on every invocation.
  //
  // So a compiled call site that has seen the same callee before comes here
  // instead. Everything decidable in advance has been: what kind of value it
  // is, that its arity matches, that it declares nothing, that its frame can be
  // reused. What is left is the frame, the depth, and the bookkeeping a stack
  // trace needs.
  //
  // Arguments arrive positionally rather than in an array, because a call site
  // that knows its own argument count can hold them in JavaScript locals -- so
  // the args array is not allocated either. Together with the pooled frame, a
  // call in this shape allocates nothing at all.
  //
  // The tree-walker still goes through `callValue`, so the differential harness
  // compares the two paths against each other on every example, every standard
  // library module and three thousand generated programs. Divergence between
  // them is a build failure, which is what makes having two paths tolerable.
  callSimple(callee, line, argc, a0, a1, a2, a3) {
    const decl = callee.decl;

    if (argc !== decl.params.length) {
      throw pedagError('ArityError',
        `${callee.name} takes ${decl.params.length} argument${decl.params.length === 1 ? '' : 's'}, got ${argc}`, line);
    }
    if (this.callDepth >= this.maxCallDepth) {
      throw pedagError('RecursionError', `call stack went deeper than ${this.maxCallDepth} frames`, line);
    }

    const pool = decl.framePool ?? (decl.framePool = { closure: callee.closure, envs: [] });
    if (pool.closure !== callee.closure) {
      // Two function values from one declaration over different scopes. Give up
      // on the fast path for this declaration entirely -- see callValue.
      decl.simpleCall = false;
      const args = new Array(argc);
      if (argc > 0) args[0] = a0;
      if (argc > 1) args[1] = a1;
      if (argc > 2) args[2] = a2;
      if (argc > 3) args[3] = a3;
      return this.callValue(callee, args, line, callee.name);
    }

    let env = pool.envs[this.callDepth];
    if (env === undefined || !env.reusable) {
      env = new Env(callee.closure);
      const slots = new Array(argc);
      if (argc > 0) slots[0] = { value: a0, mutable: false };
      if (argc > 1) slots[1] = { value: a1, mutable: false };
      if (argc > 2) slots[2] = { value: a2, mutable: false };
      if (argc > 3) slots[3] = { value: a3, mutable: false };
      env.adoptFrame(decl.params, slots);
      pool.envs[this.callDepth] = env;
    } else {
      env.reuseFrameArgs(decl.params, argc, a0, a1, a2, a3);
    }

    const savedEnv = this.env;
    const savedCaps = this.caps;
    // `needs` is empty by construction here, so the frame holds nothing.
    this.caps = EMPTY_CAPS;
    this.callDepth += 1;
    this.trace.calls += 1;

    if (this.frames.length <= this.frameTop) this.frames.push({ name: callee.name, line });
    else {
      const f = this.frames[this.frameTop];
      f.name = callee.name;
      f.line = line;
    }
    this.frameTop += 1;

    try {
      return runBody(this, decl, env);
    } catch (e) {
      if (e instanceof PedagError && e.frames.length === 0) {
        e.frames = this.frames.slice(0, this.frameTop).map((f) => ({ ...f }));
      }
      // A `break` with no loop inside the body must not reach the caller's.
      throw controlFlowEscape(e, line) ?? e;
    } finally {
      this.frameTop -= 1;
      this.callDepth -= 1;
      this.caps = savedCaps;
      this.env = savedEnv;
    }
  }

  // Is this value callable by the path above? Decided once per declaration.
  canCallSimple(callee) {
    if (!(callee instanceof PedagFunction)) return false;
    const d = callee.decl;
    if (d.simpleCall === undefined) {
      // `callSimple` does not check contracts, so a function that has any is
      // not eligible however cheap its frame is.
      d.simpleCall = d.needs.length === 0
        && d.requires.length === 0
        && d.ensures.length === 0
        && !framesEscape(d);
    }
    // Profiling needs the timing and per-function accounting that only
    // `callValue` does, so it turns this path off wholesale.
    return d.simpleCall && !this.profiling;
  }

  callValue(callee, args, line, name = 'this value') {
    // A record type is called to build one. There is no separate `new`.
    if (callee instanceof RecordType) {
      if (args.length !== callee.fields.length) {
        throw pedagError('ArityError',
          `\`${callee.name}\` has ${callee.fields.length} field${callee.fields.length === 1 ? '' : 's'} (${callee.fields.join(', ')}), but ${args.length} ${args.length === 1 ? 'was' : 'were'} supplied`, line);
      }
      const record = new RecordValue(callee, args);
      this.checkRecordInvariants(record, line);
      return record;
    }

    if (callee instanceof NativeFunction) {
      if (callee.needs.length !== 0) this.requireCaps(callee.needs, callee.name, line);
      if (callee.arity >= 0 && args.length !== callee.arity) {
        throw pedagError('ArityError',
          `${callee.name} takes ${callee.arity} argument${callee.arity === 1 ? '' : 's'}, got ${args.length}`, line);
      }
      try {
        return callee.fn(args, line, this);
      } catch (e) {
        if (e instanceof PedagError && e.line == null) e.line = line;
        throw e;
      }
    }

    if (!(callee instanceof PedagFunction)) {
      throw pedagError('TypeError', `${name} is ${withArticle(callee)}, not something that can be called`, line);
    }

    const { decl } = callee;
    if (args.length !== decl.params.length) {
      throw pedagError('ArityError',
        `${callee.name} takes ${decl.params.length} argument${decl.params.length === 1 ? '' : 's'}, got ${args.length}`, line);
    }

    // Capability check, then attenuation: inside the body only what was
    // declared is held, regardless of what the caller had.
    // Nearly every function declares nothing, and `requireCaps` returns
    // immediately for those -- but a call is not free when it happens on every
    // invocation of every function in the program.
    if (decl.needs.length !== 0) this.requireCaps(decl.needs, callee.name, line);

    if (this.callDepth >= this.maxCallDepth) {
      throw pedagError('RecursionError', `call stack went deeper than ${this.maxCallDepth} frames`, line);
    }

    // The frame. Built rather than declared into, one binding per parameter,
    // sharing the declaration's names array and bumping no versions -- see
    // Env.adoptFrame; a frame nothing has looked through cannot invalidate a
    // cache.
    //
    // And, where the body creates no closure, kept and written over next time.
    // Nothing outside the call can hold a reference to a scope only that call
    // could see, so recursion and tight call loops allocate no frame at all.
    // The pool is indexed by depth, so a recursive call never reuses the frame
    // its own caller is standing in.
    const arity = decl.params.length;
    let env;
    if (framesEscape(decl)) {
      env = new Env(callee.closure);
      if (arity !== 0) {
        const slots = new Array(arity);
        for (let i = 0; i < arity; i++) slots[i] = { value: args[i], mutable: false };
        env.adoptFrame(decl.params, slots);
      }
    } else {
      const pool = decl.framePool ?? (decl.framePool = { closure: callee.closure, envs: [] });
      if (pool.closure !== callee.closure) {
        // Two function values from one declaration, closing over different
        // scopes -- a `fn` created inside a loop, say. Reusing a frame across
        // them would move its parent, and compiled code caches the slot a name
        // resolved to keyed on the scope it looked through. Same scope object,
        // different parent, and the cache answers for the wrong one: closures
        // made in a loop all reported the first iteration's value.
        //
        // Rather than make every cache check the whole chain, this declaration
        // simply stops being poolable. Named functions -- which is nearly all
        // of them, and all the hot ones -- have exactly one closure and keep
        // the fast path.
        decl.framesEscape = true;
        decl.framePool = null;
        env = new Env(callee.closure);
        if (arity !== 0) {
          const slots = new Array(arity);
          for (let i = 0; i < arity; i++) slots[i] = { value: args[i], mutable: false };
          env.adoptFrame(decl.params, slots);
        }
      } else {
        env = pool.envs[this.callDepth];
        if (env === undefined || !env.reusable) {
          env = new Env(callee.closure);
          const slots = new Array(arity);
          for (let i = 0; i < arity; i++) slots[i] = { value: args[i], mutable: false };
          env.adoptFrame(decl.params, slots);
          pool.envs[this.callDepth] = env;
        } else {
          env.reuseFrame(decl.params, args);
        }
      }
    }

    const savedCaps = this.caps;
    const savedEnv = this.env;
    // Nearly every function declares no capabilities, and building a fresh
    // empty Set for each of those calls is pure waste. The shared empty set is
    // never written to -- attenuation only ever replaces it.
    this.caps = decl.needs.length === 0 ? EMPTY_CAPS : new Set(decl.needs);
    this.callDepth += 1;
    this.trace.calls += 1;

    const profStart = this.profiling ? process.hrtime.bigint() : 0n;
    const profSteps = this.steps;
    // The stack is only ever read when something throws, so the records are
    // pooled and mutated in place rather than allocated per call. fib(29) makes
    // 1.6 million calls; that was 1.6 million short-lived objects and the GC
    // time to match.
    if (this.frames.length <= this.frameTop) this.frames.push({ name: callee.name, line });
    else {
      const f = this.frames[this.frameTop];
      f.name = callee.name;
      f.line = line;
    }
    this.frameTop += 1;

    try {
      this.env = env;
      // The overwhelming majority of calls are to a function with no contract
      // at all. Those pay for nothing here: no scan for `old(...)`, no loop
      // over an empty list, no second Env for `result`.
      const contracted = decl.requires.length !== 0 || decl.ensures.length !== 0;
      // `old(expr)` in a postcondition means the value on the way in, so the
      // arguments have to be captured before the body runs and can change them.
      const oldValues = contracted ? this.captureOldValues(decl, env) : null;
      for (const c of decl.requires) {
        this.trace.contracts += 1;
        let held;
        try {
          held = truthy(this.contractValue(c.expr));
        } catch (e) {
          // A precondition that cannot even be evaluated for this input means
          // the input is outside the stated domain, not that the body is wrong.
          // Never overwrite a tag set by a deeper frame -- that failure belongs
          // to the inner function, not to this call's inputs.
          if (e instanceof PedagError && e.phase === undefined) {
            e.phase = 'pre';
            e.fn = callee.name;
          }
          throw e;
        }
        if (!held) {
          const err = pedagError('ContractError',
            `${callee.name} requires ${c.src}, which does not hold for this call`, line);
          err.phase = 'pre';
          err.fn = callee.name;
          throw err;
        }
      }

      let result = null;
      try {
        // The compiled body returns its result directly. The tree-walker
        // signals it by throwing, which for a recursive function means one
        // JavaScript exception per call -- 2.7 million of them for fib(30).
        if (this.compiled) result = runBody(this, decl, env);
        else this.execBlock(decl.body, env);
      } catch (e) {
        if (e instanceof ReturnSignal) result = e.value;
        // A `break` with no loop around it would otherwise escape the call and
        // be caught by whatever loop happened to be running in the *caller*,
        // silently breaking a loop the function cannot see.
        else throw controlFlowEscape(e, line) ?? e;
      }

      if (decl.ensures.length > 0) {
        // `result` lives in a scope of its own so that a postcondition can name
        // it without the body being able to. That scope is as reusable as the
        // frame it hangs off: when the frame is the same object as last time,
        // so is this, and `result` is written into the slot that is already
        // there -- which also lets a compiled postcondition keep its cache,
        // since a fresh scope each call would miss on every one.
        const posts = decl.postPool ?? (decl.postPool = []);
        let post = posts[this.callDepth];
        if (post === undefined || post.parent !== env || !post.reusable) {
          post = new Env(env);
          post.declare('result', result, false, line);
          posts[this.callDepth] = post;
        } else {
          post.setOnlyValue(result);
        }
        const savedInner = this.env;
        const savedOld = this.oldValues;
        this.env = post;
        this.oldValues = oldValues;
        try {
          for (const c of decl.ensures) {
            this.trace.contracts += 1;
            if (!truthy(this.contractValue(c.expr))) {
              const err = pedagError('ContractError',
                `${callee.name} promised ${c.src}, but returned ${stringify(result, 1)}`, decl.line);
              err.phase = 'post';
              err.fn = callee.name;
              throw err;
            }
          }
        } finally {
          this.env = savedInner;
          this.oldValues = savedOld;
        }
      }

      return result;
    } catch (e) {
      // Snapshot the stack at the innermost frame that sees the failure, while
      // it is still standing -- the `finally` below is about to unwind it.
      if (e instanceof PedagError && e.frames.length === 0) {
        // Copied, because the pool below is about to be reused.
        e.frames = this.frames.slice(0, this.frameTop).map((f) => ({ ...f }));
      }
      throw e;
    } finally {
      this.frameTop -= 1;
      this.callDepth -= 1;
      this.caps = savedCaps;
      this.env = savedEnv;
      if (this.profiling) {
        const rec = this.profile.get(callee.name) ?? { calls: 0, steps: 0, nanos: 0n };
        rec.calls += 1;
        rec.steps += this.steps - profSteps;
        rec.nanos += process.hrtime.bigint() - profStart;
        this.profile.set(callee.name, rec);
      }
    }
  }

  // Every capability check, allowed or refused, is recorded here. This is the
  // one choke point all effects pass through, which is what makes the audit
  // record of a run complete rather than best-effort.
  requireCaps(needs, name, line) {
    if (!needs || needs.length === 0) return;
    for (const cap of needs) {
      if (!this.caps.has(cap)) {
        const held = this.caps.size ? [...this.caps].join(', ') : 'nothing';
        this.trace.effects.push({ capability: cap, by: name, line, allowed: false });
        throw pedagError('CapabilityError',
          `${name} needs the '${cap}' capability; this frame holds ${held}`, line);
      }
    }
    for (const cap of needs) {
      this.trace.effects.push({ capability: cap, by: name, line, allowed: true });
    }
  }

  // --- taint enforcement ---------------------------------------------------

  guard(value, line, what = 'value') {
    // A labelled value read inside a `release_to` block is checked against
    // every owner's policy. This is the enforcement point that makes the label
    // model do work rather than merely record intent.
    if (value instanceof Labelled && this.releaseStack.length > 0) {
      const to = this.releaseStack[this.releaseStack.length - 1];
      if (!value.label.canRead(to)) {
        const readers = [...(value.label.effectiveReaders() ?? [])].sort();
        this.trace.crossings.push({
          kind: 'release', to, line, allowed: false, label: value.label.toString(),
        });
        throw pedagError('LabelError',
          `\`${to}\` may not read this ${what}; its owners permit ${readers.length ? readers.join(', ') : 'nobody'}`, line)
          .withLabel('not a permitted reader')
          .note(`the label is ${value.label}`)
          .help(`the owning principal can widen the policy, or declassify it under \`authority\``);
      }
    }

    if (!(value instanceof Tainted)) return value;

    if (this.groundedDepth > 0) {
      for (const bad of ['ungrounded', 'untrusted']) {
        if (value.labels.has(bad)) {
          throw pedagError('TaintError',
            `a grounded block read an ${bad} ${what}; check or launder it with trust() outside the block first`, line);
        }
      }
    }

    const region = this.regionStack[this.regionStack.length - 1];
    if (region) {
      for (const label of value.labels) {
        if (label.startsWith('region:') && label !== `region:${region}`) {
          throw pedagError('TaintError',
            `a value restricted to '${label.slice(7)}' was read inside region '${region}'`, line);
        }
      }
    }

    return value;
  }

  // --- modules -------------------------------------------------------------
  //
  // A module is a file that runs once in its own scope; whatever it declares at
  // the top level is what it exports. There is no export list to keep in sync
  // with the code.
  //
  // The cache is keyed by the SHA-256 of the file's contents, not its path. Two
  // paths holding identical source are one module with one instance -- a vendored
  // copy and the original do not become two subtly different things.

  importModule(node) {
    const fromDir = path.dirname(this.fileStack[this.fileStack.length - 1] ?? path.join(this.cwd, '<entry>'));

    // `std/...` resolves to the standard library that ships with the runtime;
    // everything else is relative to the importing file.
    const isStd = node.path.startsWith('std/');
    const resolved = isStd
      ? path.join(STD_DIR, `${node.path.slice(4)}.pedag`)
      : path.resolve(fromDir, node.path);

    if (!isStd) {
      const root = path.resolve(this.cwd);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw pedagError('ImportError',
          `'${node.path}' resolves outside ${root}; imports stay inside the program's directory`, node.line);
      }
    }

    let source;
    try {
      source = fs.readFileSync(resolved, 'utf8');
    } catch (e) {
      throw pedagError('ImportError', `cannot read module '${node.path}': ${e.code ?? e.message}`, node.line);
    }

    const digest = createHash('sha256').update(source).digest('hex');

    if (this.moduleLoading.has(digest)) {
      throw pedagError('ImportError',
        `'${node.path}' is already being imported further up the chain; modules cannot form a cycle`, node.line);
    }

    let exported = this.moduleCache.get(digest);
    if (!exported) {
      const moduleEnv = new Env(this.prelude);   // a module cannot see its importer
      this.moduleLoading.add(digest);
      this.fileStack.push(resolved);
      const savedEnv = this.env;
      const savedGlobals = this.globals;
      const savedCaps = this.caps;
      try {
        this.env = moduleEnv;
        this.globals = moduleEnv;                // its own top level
        // A module loads holding nothing. Without this it would inherit the
        // importing frame's capabilities, and `import` would be a way to run
        // effects with someone else's authority before their first statement
        // executed -- the whole point of attenuation, undone by a supply chain.
        // Functions the module defines are unaffected: they are checked against
        // the caller's capabilities at the point they are actually called.
        this.caps = EMPTY_CAPS;
        for (const stmt of parse(source, node.path).body) this.exec(stmt);
      } finally {
        this.env = savedEnv;
        this.globals = savedGlobals;
        this.caps = savedCaps;
        this.fileStack.pop();
        this.moduleLoading.delete(digest);
      }
      exported = moduleEnv.vars;
      this.moduleCache.set(digest, exported);
      this.modulePaths.set(digest, [...(this.modulePaths.get(digest) ?? []), resolved]);
    } else {
      const seen = this.modulePaths.get(digest) ?? [];
      if (!seen.includes(resolved)) this.modulePaths.set(digest, [...seen, resolved]);
    }

    if (node.alias) {
      const ns = new Map();
      for (const [name, slot] of exported) ns.set(name, slot.value);
      this.redeclareIfAllowed(node.alias);
      this.env.declare(node.alias, ns, false, node.line);
      return ns.size;
    }

    let count = 0;
    for (const [name, slot] of exported) {
      if (this.env.has(name)) {
        throw pedagError('ImportError',
          `'${node.path}' exports '${name}', which is already declared here; import it 'as' a name instead`, node.line);
      }
      this.env.declare(name, slot.value, slot.mutable, node.line);
      count += 1;
    }
    return count;
  }

  // --- self-modification ---------------------------------------------------
  //
  // Replacing running logic is the point; replacing it *unsafely* is what this
  // refuses to do. Three rules, checked before anything is swapped in:
  //
  //   1. The shape stays the same. Same arity, or every existing call site
  //      would break the moment it fired.
  //   2. Capabilities cannot be escalated. A rewrite may drop `needs`, never
  //      add one the original did not hold. Otherwise self-modification is a
  //      privilege-escalation primitive.
  //   3. Promises cannot be dropped. The replacement inherits the original's
  //      contracts, and is property-tested against the union before it goes
  //      live. A rewrite may promise more; it may never quietly promise less.
  //
  // If any check fails, the previous version is restored and nothing observed
  // the intermediate state.

  redefine(node) {
    if (node.kind === 'handler') return this.redefineHandler(node);

    const name = node.fn.name;
    const slot = this.env.slot(name);
    if (!slot) throw pedagError('NameError', `'${name}' is not defined, so there is nothing to redefine`, node.line);

    const previous = slot.value;
    if (!(previous instanceof PedagFunction)) {
      throw pedagError('TypeError', `'${name}' is ${withArticle(previous)}, not a function`, node.line);
    }

    if (node.fn.params.length !== previous.decl.params.length) {
      throw pedagError('RedefineError',
        `${name} takes ${previous.decl.params.length} argument${previous.decl.params.length === 1 ? '' : 's'}; the replacement takes ${node.fn.params.length}, which would break every call to it`, node.line);
    }

    const escalated = node.fn.needs.filter((c) => !previous.decl.needs.includes(c));
    if (escalated.length > 0) {
      throw pedagError('RedefineError',
        `the replacement asks for ${escalated.join(', ')}, which ${name} did not hold; a rewrite may drop capabilities, never add them`, node.line);
    }

    const races = analyze({ type: 'Program', body: [{ type: 'FnDecl', fn: node.fn, line: node.line }] })
      .filter((f) => f.kind === 'race');
    if (races.length > 0) {
      throw pedagError('RedefineError',
        `the replacement has a race: ${races[0].message}`, node.line);
    }

    // Inherit the original's promises, then add any the replacement makes.
    const merged = {
      ...node.fn,
      requires: [...previous.decl.requires, ...node.fn.requires],
      ensures: [...previous.decl.ensures, ...node.fn.ensures],
    };
    const candidate = new PedagFunction(merged, this.globals);

    // Install, then test. Installing first means a recursive replacement is
    // checked as itself rather than against the version it is replacing.
    slot.value = candidate;
    try {
      if (merged.requires.length > 0 || merged.ensures.length > 0) {
        const report = exercise(this, name, candidate, new Rng(this.seed ^ 0x9e3779b9), 60);
        const bad = report.violations[0] ?? report.crashes[0];
        if (bad) {
          // Covers both directions: a promise inherited from the original that
          // the rewrite no longer keeps, and a promise the rewrite made itself.
          throw pedagError('RedefineError',
            `the replacement does not keep the contract ${name} would run under: ${name}(${bad.args}) -> ${bad.message}`, node.line);
        }
      }
    } catch (e) {
      slot.value = previous;             // nothing else ever saw the candidate
      throw e;
    }

    this.versions.set(name, [...(this.versions.get(name) ?? [previous]), candidate]);
    this.graph.define(name, node.fn);
    const affected = this.graph.dependents(name);
    this.trace.redefinitions.push({ line: node.line, name, affected });
    return affected;
  }

  redefineHandler(node) {
    const template = unwrap(this.env.get(node.agentName, node.line));
    if (!(template instanceof AgentTemplate)) {
      throw pedagError('TypeError', `'${node.agentName}' is ${withArticle(template)}, not an agent`, node.line);
    }
    const existing = template.handlers.get(node.message);
    if (!existing) {
      throw pedagError('RedefineError',
        `agent ${node.agentName} has no '${node.message}' handler to replace`, node.line);
    }
    if (existing.params.length !== node.params.length) {
      throw pedagError('RedefineError',
        `${node.agentName}.${node.message} takes ${existing.params.length} argument${existing.params.length === 1 ? '' : 's'}; the replacement takes ${node.params.length}`, node.line);
    }
    // Live agents share the template, so this reaches them immediately -- with
    // every one of them keeping the state it already had.
    template.handlers.set(node.message, { params: node.params, body: node.body, line: node.line });
    this.trace.redefinitions.push({ line: node.line, name: `${node.agentName}.${node.message}`, affected: [] });
    return this.scheduler.agents.filter((a) => a.template === template).length;
  }

  rollback(name, line) {
    const history = this.versions.get(name);
    if (!history || history.length < 2) {
      throw pedagError('RedefineError', `'${name}' has no earlier version to go back to`, line);
    }
    history.pop();
    const slot = this.env.slot(name);
    slot.value = history[history.length - 1];
    this.graph.define(name, slot.value.decl);
    return history.length;
  }

  // --- devices -------------------------------------------------------------

  // `@` routed through whichever backend is active. The reshaping rules are
  // the tensor's; only the inner loop's location changes.
  matmulVia(x, y, line) {
    let a = x;
    let b = y;
    const squeezeA = a.rank === 1;
    const squeezeB = b.rank === 1;
    if (squeezeA) a = a.reshape([1, a.shape[0]]);
    if (squeezeB) b = b.reshape([b.shape[0], 1]);
    if (a.rank !== 2 || b.rank !== 2) {
      throw pedagError('ShapeError', '@ needs rank-1 or rank-2 tensors on both sides', line);
    }
    const [m, k] = a.shape;
    const [k2, n] = b.shape;
    if (k !== k2) {
      throw pedagError('ShapeError',
        `cannot multiply [${x.shape.join(', ')}] @ [${y.shape.join(', ')}]: inner sizes ${k} and ${k2} differ`, line);
    }
    this.cost.tensorOps += m * k * n;
    const out = this.devices.matmul(a.data, b.data, m, k, n, line);
    let shape = [m, n];
    if (squeezeA && squeezeB) shape = [];
    else if (squeezeA) shape = [n];
    else if (squeezeB) shape = [m];
    return new Tensor(out, shape);
  }

  // A record's invariant holds at every moment one is observable: after it is
  // built, and after `.with()` produces a new one. There is no window in which
  // a record exists having broken its own promise.
  checkRecordInvariants(record, line) {
    const type = record.type;
    if (!type.invariants || type.invariants.length === 0) return;
    const env = new Env(type.closure ?? this.globals);
    type.fields.forEach((f, i) => env.declare(f, record.values[i], false, line));
    env.declare('self', record, false, line);

    const saved = this.env;
    this.env = env;
    try {
      for (const c of type.invariants) {
        this.trace.contracts += 1;
        if (!truthy(this.contractValue(c.expr))) {
          throw pedagError('ContractError',
            `\`${type.name}\` requires \`${c.src}\`, and ${stringify(record, 1)} does not satisfy it`, line)
            .withLabel('invariant broken');
        }
      }
    } finally {
      this.env = saved;
    }
  }

  // --- old() ---------------------------------------------------------------
  //
  // Evaluate every `old(...)` appearing in a postcondition against the state on
  // the way in, keyed by the syntax node so the same call site gets the same
  // captured value back. Without it a postcondition can only talk about the
  // result, and "the balance went down by the amount withdrawn" is not
  // expressible.
  captureOldValues(decl, env) {
    if (decl.oldNodes === undefined) {
      const found = [];
      const scan = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach(scan); return; }
        if (n.type === 'Call' && n.callee.type === 'Ident' && n.callee.name === 'old') {
          if (n.args.length !== 1) {
            throw pedagError('ContractError', 'old() takes exactly one expression', n.line);
          }
          found.push(n);
        }
        for (const v of Object.values(n)) if (v && typeof v === 'object') scan(v);
      };
      for (const c of decl.ensures) scan(c.expr);
      decl.oldNodes = found;
    }
    if (decl.oldNodes.length === 0) return null;

    const captured = new Map();
    const saved = this.env;
    this.env = env;
    try {
      for (const n of decl.oldNodes) captured.set(n, this.evaluate(n.args[0]));
    } finally {
      this.env = saved;
    }
    return captured;
  }

  // --- loop contracts ------------------------------------------------------
  //
  // Eiffel's loop discipline, checked at runtime. The invariant states what
  // stays true across the whole loop; the variant is the termination argument.
  // A loop that spins forever fails on its variant with the two values that
  // did not decrease, which is a far better report than a timeout.

  beginLoopContracts(node) {
    if (!node.variant && (!node.invariants || node.invariants.length === 0)) return null;
    this.checkLoopInvariants(node, 'before the loop');
    return { previous: null, passes: 0 };
  }

  checkLoopInvariants(node, when) {
    if (!node.invariants || node.invariants.length === 0) return;
    for (const c of node.invariants) {
      this.trace.contracts += 1;
      if (!truthy(this.contractValue(c.expr))) {
        throw pedagError('LoopError',
          `the loop invariant \`${c.src}\` does not hold ${when}`, c.line)
          .at(c.expr.span)
          .withLabel('invariant broken');
      }
    }
  }

  stepLoopContracts(node, loop) {
    if (!loop) return;
    this.checkLoopInvariants(node, 'at the top of a pass');
    if (!node.variant) return;

    const value = this.evaluate(node.variant.expr);
    const current = this.asNumber(unwrap(value), `the loop variant \`${node.variant.src}\``, node.variant.line);

    if (current < 0) {
      throw pedagError('LoopError',
        `the loop variant \`${node.variant.src}\` went negative (${current}); a variant is what proves the loop ends, so it may not pass zero`,
        node.variant.line).at(node.variant.expr.span);
    }
    if (loop.previous !== null && current >= loop.previous) {
      throw pedagError('LoopError',
        `the loop variant \`${node.variant.src}\` did not decrease (${loop.previous} then ${current}) on pass ${loop.passes + 1}, so this loop is not making progress`,
        node.variant.line)
        .at(node.variant.expr.span)
        .withLabel('not decreasing')
        .help('the variant must strictly decrease on every pass and stay at or above zero');
    }
    loop.previous = current;
    loop.passes += 1;
  }

  // --- agents --------------------------------------------------------------

  // Inside a handler, an agent may write only what it owns. Everything else --
  // globals, an enclosing function's locals, another agent's state -- is
  // read-only. This is what makes "no shared mutable state" a guarantee rather
  // than a style rule.
  checkAgentWrite(name, line) {
    if (!this.agentBoundary) return;
    const owner = this.env.ownerOf(name);
    if (!owner) return;                    // undefined name: assign() reports it
    let env = this.env;
    while (env) {
      if (env === owner) return;
      if (env === this.agentBoundary) break;
      env = env.parent;
    }
    throw pedagError('AgentIsolationError',
      `an agent may only change its own state, and '${name}' belongs to the scope outside it`, line);
  }

  deliverMessage(agent, envelope, line) {
    const handler = agent.template.handlers.get(envelope.message);
    if (!handler) {
      throw pedagError('AgentError',
        `agent ${agent.template.name} has no handler for '${envelope.message}'`, line);
    }
    if (handler.params.length !== envelope.args.length) {
      throw pedagError('ArityError',
        `${agent.template.name}.${envelope.message} takes ${handler.params.length} argument${handler.params.length === 1 ? '' : 's'}, got ${envelope.args.length}`, handler.line);
    }

    const env = new Env(agent.env);
    for (let i = 0; i < handler.params.length; i++) {
      env.declare(handler.params[i], envelope.args[i], false, handler.line);
    }
    env.declare('self', agent, false, handler.line);
    env.declare('sender', envelope.from ?? null, false, handler.line);

    const savedBoundary = this.agentBoundary;
    this.agentBoundary = agent.env;
    try {
      this.execBlock(handler.body, env);
    } catch (e) {
      // A handler body is a function body: `return` ends it, and a stray
      // `break` must not travel back out into the dispatcher's loop.
      if (!(e instanceof ReturnSignal)) throw controlFlowEscape(e, handler.line) ?? e;
    } finally {
      this.agentBoundary = savedBoundary;
    }
  }

  // --- budgets -------------------------------------------------------------

  spendTokens(n) {
    for (const b of this.budgets) {
      if (b.kind !== 'tokens') continue;
      b.used += n;
      if (b.used > b.limit) throw new BudgetExceeded(b);
    }
    return n;
  }

  // Allocation, charged where a program actually grows something.
  //
  // `steps` bounds how long a program runs; `tokens` bounds what it puts into a
  // context window. Neither bounded memory, so `while true { xs.push(1) }` was
  // an unpatched way to take the process down: the loop makes progress, spends
  // its steps slowly, and exhausts the heap long before any other limit.
  //
  // The figure is a deterministic estimate of the bytes a value occupies, not a
  // reading from the host. That is deliberate — sampling real heap usage would
  // make the same program stop in a different place on each run and destroy
  // replay, which every other guarantee here depends on. An estimate that is
  // always the same is worth more than a measurement that is not.
  spendMemory(bytes) {
    this.allocated += bytes;
    if (!this.hasMemoryBudget) return bytes;
    for (const b of this.budgets) {
      if (b.kind !== 'memory') continue;
      b.used += bytes;
      if (b.used > b.limit) throw new BudgetExceeded(b);
    }
    return bytes;
  }

  // --- transactions and secrets -------------------------------------------

  enroll(ledger) {
    const txn = this.txnStack[this.txnStack.length - 1];
    if (!txn || txn.has(ledger)) return;
    ledger.begin();
    txn.add(ledger);
  }

  trackSecret(secret) {
    const scope = this.secretScopes[this.secretScopes.length - 1];
    if (scope) scope.push(secret);
    return secret;
  }

  // --- operators -----------------------------------------------------------

  // Arithmetic on encrypted values. `+` and `*` mean what they normally mean;
  // the runtime simply performs them without ever decrypting. Paillier is
  // additively homomorphic, so multiplying two ciphertexts is refused with an
  // explanation rather than silently producing nonsense.
  cipherBinary(op, l, r, line) {
    const bothCiphers = l instanceof Cipher && r instanceof Cipher;

    if (op === '==' || op === '!=') {
      throw pedagError('TypeError',
        'ciphertexts cannot be compared: two encryptions of the same value differ. Decrypt, or prove the relation instead', line);
    }

    if (bothCiphers) {
      if (l.n !== r.n) throw pedagError('TypeError', 'these ciphertexts belong to different keys', line);
      if (op === '+') return heAdd(l, r);
      if (op === '-') return heAdd(l, heMulPlain(r, -1n));
      if (op === '*') {
        throw pedagError('TypeError',
          'Paillier is additively homomorphic: a ciphertext can be added to a ciphertext, or multiplied by a plaintext, but not by another ciphertext', line);
      }
      throw pedagError('TypeError', `operator '${op}' is not defined on ciphertexts`, line);
    }

    const cipher = l instanceof Cipher ? l : r;
    const plainRaw = l instanceof Cipher ? r : l;
    if (typeof plainRaw !== 'number' || !Number.isInteger(plainRaw)) {
      throw pedagError('TypeError',
        `encrypted arithmetic needs a whole number on the other side, got ${typeName(plainRaw)}`, line);
    }
    const plain = BigInt(plainRaw);

    if (op === '+') return heAddPlain(cipher, plain);
    if (op === '-') {
      // c - k, and k - c (which negates the ciphertext first)
      return l instanceof Cipher
        ? heAddPlain(cipher, -plain)
        : heAddPlain(heMulPlain(cipher, -1n), plain);
    }
    if (op === '*') return heMulPlain(cipher, plain);
    throw pedagError('TypeError', `operator '${op}' is not defined on ciphertexts`, line);
  }

  binary(op, lv, rv, line) {
    // A labelled operand makes the result labelled, with the policies of both
    // sides joined. Combining data does not shed anyone's rules about it.
    if (lv instanceof Labelled || rv instanceof Labelled) {
      const raw = this.binary(op, stripLabel(lv), stripLabel(rv), line);
      return relabel(raw, lv, rv);
    }

    // Overwhelmingly the common case, and it must not pay for any of the
    // dispatch below. Division and remainder fall through when the divisor is
    // zero so the slow path can raise properly.
    if (typeof lv === 'number' && typeof rv === 'number') {
      switch (op) {
        case '+': return lv + rv;
        case '-': return lv - rv;
        case '*': return lv * rv;
        case '<': return lv < rv;
        case '>': return lv > rv;
        case '<=': return lv <= rv;
        case '>=': return lv >= rv;
        case '==': return lv === rv;
        case '!=': return lv !== rv;
        case '**': return lv ** rv;
        case '/': if (rv !== 0) return lv / rv; break;
        case '%': if (rv !== 0) return lv % rv; break;
        default: break;
      }
    }

    let l = unwrap(lv);
    let r = unwrap(rv);

    if (l instanceof Cipher || r instanceof Cipher) {
      return retaint(this.cipherBinary(op, l, r, line), lv, rv);
    }

    if (l instanceof Decimal || r instanceof Decimal) {
      return retaint(decimalBinary(op, l, r, line), lv, rv);
    }

    // A decaying value participates in arithmetic at its worth *now*. Use
    // .at(t) when a specific moment is meant.
    if (l instanceof Liquid) l = l.at(this.logicalTime);
    if (r instanceof Liquid) r = r.at(this.logicalTime);

    if (op === '==') return retaint(this.deepEquals(l, r), lv, rv);
    if (op === '!=') return retaint(!this.deepEquals(l, r), lv, rv);

    if (op === '@') {
      const a = this.toTensor(l, line);
      const b = this.toTensor(r, line);
      return retaint(this.matmulVia(a, b, line), lv, rv);
    }

    if (op === '+') {
      if (typeof l === 'string' || typeof r === 'string') {
        return retaint(stringify(l, 0) + stringify(r, 0), lv, rv);
      }
      if (Array.isArray(l) && Array.isArray(r)) return retaint([...l, ...r], lv, rv);
      if (l instanceof ContextWindow && typeof r === 'string') {
        throw pedagError('TypeError', 'use ctx.push(text) to add to a context window', line);
      }
    }

    if (l instanceof Tensor || r instanceof Tensor) {
      const fn = {
        '+': (a, b) => a + b,
        '-': (a, b) => a - b,
        '*': (a, b) => a * b,
        '/': (a, b) => a / b,
        '%': (a, b) => a % b,
        '**': (a, b) => a ** b,
      }[op];
      if (!fn) throw pedagError('TypeError', `operator '${op}' is not defined on tensors`, line);
      const a = this.toTensor(l, line);
      const b = this.toTensor(r, line);
      return retaint(a.zip(b, fn, line), lv, rv);
    }

    if (['<', '<=', '>', '>='].includes(op)) {
      if (typeof l === 'string' && typeof r === 'string') {
        const cmp = l < r ? -1 : l > r ? 1 : 0;
        return retaint({ '<': cmp < 0, '<=': cmp <= 0, '>': cmp > 0, '>=': cmp >= 0 }[op], lv, rv);
      }
      const a = this.asNumber(l, `left side of '${op}'`, line);
      const b = this.asNumber(r, `right side of '${op}'`, line);
      return retaint({ '<': a < b, '<=': a <= b, '>': a > b, '>=': a >= b }[op], lv, rv);
    }

    const a = this.asNumber(l, `left side of '${op}'`, line);
    const b = this.asNumber(r, `right side of '${op}'`, line);
    switch (op) {
      case '+': return retaint(a + b, lv, rv);
      case '-': return retaint(a - b, lv, rv);
      case '*': return retaint(a * b, lv, rv);
      case '/':
        if (b === 0) throw pedagError('ZeroDivisionError', 'division by zero', line);
        return retaint(a / b, lv, rv);
      case '%':
        if (b === 0) throw pedagError('ZeroDivisionError', 'remainder by zero', line);
        return retaint(a % b, lv, rv);
      case '**': return retaint(a ** b, lv, rv);
      default:
        throw pedagError('InternalError', `unknown operator '${op}'`, line);
    }
  }

  deepEquals(a, b) {
    // Records compare by their contents, not their identity. Two points at the
    // same coordinates are the same point.
    if (a instanceof RecordValue && b instanceof RecordValue) {
      return recordsEqual(a, b, (x, y) => this.deepEquals(x, y));
    }
    if (a instanceof Tensor && b instanceof Tensor) return a.equals(b);
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every((x, i) => this.deepEquals(unwrap(x), unwrap(b[i])));
    }
    if (a instanceof Map && b instanceof Map) {
      if (a.size !== b.size) return false;
      for (const [k, v] of a) {
        if (!b.has(k) || !this.deepEquals(unwrap(v), unwrap(b.get(k)))) return false;
      }
      return true;
    }
    return a === b;
  }

  // --- indexing and members ------------------------------------------------

  index(obj, idx, line) {
    if (obj instanceof Tensor) return obj.at(idx, line);

    if (idx.length !== 1) {
      throw pedagError('TypeError', `${withArticle(obj)} takes one index, got ${idx.length}`, line);
    }
    const k = idx[0];

    // Fast paths for the two shapes indexing is actually used on.
    if (obj instanceof Map) {
      const key = typeof k === 'string' ? k : String(k);
      const hit = obj.get(key);
      if (hit !== undefined || obj.has(key)) return hit;
      throw pedagError('KeyError', `map has no key '${key}'`, line);
    }
    if (Array.isArray(obj) && typeof k === 'number' && k >= 0 && k < obj.length && Number.isInteger(k)) {
      return obj[k];
    }

    if (Array.isArray(obj)) {
      let i = Math.trunc(this.asNumber(k, 'a list index', line));
      if (i < 0) i += obj.length;
      if (i < 0 || i >= obj.length) {
        throw pedagError('IndexError', `list index ${k} out of range (length ${obj.length})`, line);
      }
      return obj[i];
    }

    if (typeof obj === 'string') {
      let i = Math.trunc(this.asNumber(k, 'a string index', line));
      if (i < 0) i += obj.length;
      if (i < 0 || i >= obj.length) {
        throw pedagError('IndexError', `string index ${k} out of range (length ${obj.length})`, line);
      }
      return obj[i];
    }

    if (obj instanceof Map) {
      const key = String(k);
      if (!obj.has(key)) throw pedagError('KeyError', `map has no key '${key}'`, line);
      return obj.get(key);
    }

    throw pedagError('TypeError', `${withArticle(obj)} cannot be indexed`, line);
  }

  native(name, arity, fn, needs = []) {
    return new NativeFunction(name, arity, fn, needs);
  }

  // Method access, with the bound method remembered.
  //
  // `xs.push(1)` used to build a fresh NativeFunction, and a closure over `xs`
  // to go inside it, every single time -- two allocations per push, and the
  // call site's inline cache never hit because the callee was a different
  // object on every call.
  //
  // The methods of a given value do not change, and each one closes over that
  // value, so the built one is kept against the object it belongs to. The cache
  // is weak: it holds nothing alive that the program has finished with.
  //
  // Only functions are cached. A member that is a plain value -- `.tokens` on a
  // context window, `.shape` on a tensor -- is recomputed every time, because
  // those do change.
  member(obj, name, line) {
    if (obj === null || typeof obj !== 'object') return this.memberOf(obj, name, line);
    // A record's members are its fields, which are values rather than methods,
    // and a record is usually a fresh object each time -- so the cache would
    // never hit and every field access would pay a lookup to find that out.
    if (obj instanceof RecordValue) return this.memberOf(obj, name, line);

    let byName = this.methodCache.get(obj);
    if (byName !== undefined) {
      const hit = byName.get(name);
      if (hit !== undefined) return hit;
    }

    const value = this.memberOf(obj, name, line);
    if (value instanceof NativeFunction) {
      if (byName === undefined) {
        byName = new Map();
        this.methodCache.set(obj, byName);
      }
      byName.set(name, value);
    }
    return value;
  }

  memberOf(obj, name, line) {
    const nf = (n, arity, fn) => new NativeFunction(n, arity, fn);

    // A record's fields, first. `p.x` otherwise fell through every branch below
    // to `pedagMembers`, which builds an object holding every field and a bound
    // `with` -- allocated and thrown away on each field access.
    if (obj instanceof RecordValue) {
      const i = obj.type.fields.indexOf(name);
      if (i !== -1) return obj.values[i];
    }

    if (obj instanceof Tensor) {
      switch (name) {
        case 'shape': return obj.shape.slice();
        case 'rank': return obj.rank;
        case 'size': return obj.size;
        case 'T': return obj.transpose(line);
        case 'sum': return nf('sum', 0, () => obj.sum());
        case 'mean': return nf('mean', 0, () => obj.mean());
        case 'max': return nf('max', 0, () => obj.max());
        case 'min': return nf('min', 0, () => obj.min());
        case 'norm': return nf('norm', 0, () => obj.norm());
        case 'tolist': return nf('tolist', 0, () => obj.toNested());
        case 'reshape': return nf('reshape', 1, (a, l) => obj.reshape(this.toShape(unwrap(a[0]), l), l));
        case 'map': return nf('map', 1, (a, l) => obj.map((x) => this.asNumber(unwrap(this.callValue(unwrap(a[0]), [x], l)), 'the result of a tensor map', l)));
        default: break;
      }
    }

    if (typeof obj === 'string') {
      switch (name) {
        case 'len': return nf('len', 0, () => obj.length);
        case 'upper': return nf('upper', 0, () => obj.toUpperCase());
        case 'lower': return nf('lower', 0, () => obj.toLowerCase());
        case 'trim': return nf('trim', 0, () => obj.trim());
        case 'split': return nf('split', 1, (a) => obj.split(String(unwrap(a[0]))));
        case 'contains': return nf('contains', 1, (a) => obj.includes(String(unwrap(a[0]))));
        case 'starts': return nf('starts', 1, (a) => obj.startsWith(String(unwrap(a[0]))));
        case 'ends': return nf('ends', 1, (a) => obj.endsWith(String(unwrap(a[0]))));
        case 'replace': return nf('replace', 2, (a) => obj.split(String(unwrap(a[0]))).join(String(unwrap(a[1]))));
        case 'slice': return nf('slice', -1, (a, l) => obj.slice(...this.sliceBounds(a, l)));
        case 'tokens': return nf('tokens', 0, () => countTokens(obj));
        default: break;
      }
    }

    if (Array.isArray(obj)) {
      switch (name) {
        case 'len': return nf('len', 0, () => obj.length);
        case 'push': return nf('push', 1, (a, l) => {
          assertMutable(obj, 'this list', l, pedagError);
          this.spendMemory(8);
          obj.push(a[0]);
          return obj;
        });
        case 'pop': return nf('pop', 0, (_a, l) => {
          assertMutable(obj, 'this list', l, pedagError);
          if (obj.length === 0) throw pedagError('IndexError', 'pop from an empty list', l);
          return obj.pop();
        });
        case 'slice': return nf('slice', -1, (a, l) => obj.slice(...this.sliceBounds(a, l)));
        case 'join': return nf('join', 1, (a) => obj.map((x) => stringify(unwrap(x), 0)).join(String(unwrap(a[0]))));
        case 'contains': return nf('contains', 1, (a) => obj.some((x) => this.deepEquals(unwrap(x), unwrap(a[0]))));
        case 'map': return nf('map', 1, (a, l) => obj.map((x, i) => this.callValue(unwrap(a[0]), unwrap(a[0]).decl?.params.length === 2 ? [x, i] : [x], l)));
        case 'filter': return nf('filter', 1, (a, l) => obj.filter((x) => truthy(this.callValue(unwrap(a[0]), [x], l))));
        case 'reduce': return nf('reduce', 2, (a, l) => obj.reduce((acc, x) => this.callValue(unwrap(a[0]), [acc, x], l), a[1]));
        case 'sum': return nf('sum', 0, (_a, l) => obj.reduce((acc, x) => acc + this.asNumber(unwrap(x), 'a list element', l), 0));
        case 'sort': return nf('sort', 0, () => [...obj].sort((x, y) => {
          const a = unwrap(x); const b = unwrap(y);
          if (typeof a === 'number' && typeof b === 'number') return a - b;
          return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
        }));
        case 'reverse': return nf('reverse', 0, () => [...obj].reverse());
        default: break;
      }
    }

    if (obj instanceof Map) {
      switch (name) {
        case 'len': return nf('len', 0, () => obj.size);
        case 'keys': return nf('keys', 0, () => [...obj.keys()]);
        case 'values': return nf('values', 0, () => [...obj.values()]);
        case 'has': return nf('has', 1, (a) => obj.has(String(unwrap(a[0]))));
        case 'get': return nf('get', -1, (a) => (obj.has(String(unwrap(a[0]))) ? obj.get(String(unwrap(a[0]))) : (a.length > 1 ? a[1] : null)));
        case 'set': return nf('set', 2, (a, l) => {
          assertMutable(obj, 'this map', l, pedagError);
          this.spendMemory(48);
          obj.set(String(unwrap(a[0])), a[1]);
          return obj;
        });
        case 'remove': return nf('remove', 1, (a, l) => {
          assertMutable(obj, 'this map', l, pedagError);
          return obj.delete(String(unwrap(a[0])));
        });
        default:
          if (obj.has(name)) return obj.get(name);
          break;
      }
    }

    if (obj instanceof ContextWindow) {
      switch (name) {
        case 'tokens': return obj.tokens;
        case 'budget': return obj.budget;
        case 'len': return nf('len', 0, () => obj.length);
        case 'evicted': return obj.evicted;
        case 'push': return nf('push', 1, (a) => {
          const text = stringify(unwrap(a[0]), 0);
          this.cost.tokens += this.spendTokens(countTokens(text));
          return obj.push(text, false);
        });
        case 'pin': return nf('pin', 1, (a) => {
          const text = stringify(unwrap(a[0]), 0);
          this.cost.tokens += this.spendTokens(countTokens(text));
          return obj.push(text, true);
        });
        case 'text': return nf('text', 0, () => obj.text());
        case 'clear': return nf('clear', 0, () => obj.clear());
        default: break;
      }
    }

    if (obj instanceof Ledger) {
      switch (name) {
        case 'len': return nf('len', 0, () => obj.length);
        case 'head': return obj.head;
        case 'append': return nf('append', 1, (a) => {
          this.enroll(obj);           // no-op unless an `atomic` block is open
          return obj.append(unwrap(a[0]));
        });
        case 'verify': return nf('verify', 0, () => obj.verify());
        case 'entries': return nf('entries', 0, () => obj.entries.map((e) => {
          const m = new Map();
          m.set('index', e.index);
          m.set('payload', e.payload);
          m.set('hash', e.hash);
          return m;
        }));
        default: break;
      }
    }

    if (obj instanceof PedagFunction || obj instanceof NativeFunction) {
      if (name === 'name') return obj.name;
      if (name === 'needs') return [...(obj.needs ?? obj.decl?.needs ?? [])];
    }

    // Types contributed by later layers expose their own members, so this
    // dispatcher does not grow a case for every one of them.
    if (obj && typeof obj.pedagMembers === 'function') {
      const members = obj.pedagMembers(this, line);
      if (Object.prototype.hasOwnProperty.call(members, name)) return members[name];
    }

    throw pedagError('AttributeError', `${withArticle(obj)} has no '${name}'`, line);
  }

  // slice(n) takes from n to the end; slice(a, b) takes a range. Negative
  // indices count back from the end, as they do everywhere else in the language.
  sliceBounds(args, line) {
    if (args.length < 1 || args.length > 2) {
      throw pedagError('ArityError', `slice takes 1 or 2 arguments, got ${args.length}`, line);
    }
    const start = Math.trunc(this.asNumber(unwrap(args[0]), 'a slice start', line));
    if (args.length === 1) return [start];
    return [start, Math.trunc(this.asNumber(unwrap(args[1]), 'a slice end', line))];
  }

  // --- coercions -----------------------------------------------------------

  asNumber(v, what, line) {
    const u = unwrap(v);
    if (typeof u !== 'number' || Number.isNaN(u)) {
      throw pedagError('TypeError', `${what} must be a num, got ${typeName(u)}`, line);
    }
    return u;
  }

  toTensor(v, line) {
    const u = unwrap(v);
    if (u instanceof Tensor) return u;
    if (typeof u === 'number') return Tensor.scalar(u);
    if (Array.isArray(u)) return Tensor.fromNested(this.plainNested(u, line), line);
    throw pedagError('TypeError', `cannot use ${withArticle(u)} as a tensor`, line);
  }

  plainNested(v, line) {
    const u = unwrap(v);
    if (Array.isArray(u)) return u.map((x) => this.plainNested(x, line));
    if (typeof u === 'number') return u;
    if (u instanceof Tensor) return u.toNested();
    throw pedagError('ShapeError', `tensor elements must be nums, found ${typeName(u)}`, line);
  }

  toShape(v, line) {
    const u = unwrap(v);
    if (typeof u === 'number') return [Math.trunc(u)];
    if (Array.isArray(u)) return u.map((x) => Math.trunc(this.asNumber(unwrap(x), 'a shape entry', line)));
    throw pedagError('TypeError', `a shape must be a num or a list of nums, got ${typeName(u)}`, line);
  }

  toIterable(v, line) {
    const u = unwrap(v);
    if (Array.isArray(u)) return u;
    if (typeof u === 'string') return [...u];
    if (u instanceof Map) return [...u.keys()];
    if (u instanceof Tensor) return Array.from(u.data);
    throw pedagError('TypeError', `${withArticle(u)} cannot be looped over`, line);
  }
}
