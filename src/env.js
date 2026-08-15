import { sarvmError } from './errors.js';

// A lexical scope. Its own module so that the interpreter and the snapshot
// layer can both build one without importing each other.

export class Env {
  constructor(parent = null) {
    this.vars = new Map();
    this.parent = parent;
  }

  declare(name, value, mutable, line) {
    if (this.vars.has(name)) {
      throw sarvmError('NameError', `'${name}' is already declared in this scope`, line);
    }
    this.vars.set(name, { value, mutable });
  }

  slot(name) {
    let env = this;
    while (env) {
      const s = env.vars.get(name);
      if (s) return s;
      env = env.parent;
    }
    return null;
  }

  // Which scope actually holds this name. Agent isolation needs to know.
  ownerOf(name) {
    let env = this;
    while (env) {
      if (env.vars.has(name)) return env;
      env = env.parent;
    }
    return null;
  }

  get(name, line) {
    const s = this.slot(name);
    if (!s) throw sarvmError('NameError', `'${name}' is not defined`, line);
    return s.value;
  }

  assign(name, value, line) {
    const s = this.slot(name);
    if (!s) throw sarvmError('NameError', `'${name}' is not defined`, line);
    if (!s.mutable) {
      throw sarvmError('ImmutableError',
        `'${name}' was declared with let and cannot be reassigned (use var if it must change)`, line);
    }
    s.value = value;
  }
}
