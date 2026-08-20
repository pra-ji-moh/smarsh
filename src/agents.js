import { NativeFunction } from './values.js';
import { pedagError } from './errors.js';

const nf = (name, arity, fn) => new NativeFunction(name, arity, fn);

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------
//
// An agent owns private state and a set of message handlers. The only way to
// affect one is to send it a message. Handlers may read the program's globals
// and call its functions, but assigning to anything outside the agent's own
// state is refused -- shared mutable state is the thing an actor model exists
// to remove, so the runtime enforces its absence rather than trusting to
// convention.
//
// Delivery is round-robin over agents in spawn order, one message per pass.
// That is fair, and it is deterministic: the same program with the same seed
// delivers the same messages in the same order every run.

export class AgentTemplate {
  constructor(name, stateDecls, handlers, line) {
    this.name = name;
    this.stateDecls = stateDecls;      // statements run once, at spawn
    this.handlers = handlers;          // Map<string, {params, body, line}>
    this.line = line;
  }
  get pedagType() { return 'agent_template'; }
  toString() { return `<agent template ${this.name} handling ${[...this.handlers.keys()].join(', ')}>`; }
}

export class AgentRef {
  constructor(id, template, env) {
    this.id = id;
    this.template = template;
    this.env = env;                    // this agent's private state
    this.mailbox = [];
    this.handled = 0;
    this.stopped = false;
  }
  get pedagType() { return 'agent'; }
  get name() { return this.template.name; }

  toString() {
    return `<agent ${this.template.name}#${this.id}${this.stopped ? ' stopped' : ''}, ${this.mailbox.length} queued>`;
  }

  pedagMembers() {
    return {
      id: this.id,
      name: this.template.name,
      stopped: this.stopped,
      inbox: nf('inbox', 0, () => this.mailbox.length),
      handled: nf('handled', 0, () => this.handled),
      // Reading another agent's state is allowed; writing it is not reachable
      // from anywhere in the language.
      state: nf('state', 1, (a, line) => {
        const key = String(a[0] && a[0].value !== undefined && a[0].labels ? a[0].value : a[0]);
        const slot = this.env.own(key);
        if (!slot) throw pedagError('NameError', `agent ${this.template.name} has no state '${key}'`, line);
        return slot.value;
      }),
      stop: nf('stop', 0, () => { this.stopped = true; return true; }),
    };
  }
}

export class Scheduler {
  constructor() {
    this.agents = [];
    this.nextId = 1;
    this.delivered = 0;
    this.sent = 0;
  }

  spawn(template, env) {
    const ref = new AgentRef(this.nextId++, template, env);
    this.agents.push(ref);
    return ref;
  }

  send(to, message, args, from) {
    if (to.stopped) return false;
    to.mailbox.push({ message, args, from });
    this.sent += 1;
    return true;
  }

  get pending() {
    return this.agents.reduce((n, a) => n + a.mailbox.length, 0);
  }

  // Drain every mailbox to quiescence. `deliver` runs one message and is
  // supplied by the interpreter, which owns the environments.
  run(deliver, maxMessages, line) {
    let processed = 0;
    for (;;) {
      let progressed = false;
      for (const agent of this.agents) {
        if (agent.stopped || agent.mailbox.length === 0) continue;
        const envelope = agent.mailbox.shift();
        deliver(agent, envelope);
        agent.handled += 1;
        this.delivered += 1;
        processed += 1;
        progressed = true;
        if (processed >= maxMessages) {
          throw pedagError('AgentError',
            `the agent system delivered ${processed} messages without settling; it is probably looping`, line);
        }
      }
      if (!progressed) return processed;
    }
  }
}
