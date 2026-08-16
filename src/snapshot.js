import { Tensor } from './tensor.js';
import {
  ContextWindow, Ledger, Tainted, PedagFunction, NativeFunction, unwrap, countTokens,
} from './values.js';
import { Env } from './env.js';
import { Liquid, LogicalClock, Stamp } from './temporal.js';
import { AgentRef, AgentTemplate } from './agents.js';
import { pedagError } from './errors.js';

// Moving a running program's state somewhere else.
//
// What travels: every global whose value is data -- numbers, text, lists, maps,
// tensors, context windows, ledgers, clocks, decaying values, provenance labels
// -- plus logical time, the random stream's exact position, and every live
// agent with its private state and its undelivered mail.
//
// What does not travel: code. The receiving side runs the same program; the
// snapshot carries what the program had *become*, not what it is. That is a
// real constraint and it is stated rather than papered over: restore() into a
// different program will refuse when it cannot find a matching agent template.
//
// Anything it cannot carry (open file descriptors, worker pools, secrets, keys)
// is listed in `skipped` instead of being silently dropped. A migration that
// quietly loses state is worse than one that says what it left behind.

const VERSION = 1;

function encode(value, skipped, path) {
  const v = value;

  if (v instanceof Tainted) {
    return { t: 'tainted', labels: [...v.labels], v: encode(v.value, skipped, path) };
  }
  if (v === null || v === undefined) return { t: 'nil' };
  if (typeof v === 'number') return { t: 'num', v };
  if (typeof v === 'string') return { t: 'str', v };
  if (typeof v === 'boolean') return { t: 'bool', v };

  if (Array.isArray(v)) {
    return { t: 'list', v: v.map((x, i) => encode(x, skipped, `${path}[${i}]`)) };
  }
  if (v instanceof Map) {
    return { t: 'map', v: [...v].map(([k, val]) => [k, encode(val, skipped, `${path}.${k}`)]) };
  }
  if (v instanceof Tensor) {
    return { t: 'tensor', shape: v.shape, v: Array.from(v.data) };
  }
  if (v instanceof ContextWindow) {
    return {
      t: 'context',
      budget: v.budget,
      policy: v.policy,
      evicted: v.evicted,
      entries: v.entries.map((e) => ({ text: e.text, pinned: e.pinned })),
    };
  }
  if (v instanceof Ledger) {
    return { t: 'ledger', name: v.name, head: v.head, entries: v.entries };
  }
  if (v instanceof Liquid) {
    return { t: 'liquid', initial: v.initial, halflife: v.halflife, anchor: v.anchor };
  }
  if (v instanceof LogicalClock) {
    return { t: 'clock', node: v.node, counter: v.counter };
  }
  if (v instanceof Stamp) {
    return { t: 'stamp', counter: v.counter, node: v.node };
  }
  if (v instanceof AgentRef) {
    return { t: 'agentref', id: v.id };
  }

  // Functions and agent templates come back with the program itself.
  if (v instanceof PedagFunction || v instanceof NativeFunction || v instanceof AgentTemplate) {
    return null;
  }

  skipped.push(`${path} (${v && v.pedagType ? v.pedagType : typeof v})`);
  return null;
}

function decode(node, agentsById, line) {
  if (node === null) return null;
  switch (node.t) {
    case 'nil': return null;
    case 'num': return node.v;
    case 'str': return node.v;
    case 'bool': return node.v;
    case 'list': return node.v.map((x) => decode(x, agentsById, line));
    case 'map': {
      const m = new Map();
      for (const [k, val] of node.v) m.set(k, decode(val, agentsById, line));
      return m;
    }
    case 'tainted': return new Tainted(decode(node.v, agentsById, line), node.labels);
    case 'tensor': return new Tensor(Float64Array.from(node.v), node.shape);
    case 'context': {
      const c = new ContextWindow(node.budget, node.policy);
      // Recount rather than trusting the wire.
      for (const e of node.entries) {
        c.entries.push({ text: e.text, tokens: countTokens(e.text), pinned: e.pinned });
      }
      c.evicted = node.evicted;
      return c;
    }
    case 'ledger': {
      const l = new Ledger(node.name);
      l.entries = node.entries;
      l.head = node.head;
      return l;
    }
    case 'liquid': return new Liquid(node.initial, node.halflife, node.anchor);
    case 'clock': {
      const c = new LogicalClock(node.node);
      c.counter = node.counter;
      return c;
    }
    case 'stamp': return new Stamp(node.counter, node.node);
    case 'agentref': {
      const ref = agentsById.get(node.id);
      if (!ref) throw pedagError('RestoreError', `the snapshot mentions agent #${node.id}, which is not in it`, line);
      return ref;
    }
    default:
      throw pedagError('RestoreError', `unknown value kind '${node.t}' in the snapshot`, line);
  }
}

export function snapshot(interp) {
  const skipped = [];
  const globals = {};
  for (const [name, slot] of interp.globals.vars) {
    const encoded = encode(slot.value, skipped, name);
    if (encoded === null) continue;
    globals[name] = { mutable: slot.mutable, value: encoded };
  }

  const agents = interp.scheduler.agents.map((a) => ({
    id: a.id,
    template: a.template.name,
    stopped: a.stopped,
    handled: a.handled,
    state: [...a.env.vars].map(([k, slot]) => [k, encode(slot.value, skipped, `${a.template.name}#${a.id}.${k}`)]),
    mailbox: a.mailbox.map((m) => ({
      message: m.message,
      args: m.args.map((x, i) => encode(x, skipped, `${a.template.name}#${a.id}.mail[${i}]`)),
      from: m.from ? m.from.id : null,
    })),
  }));

  return {
    version: VERSION,
    seed: interp.seed,
    rng: interp.rng.state,
    logicalTime: interp.logicalTime,
    nextAgentId: interp.scheduler.nextId,
    globals,
    agents,
    skipped,
  };
}

export function restore(interp, state, line = null) {
  if (!state || state.version !== VERSION) {
    throw pedagError('RestoreError',
      `this snapshot is version ${state ? state.version : 'unknown'}; this runtime reads version ${VERSION}`, line);
  }

  // Agents first, so references between them and from globals can be resolved.
  const agentsById = new Map();
  interp.scheduler.agents = [];
  for (const saved of state.agents) {
    const template = unwrap(interp.globals.slot(saved.template)?.value);
    if (!(template instanceof AgentTemplate)) {
      throw pedagError('RestoreError',
        `the snapshot holds a '${saved.template}' agent, but this program has no such agent`, line);
    }
    const env = new Env(interp.globals);
    const ref = new AgentRef(saved.id, template, env);
    ref.stopped = saved.stopped;
    ref.handled = saved.handled;
    interp.scheduler.agents.push(ref);
    agentsById.set(saved.id, ref);
  }

  for (const saved of state.agents) {
    const ref = agentsById.get(saved.id);
    for (const [k, encoded] of saved.state) {
      ref.env.putSlot(k, { value: decode(encoded, agentsById, line), mutable: true });
    }
    ref.mailbox = saved.mailbox.map((m) => ({
      message: m.message,
      args: m.args.map((x) => decode(x, agentsById, line)),
      from: m.from === null ? null : agentsById.get(m.from) ?? null,
    }));
  }

  for (const [name, saved] of Object.entries(state.globals)) {
    const value = decode(saved.value, agentsById, line);
    const slot = interp.globals.vars.get(name);
    if (slot) { slot.value = value; slot.mutable = saved.mutable; }
    else interp.globals.putSlot(name, { value, mutable: saved.mutable });
  }

  interp.scheduler.nextId = state.nextAgentId;
  interp.logicalTime = state.logicalTime;
  interp.rng.state = state.rng;
  return state.agents.length;
}
