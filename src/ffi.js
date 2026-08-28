import { createRequire } from 'node:module';
import path from 'node:path';

import { NativeFunction, Tainted, stringify, typeName, withArticle, unwrap } from './values.js';
import { Tensor } from './tensor.js';
import { smarshError } from './errors.js';

// Calling JavaScript from Smarsh.
//
// Nobody rewrites a working system to adopt a language, so a language that
// cannot call the code you already have is a language you cannot adopt. This is
// the bridge.
//
// It is a capability (`ffi`), not an ambient ability, and that is the whole
// design. Everything else in Smarsh is bounded — capabilities, taint, budgets —
// and a foreign call escapes all of it, because once control is inside
// JavaScript the runtime cannot see what it does. So the boundary is explicit,
// declared, and reported, rather than a quiet hole in the middle of the model.
//
// Values crossing the boundary are converted, never shared: a Smarsh list arrives
// in JavaScript as a fresh array, and mutating it does not reach back. Anything
// that comes back is converted the same way, and arrives labelled `untrusted`,
// because a foreign function's return value is exactly as trustworthy as
// anything else from outside the program.

const require = createRequire(import.meta.url);

export class ForeignModule {
  constructor(specifier, exports) {
    this.specifier = specifier;
    this.exports = exports;
  }
  get smarshType() { return 'foreign'; }
  toString() { return `<foreign ${this.specifier}>`; }

  // Members are converted on access, not up front. Host modules are full of
  // things that are expensive or impossible to convert eagerly -- `node:path`
  // refers to itself through `path.posix.posix` -- and none of that matters if
  // you only ever asked for `join`.
  smarshMembers(interp, line) {
    const out = {};
    for (const name of Object.keys(this.exports)) {
      Object.defineProperty(out, name, {
        enumerable: true,
        get: () => {
          const value = this.exports[name];
          return typeof value === 'function'
            ? wrapFunction(name, value, this.exports, interp)
            : toSmarsh(value, interp, line);
        },
      });
    }
    return out;
  }
}

function wrapFunction(name, fn, thisArg, interp) {
  return new NativeFunction(name, -1, (args, line) => {
    const plain = args.map((a) => toJs(a, line));
    let result;
    try {
      result = fn.apply(thisArg, plain);
    } catch (e) {
      throw smarshError('ForeignError', `\`${name}\` failed: ${e && e.message ? e.message : String(e)}`, line);
    }
    if (result && typeof result.then === 'function') {
      throw smarshError('ForeignError',
        `\`${name}\` returned a promise, and Smarsh has no way to wait for one`, line)
        .help('wrap it on the JavaScript side in a function that returns a settled value');
    }
    interp.trace.foreignCalls = (interp.trace.foreignCalls ?? 0) + 1;
    // Labelled on the way back in: the runtime could not watch what happened
    // in there, so it does not pretend the result is grounded.
    return new Tainted(toSmarsh(result, interp, line), ['untrusted']);
  });
}

// --- conversion --------------------------------------------------------------

export function toJs(value, line, seen = new Set()) {
  const v = unwrap(value);
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;

  if (Array.isArray(v)) {
    if (seen.has(v)) throw smarshError('ForeignError', 'this value contains itself and cannot cross the boundary', line);
    seen.add(v);
    const out = v.map((x) => toJs(x, line, seen));
    seen.delete(v);
    return out;
  }

  if (v instanceof Map) {
    if (seen.has(v)) throw smarshError('ForeignError', 'this value contains itself and cannot cross the boundary', line);
    seen.add(v);
    const out = {};
    for (const [k, val] of v) out[k] = toJs(val, line, seen);
    seen.delete(v);
    return out;
  }

  if (v instanceof Tensor) return v.toNested();

  // Records arrive as plain objects with a tag, which is what a JavaScript
  // caller can actually work with.
  if (v && v.type && v.values && typeof v.smarshType === 'string') {
    const out = { __record: v.type.name };
    v.type.fields.forEach((f, i) => { out[f] = toJs(v.values[i], line, seen); });
    return out;
  }

  throw smarshError('ForeignError',
    `${withArticle(v)} cannot cross into JavaScript`, line)
    .help('pass it as text, a list, or a map instead');
}

export function toSmarsh(value, interp, line, depth = 0, seen = new Map()) {
  if (depth > 32) return '<too deeply nested to convert>';
  if (value === null || value === undefined) return null;
  // Host objects refer to themselves more often than you would think. A cycle
  // becomes a marker rather than a stack overflow or a bogus error.
  if (typeof value === 'object' && seen.has(value)) return '<circular>';
  const t = typeof value;
  if (t === 'number' || t === 'string' || t === 'boolean') return value;
  if (t === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
      return value.toString();
    }
    return Number(value);
  }
  if (t === 'function') return wrapFunction(value.name || 'anonymous', value, undefined, interp);
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    seen.set(value, true);
    const out = value.map((x) => toSmarsh(x, interp, line, depth + 1, seen));
    seen.delete(value);
    return out;
  }
  if (value instanceof Map) {
    seen.set(value, true);
    const out = new Map();
    for (const [k, v] of value) out.set(String(k), toSmarsh(v, interp, line, depth + 1, seen));
    seen.delete(value);
    return out;
  }
  if (t === 'object') {
    seen.set(value, true);
    const out = new Map();
    for (const [k, v] of Object.entries(value)) out.set(k, toSmarsh(v, interp, line, depth + 1, seen));
    seen.delete(value);
    return out;
  }
  return stringify(value, 0);
}

// --- loading -----------------------------------------------------------------

// Which foreign modules this run may open.
//
// `ffi` used to be a single yes: granting it opened every module on the machine,
// which makes it the one capability whose name tells you nothing about what it
// reaches. It is now named the way every other authority is -- `--foreign
// node:path,./helpers.cjs` -- and granting `ffi` without saying what it is for
// opens nothing.
//
// `--foreign '*'` restores the old behaviour explicitly, and the run record
// says the boundary was unbounded, because that is exactly the fact a reviewer
// needs and the one an unbounded default would have hidden.
export function foreignAllowed(specifier, interp) {
  const allowed = interp.allowedForeign;
  if (!allowed || allowed.size === 0) return false;
  if (allowed.has('*')) return true;
  return allowed.has(specifier);
}

export function loadForeign(specifier, interp, line) {
  if (!foreignAllowed(specifier, interp)) {
    const named = [...(interp.allowedForeign ?? [])];
    interp.trace.effects.push({ capability: 'ffi', by: specifier, line, allowed: false });
    throw smarshError('CapabilityError',
      `this run may not load \`${specifier}\``, line)
      .withLabel('not a permitted foreign module')
      .note(named.length
        ? `it may load: ${named.join(', ')}`
        : 'no foreign module has been permitted')
      .help(`start it with \`--foreign ${specifier}\`, or \`--foreign '*'\` for anything`);
  }

  // Relative paths resolve against the program; bare names against the host's
  // module resolution, so an installed package works the way it normally would.
  const target = specifier.startsWith('.')
    ? path.resolve(interp.cwd, specifier)
    : specifier;

  let loaded;
  try {
    loaded = require(target);
  } catch (e) {
    throw smarshError('ForeignError',
      `cannot load \`${specifier}\`: ${e && e.message ? e.message.split('\n')[0] : String(e)}`, line)
      .help('CommonJS and built-in `node:` modules load directly; an ESM-only package needs a small CommonJS wrapper');
  }

  const exports = (loaded && typeof loaded === 'object') || typeof loaded === 'function'
    ? loaded
    : { default: loaded };

  interp.trace.foreignModules = interp.trace.foreignModules ?? [];
  if (!interp.trace.foreignModules.includes(specifier)) {
    interp.trace.foreignModules.push(specifier);
  }
  return new ForeignModule(specifier, exports);
}
