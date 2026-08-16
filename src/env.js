import { pedagError } from './errors.js';

// A lexical scope. Its own module so that the interpreter and the snapshot
// layer can both build one without importing each other.

// Bumped whenever any scope anywhere gains, loses or rebinds a name.
//
// Compiled code caches the slot a variable resolved to, which is only sound
// while no scope has changed shape underneath it: adding a binding can shadow
// the one a cache is holding. Rather than track that per scope, any structural
// change invalidates every cache at once. Structural changes are rare and
// reads are not, so the trade is heavily in the right direction -- a loop body
// that declares nothing keeps its caches for the whole loop.
//
// Anything that mutates `vars` directly must bump this. That is why the raw
// operations have methods here instead of callers reaching into the Map.
export const EPOCH = { v: 0 };

export class Env {
  constructor(parent = null) {
    this.vars = new Map();
    this.parent = parent;
  }

  declare(name, value, mutable, line) {
    if (this.vars.has(name)) {
      throw pedagError('NameError', `'${name}' is already declared in this scope`, line);
    }
    this.vars.set(name, { value, mutable });
    EPOCH.v++;
  }

  // Loops reuse one scope across passes rather than allocating per iteration;
  // emptying it changes shape, so caches must go.
  clearVars() {
    if (this.vars.size !== 0) {
      this.vars.clear();
      EPOCH.v++;
    }
  }

  putSlot(name, slot) {
    this.vars.set(name, slot);
    EPOCH.v++;
  }

  deleteVar(name) {
    if (this.vars.delete(name)) EPOCH.v++;
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
    if (!s) throw pedagError('NameError', `'${name}' is not defined`, line);
    return s.value;
  }

  assign(name, value, line) {
    const s = this.slot(name);
    if (!s) throw pedagError('NameError', `'${name}' is not defined`, line);
    if (!s.mutable) {
      throw pedagError('ImmutableError',
        `'${name}' was declared with let and cannot be reassigned (use var if it must change)`, line);
    }
    s.value = value;
  }
}
