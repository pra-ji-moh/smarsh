import { pedagError } from './errors.js';

// A lexical scope. Its own module so that the interpreter and the snapshot
// layer can both build one without importing each other.

// Cache invalidation, per name.
//
// Compiled code caches the slot a name resolved to. That is only sound while no
// scope has gained a binding that could shadow it -- so something has to say
// when a cache has gone stale.
//
// This was one global counter that every declaration bumped, and it was far too
// blunt. A loop body containing `let d = ...` re-declares `d` on every pass, so
// every pass dropped every cache in the program: a loop that declared a local
// measured 5.9x slower than the same loop without one, because `t`, `g` and `i`
// were being re-resolved each iteration for no reason.
//
// Declaring `d` can only shadow a binding of `d`. So the counters are per name,
// and a compiled reference to `t` holds `t`'s counter and never notices `d`
// moving. The counter object is looked up once, when the reference is compiled,
// so checking it at run time is still one property load and one compare.
const VERSIONS = new Map();

export function versionOf(name) {
  let c = VERSIONS.get(name);
  if (c === undefined) { c = { v: 0 }; VERSIONS.set(name, c); }
  return c;
}

const bump = (name) => { versionOf(name).v += 1; };

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
    // Small scopes: three parallel arrays and a live count. The arrays are
    // never truncated -- emptying a scope sets `_count` to zero and leaves the
    // storage in place, so a loop that clears and refills its scope on every
    // pass does no array resizing and no allocation at all.
    this._names = null;
    this._slots = null;
    this._vers = null;    // the version counter for each name, held alongside
    this._count = 0;
    this._sharedNames = false;
    // Large scopes, or any scope something wants to iterate.
    this._map = null;
  }

  // The Map view, for the code that walks a scope -- the module loader, the
  // snapshotter, `pedag test` looking for `test_*`, the "did you mean" search.
  // Asking for it converts the scope permanently, which is fine: nothing that
  // iterates a scope is in a hot path, and maintaining both representations at
  // once would be a bug waiting to happen.
  get vars() {
    if (this._map === null) {
      const m = new Map();
      for (let i = 0; i < this._count; i++) m.set(this._names[i], this._slots[i]);
      this._map = m;
      this._names = null;
      this._slots = null;
      this._vers = null;
      this._count = 0;
      this._sharedNames = false;
    }
    return this._map;
  }

  // Answers without converting the scope, so the hot paths can ask.
  has(name) {
    if (this._map !== null) return this._map.has(name);
    for (let i = 0; i < this._count; i++) if (this._names[i] === name) return true;
    return false;
  }

  own(name) {
    if (this._map !== null) return this._map.get(name);
    for (let i = 0; i < this._count; i++) if (this._names[i] === name) return this._slots[i];
    return undefined;
  }

  // Populate a brand-new call frame, without bumping any version.
  //
  // `putSlot` has to bump, because adding a name to a scope that already exists
  // can shadow a binding some cache resolved through it. A frame being built
  // for a call is different: nothing has looked anything up through it, because
  // it did not exist a moment ago and execution has not entered it. No cache
  // can be referring to it, so populating it cannot invalidate one.
  //
  // Every call used to bump one version per parameter, which dropped the caches
  // for those names on every call in the program.
  //
  // The names array is borrowed from the declaration rather than copied, since
  // every call to a function binds the same names; `putSlot` copies it if the
  // body later declares something.
  adoptFrame(names, slots) {
    this._names = names;
    this._slots = slots;
    this._vers = null;
    this._count = names.length;
    this._sharedNames = true;
  }

  // Reuse a frame from a previous call at the same depth.
  //
  // A call allocated an Env, a slots array, and one slot object per parameter.
  // None of it can outlive the call when the body creates no closure, because
  // nothing else can be holding a reference to a scope that only that call
  // could see. So the whole frame is kept and written over next time --
  // recursion and tight call loops then allocate nothing at all.
  //
  // The body may have declared names of its own into the frame; those are
  // dropped, and their versions bumped, because the next call must not see the
  // last one's locals.
  reuseFrame(names, args) {
    const arity = names.length;
    if (this._count > arity) {
      // Locals the last call left behind.
      if (this._vers !== null) {
        for (let i = arity; i < this._count; i++) this._vers[i].v += 1;
      } else {
        for (let i = arity; i < this._count; i++) bump(this._names[i]);
      }
    }
    if (!this._sharedNames) {
      // The body copied the names array in order to add to it; put the
      // declaration's own back.
      this._names = names;
      this._vers = null;
      this._sharedNames = true;
    }
    const slots = this._slots;
    for (let i = 0; i < arity; i++) slots[i].value = args[i];
    this._count = arity;
  }

  // Reuse a frame, taking the arguments positionally rather than from an
  // array. A call site that knows its own argument count can evaluate them
  // into JavaScript locals and hand them straight over, so the array a call
  // used to build is never allocated. Four covers essentially every hot
  // function; beyond that the array path is used.
  reuseFrameArgs(names, argc, a0, a1, a2, a3) {
    const arity = names.length;
    if (this._count > arity) {
      if (this._vers !== null) {
        for (let i = arity; i < this._count; i++) this._vers[i].v += 1;
      } else {
        for (let i = arity; i < this._count; i++) bump(this._names[i]);
      }
    }
    if (!this._sharedNames) {
      this._names = names;
      this._vers = null;
      this._sharedNames = true;
    }
    const slots = this._slots;
    if (argc > 0) slots[0].value = a0;
    if (argc > 1) slots[1].value = a1;
    if (argc > 2) slots[2].value = a2;
    if (argc > 3) slots[3].value = a3;
    this._count = arity;
  }

  // Overwrite the single binding this scope holds, in place.
  //
  // Used for the scope that carries `result` into a postcondition. Writing the
  // slot rather than replacing it keeps a compiled postcondition's cache valid
  // -- the slot it resolved to is still the right one, and now has this call's
  // value in it.
  setOnlyValue(value) {
    this._slots[0].value = value;
  }

  // Can this frame be reused? Only if it still holds exactly the parameters it
  // was built with, in the same storage -- a frame that grew past SMALL and
  // converted to a Map, or that something asked to iterate, is not eligible.
  get reusable() {
    return this._map === null && this._slots !== null;
  }

  declare(name, value, mutable, line) {
    if (this.has(name)) {
      throw pedagError('NameError', `'${name}' is already declared in this scope`, line);
    }
    this.putSlot(name, { value, mutable });
  }

  // Loops reuse one scope across passes rather than allocating a new one, so
  // each pass has to start with the last pass's bindings gone. Setting the
  // count to zero does that: nothing scans past it, so nothing stale is
  // visible, and the storage stays put for the next pass to write over.
  clearVars() {
    if (this._map !== null) {
      if (this._map.size !== 0) {
        for (const name of this._map.keys()) bump(name);
        this._map.clear();
      }
      return;
    }
    if (this._count === 0) return;
    if (this._vers !== null) {
      for (let i = 0; i < this._count; i++) this._vers[i].v += 1;
    } else {
      for (let i = 0; i < this._count; i++) bump(this._names[i]);
    }
    this._count = 0;
  }

  putSlot(name, slot) {
    if (this._map !== null) {
      this._map.set(name, slot);
      bump(name);
      return;
    }
    if (this._names === null) {
      this._names = [];
      this._slots = [];
      this._vers = [];
    } else if (this._sharedNames) {
      // Borrowed from a declaration; take a copy before writing to it.
      this._names = this._names.slice(0, this._count);
      this._vers = this._names.map(versionOf);
      this._sharedNames = false;
    } else if (this._vers === null) {
      this._vers = [];
      for (let i = 0; i < this._count; i++) this._vers.push(versionOf(this._names[i]));
    }

    for (let i = 0; i < this._count; i++) {
      if (this._names[i] === name) {
        this._slots[i] = slot;
        this._vers[i].v += 1;
        return;
      }
    }

    if (this._count >= SMALL) {
      // Past this size a scan is no longer the cheaper one; convert and set.
      this.vars.set(name, slot);
      bump(name);
      return;
    }

    // Everything is indexed by the live count, never appended.
    //
    // The three arrays are not necessarily the same length: restoring a frame
    // puts back the declaration's own short names array while the slots array
    // still has room from a previous call. `push` then wrote a slot at the end
    // of a five-element array while its name went to index two, and a function
    // returned the previous call's answer -- caught by the standard library's
    // own tests, since both engines share this code and the differential
    // harness compares them against each other.
    const at = this._count;
    if (this._names[at] !== name || this._vers[at] === undefined) {
      // A different name than the last occupant of this position, so its
      // counter has to be looked up. When it is the same -- which it is, pass
      // after pass in a loop -- the counter is already here.
      this._names[at] = name;
      this._vers[at] = versionOf(name);
    }
    this._slots[at] = slot;
    this._vers[at].v += 1;
    this._count = at + 1;
  }

  deleteVar(name) {
    if (this._map !== null) {
      if (this._map.delete(name)) bump(name);
      return;
    }
    for (let i = 0; i < this._count; i++) {
      if (this._names[i] !== name) continue;
      if (this._sharedNames) {
        this._names = this._names.slice(0, this._count);
        this._vers = this._names.map(versionOf);
        this._sharedNames = false;
      } else if (this._vers === null) {
        this._vers = [];
        for (let k = 0; k < this._count; k++) this._vers.push(versionOf(this._names[k]));
      }
      // Splicing shifts everything, so trim the spare capacity first or the
      // three arrays come out of step.
      this._names.length = this._count;
      this._slots.length = this._count;
      this._vers.length = this._count;
      this._names.splice(i, 1);
      this._slots.splice(i, 1);
      this._vers.splice(i, 1);
      this._count -= 1;
      bump(name);
      return;
    }
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
        const n = env._count;
        for (let i = 0; i < n; i++) {
          if (names[i] === name) return env._slots[i];
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
