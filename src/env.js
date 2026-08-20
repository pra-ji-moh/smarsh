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
// Anything that changes a scope's shape must bump this. That is why the raw
// operations are methods here rather than callers reaching into the storage.
export const EPOCH = { v: 0 };

// Below this many bindings a scope stores names and slots in two parallel
// arrays and looks them up by scanning. Above it, a Map.
//
// A call frame holds one binding per parameter -- usually one or two -- and a
// Map is the wrong shape for that: allocating one, hashing into it and
// collecting it afterwards cost more than scanning two entries. Profiling
// fib(29) put Env construction, `declare`, `slot` and the collector at 21% of
// runtime between them, nearly all of it in frames holding a single name.
//
// Eight is where a linear scan stops being obviously cheaper than a hash. It is
// also comfortably above the arity of any reasonable function, so frames stay
// on the fast path and only larger scopes -- module tops, the prelude -- pay
// for a Map.
const SMALL = 8;

export class Env {
  constructor(parent = null) {
    this.parent = parent;
    // Exactly one of these is in use. `_map` is null until the scope grows past
    // SMALL or something asks for the Map view.
    this._names = null;
    this._slots = null;
    this._map = null;
    // True while `_names` is the declaration's own array, borrowed rather than
    // owned. Any write copies it first.
    this._sharedNames = false;
  }

  // The Map view, for the code that iterates a scope -- the module loader, the
  // snapshotter, `pedag test` looking for `test_*`, the "did you mean" search.
  // Asking for it converts the scope permanently, which is fine: nothing that
  // wants to iterate a scope is in a hot path, and mixing the two
  // representations would be a bug waiting to happen.
  get vars() {
    if (this._map === null) {
      const m = new Map();
      if (this._names !== null) {
        for (let i = 0; i < this._names.length; i++) m.set(this._names[i], this._slots[i]);
      }
      this._map = m;
      this._names = null;
      this._slots = null;
      this._sharedNames = false;
    }
    return this._map;
  }

  // True without converting the scope, so the hot paths can ask.
  has(name) {
    if (this._map !== null) return this._map.has(name);
    return this._names !== null && this._names.indexOf(name) !== -1;
  }

  own(name) {
    if (this._map !== null) return this._map.get(name);
    if (this._names === null) return undefined;
    const i = this._names.indexOf(name);
    return i === -1 ? undefined : this._slots[i];
  }

  // Populate a brand-new call frame, without touching the epoch.
  //
  // `declare` has to bump it, because adding a name to a scope that already
  // exists can shadow a binding some cache resolved through it. A frame being
  // built for a call is different: nothing has looked anything up through it
  // yet, because it did not exist a moment ago and execution has not entered
  // it. No cache anywhere can be referring to it, so populating it cannot
  // invalidate one.
  //
  // This matters more than it sounds. Every call declared one binding per
  // parameter, so every call bumped the epoch and dropped every inline cache in
  // the program -- recursive code spent its life re-resolving names it had
  // already resolved.
  //
  // The names array is shared with the declaration rather than copied, since
  // every call to the same function binds the same names. It is copied only if
  // the body later declares something, which `putSlot` handles.
  adoptFrame(names, slots) {
    this._names = names;
    this._slots = slots;
    this._sharedNames = true;
  }

  declare(name, value, mutable, line) {
    if (this.has(name)) {
      throw pedagError('NameError', `'${name}' is already declared in this scope`, line);
    }
    this.putSlot(name, { value, mutable });
  }

  // Loops reuse one scope across passes rather than allocating per iteration;
  // emptying it changes shape, so caches must go.
  clearVars() {
    if (this._map !== null) {
      if (this._map.size !== 0) { this._map.clear(); EPOCH.v++; }
      return;
    }
    if (this._names !== null && this._names.length !== 0) {
      if (this._sharedNames) { this._names = []; this._sharedNames = false; } else this._names.length = 0;
      this._slots.length = 0;
      EPOCH.v++;
    }
  }

  putSlot(name, slot) {
    if (this._map !== null) {
      this._map.set(name, slot);
      EPOCH.v++;
      return;
    }
    if (this._names === null) { this._names = []; this._slots = []; }
    else if (this._sharedNames) { this._names = this._names.slice(); this._sharedNames = false; }
    const i = this._names.indexOf(name);
    if (i !== -1) { this._slots[i] = slot; EPOCH.v++; return; }
    if (this._names.length >= SMALL) {
      // Convert, then set: past this size a scan is no longer the cheaper one.
      this.vars.set(name, slot);
      EPOCH.v++;
      return;
    }
    this._names.push(name);
    this._slots.push(slot);
    EPOCH.v++;
  }

  deleteVar(name) {
    if (this._map !== null) {
      if (this._map.delete(name)) EPOCH.v++;
      return;
    }
    if (this._names === null) return;
    const i = this._names.indexOf(name);
    if (i === -1) return;
    if (this._sharedNames) { this._names = this._names.slice(); this._sharedNames = false; }
    this._names.splice(i, 1);
    this._slots.splice(i, 1);
    EPOCH.v++;
  }

  slot(name) {
    let env = this;
    while (env !== null) {
      const map = env._map;
      if (map !== null) {
        const s = map.get(name);
        if (s !== undefined) return s;
      } else {
        const names = env._names;
        if (names !== null) {
          for (let i = 0; i < names.length; i++) {
            if (names[i] === name) return env._slots[i];
          }
        }
      }
      env = env.parent;
    }
    return null;
  }

  // Which scope actually holds this name. Agent isolation needs to know.
  ownerOf(name) {
    let env = this;
    while (env !== null) {
      if (env.has(name)) return env;
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
