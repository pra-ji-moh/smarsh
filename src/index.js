import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Interpreter } from './interpreter.js';
import { SmarshError } from './errors.js';
import { diagnose } from './diagnose.js';
import { buildManifest, summarise } from './audit.js';
import { stringify } from './values.js';

// Smarsh, embedded.
//
// The CLI is for people. This is for programs, and specifically for the shape
// this language is actually for: a model writes code, something runs it under
// bounds it cannot exceed, and a person reads what happened.
//
// Nobody in that loop learns Smarsh. The model emits it, the runtime confines
// it, the human reads the receipt. So the API is built around the three
// questions the calling program has, in the order it has them:
//
//     check(code)  -- is this even valid, before anything runs?
//     run(code)    -- run it, bounded, and tell me everything it did
//     result.refused -- what did it TRY that I stopped?
//
// That last one is the reason this is not just a sandbox. A sandbox tells you a
// program failed. This tells you it attempted to read a file it was not granted,
// at line 12, and was refused -- which is the difference between "something went
// wrong" and evidence you can act on.
//
// Nothing here throws for a program's own failure. A model producing broken code
// is the ordinary case, not an exception, and making the caller wrap every call
// in try/catch to handle the ordinary case is a bad API.

const DEFAULT_TIMEOUT_STEPS = 10_000_000;

// The version goes into every manifest, and a manifest that names the wrong
// runtime is a manifest that cannot be replayed. Read from package.json rather
// than written here, because a constant in two files is a constant that will
// disagree with itself.
const VERSION = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();

// What a run cost and what it touched, in the shape a caller wants to log or
// show a user.
// Exported because the CLI's `--json` needs exactly this shape. Two
// implementations of "what was refused" would drift, and the one people trust
// would be whichever disagreed with them last.
export function describeRefusals(interp) {
  const out = [];

  for (const e of interp.trace.effects ?? []) {
    if (e.allowed) continue;
    out.push({
      kind: 'capability',
      capability: e.capability,
      detail: e.by ?? null,
      line: e.line ?? null,
      message: `refused ${e.capability}${e.by ? ` (${e.by})` : ''}`,
    });
  }

  for (const c of interp.trace.crossings ?? []) {
    if (c.allowed) continue;
    out.push({
      kind: c.kind === 'vouch' ? 'integrity' : 'confidentiality',
      party: c.to ?? null,
      label: c.label ?? null,
      line: c.line ?? null,
      message: c.kind === 'vouch'
        ? `\`${c.to}\` does not vouch for a value that was read`
        : `\`${c.to}\` may not read a value that was sent`,
    });
  }

  return out;
}

function describeError(e, source, file) {
  if (e instanceof SmarshError) {
    const json = typeof e.toJSON === 'function' ? e.toJSON(source) : null;
    return {
      kind: e.kind,
      message: e.message,
      line: e.line ?? null,
      // The rendered form is what a model repairs from: it carries the caret,
      // the help and the note, which are the parts that say what to do.
      rendered: e.format(source, file, { colour: false }),
      helps: e.helps ?? [],
      notes: e.notes ?? [],
      ...(json ? { code: json.code, column: json.column } : {}),
    };
  }
  if (e instanceof RangeError && /call stack/i.test(e.message)) {
    return { kind: 'RecursionError', message: 'the interpreter ran out of stack', line: null, rendered: '', helps: [], notes: [] };
  }
  return { kind: 'InternalError', message: String(e?.message ?? e), line: null, rendered: '', helps: [], notes: [] };
}

/**
 * Check without running. The first half of a generate-check-fix loop: a model
 * emits code, this says what is wrong with it in a form the model can repair
 * from, and nothing has executed.
 */
export function check(source, { file = 'generated.smarsh' } = {}) {
  let diagnostics;
  try {
    diagnostics = diagnose(source, file);
  } catch (e) {
    return { ok: false, diagnostics: [describeError(e, source, file)], suppressed: 0 };
  }
  return {
    ok: diagnostics.every((d) => d.severity !== 'error'),
    diagnostics: diagnostics.map((d) => d.toJSON(source)),
    suppressed: diagnostics.suppressed ?? 0,
  };
}

/**
 * Run it, bounded, and report everything it did and everything it tried.
 *
 * Never throws for a fault in the program: `ok` says whether it completed and
 * `error` says what stopped it. It throws only if the options themselves are
 * wrong, which is the caller's bug rather than the program's.
 */
export function run(source, options = {}) {
  const {
    file = 'generated.smarsh',
    grant = [],
    principals = [],
    foreign = [],
    allowHost = [],
    seed = 0,
    steps = DEFAULT_TIMEOUT_STEPS,
    cwd = process.cwd(),
    engine = 'fast',
    sign = null,
  } = options;

  if (typeof source !== 'string') {
    throw new TypeError('smarsh.run needs the source as a string');
  }

  const output = [];
  const warnings = [];
  const interp = new Interpreter({
    seed,
    caps: grant,
    principals,
    foreign,
    hosts: allowHost,
    cwd,
    out: (line) => output.push(line),
    warn: (line) => warnings.push(line),
  });
  interp.entryPath = path.resolve(cwd, path.basename(file));
  if (engine === 'tree') interp.compiled = false;
  // A run with no ceiling is a run that can hang the host process, which is not
  // an acceptable default for something whose job is executing code it did not
  // write.
  interp.stepLimit = steps;

  let value = null;
  let error = null;
  let outcome = 'completed';

  try {
    value = interp.run(source, file);
  } catch (e) {
    error = describeError(e, source, file);
    outcome = 'failed';
  }

  let manifest = null;
  let receipt = '';
  try {
    manifest = buildManifest(interp, {
      file, source, outcome, runtimeVersion: VERSION, signWith: sign,
    });
    receipt = summarise(manifest);
  } catch (e) {
    // A manifest that cannot be built must not swallow the run's actual result.
    warnings.push(`the manifest could not be built: ${e.message}`);
  }

  const refused = describeRefusals(interp);
  interp.net?.shutdown();
  interp.devices.shutdown();

  return {
    ok: error === null,
    /** Lines the program printed. */
    output,
    /** The value of its last statement, as a string, or null. */
    value: value === null || value === undefined ? null : stringify(value, 0),
    /** What stopped it, structured, or null. */
    error,
    /** Everything it attempted and was refused. This is the interesting part. */
    refused,
    /** Non-fatal notices from the runtime itself. */
    warnings,
    /** The hash-chained record, as data. */
    manifest,
    /** The same record, rendered for a person. */
    receipt,
    /** What it cost. */
    steps: interp.steps,
  };
}

/**
 * A reusable set of bounds.
 *
 * The point is that the bounds are decided once, by the person embedding this,
 * and every piece of generated code that comes through is held to them. A model
 * cannot widen them by emitting different code, because they are not in the
 * code.
 */
export class Sandbox {
  constructor(options = {}) {
    this.options = { ...options };
  }

  check(source, extra = {}) {
    return check(source, { ...this.options, ...extra });
  }

  run(source, extra = {}) {
    return run(source, { ...this.options, ...extra });
  }

  /**
   * Check first, and refuse to run code that does not pass. The loop a caller
   * driving a model actually wants: nothing executes until it is at least valid,
   * and what comes back on failure is what the model needs to fix it.
   */
  checkThenRun(source, extra = {}) {
    const checked = this.check(source, extra);
    if (!checked.ok) {
      return {
        ok: false,
        ranAtAll: false,
        output: [],
        value: null,
        error: {
          kind: 'CheckFailed',
          message: `${checked.diagnostics.length} problem(s) found before running`,
          line: checked.diagnostics[0]?.line ?? null,
          rendered: '',
          helps: [],
          notes: [],
        },
        diagnostics: checked.diagnostics,
        refused: [],
        warnings: [],
        manifest: null,
        receipt: '',
        steps: 0,
      };
    }
    return { ...this.run(source, extra), ranAtAll: true, diagnostics: [] };
  }
}

// The page written to be handed to a model, so an embedder can put it in a
// prompt without knowing where the package lives on disk.
export { default as PROMPT } from './prompt.js';

export { SmarshError };
export { Interpreter } from './interpreter.js';
export { verifyManifest } from './audit.js';
