#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { Interpreter } from '../src/interpreter.js';
import { PedagError } from '../src/errors.js';
import { stringify } from '../src/values.js';
import { proveSource, formatReports } from '../src/prove.js';
import { analyze, formatFindings } from '../src/analysis.js';
import { parse, parseAll } from '../src/parser.js';
import { analyseTaint } from '../src/taint.js';
import { buildBundle } from '../src/bundle.js';
import { CODES, EXPLANATIONS, KIND_TO_CODE, Diagnostic, positionOf } from '../src/diagnostics.js';
import { typecheck } from '../src/types.js';
import { verifyProgram, formatVerification } from '../src/verify.js';
import { discover, runFile, format } from '../src/testrunner.js';
import { formatSource } from '../src/format.js';
import { buildManifest, verifyManifest, summarise } from '../src/audit.js';
import { generateKeypair, verifyMessage, exportKeypair, loadKeypair } from '../src/crypto.js';

const VERSION = '0.3.0';

const HELP = `Pēdāg ${VERSION} -- proves what a program was allowed to do, and what it did

usage:
  pedag demo                           see what it does, in 30 seconds
  pedag run <file.pedag> [options]     run a program
  pedag check <file.pedag>             static checks, without running anything
  pedag build <file.pedag> [-o out]    one self-contained .mjs, no dependencies
  pedag prove <file.pedag> [options]   generate inputs and check every contract
  pedag verify <file.pedag>            prove contracts hold for every input
  pedag audit <manifest.json>          read back a run record and check it is intact
  pedag keygen [-o key.pem]            a signing identity to bind records to
  pedag repl [options]                interactive session
  pedag eval "<source>" [options]     run a one-liner

options:
  --seed <n>          seed for all probabilistic control flow (default 0)
  --grant <a,b,c>     capabilities the top level holds: fs, clock, crypto, net
  --trace             after the run, print every probabilistic branch taken
  --profile           after the run, print time and steps per function
  --trials <n>        prove: inputs generated per function (default 200)
  --engine <e>        'fast' (default, compiled) or 'tree' (the reference)
  --foreign <a,b>     which foreign modules ffi may open ('*' for any)
  --json              machine-readable output, for a program driving this one
  --version, --help

Every run with the same seed takes the same branches. Nothing reaches the
filesystem or the clock without --grant.`;

// A comma list, added to what is already there. Repeating the flag used to
// overwrite it, so `--grant fs --grant net` silently held only `net` -- the
// flag the user typed first was discarded without a word.
const addList = (into, raw) => {
  for (const s of String(raw ?? '').split(',').map((t) => t.trim()).filter(Boolean)) {
    if (!into.includes(s)) into.push(s);
  }
  return into;
};

function parseArgs(argv) {
  const opts = {
    seed: 0, grant: [], principals: [], foreign: [],
    trace: false, trials: 200, positional: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seed') opts.seed = Number(argv[++i]);
    else if (a === '--grant') addList(opts.grant, argv[++i]);
    else if (a === '--principal') addList(opts.principals, argv[++i]);
    else if (a === '--foreign') addList(opts.foreign, argv[++i]);
    else if (a === '--engine') opts.engine = String(argv[++i] ?? '');
    else if (a === '--trials') opts.trials = Number(argv[++i]);
    else if (a === '--trace') opts.trace = true;
    else if (a === '--profile') opts.profile = true;
    else if (a === '--audit') opts.audit = argv[++i] ?? 'audit.json';
    else if (a === '--sign') opts.sign = true;
    else if (a === '--key') { opts.key = argv[++i]; opts.sign = true; }
    else if (a === '-o' || a === '--out') opts.output = argv[++i];
    else if (a === '--check') opts.check = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--version' || a === '-v') opts.version = true;
    else opts.positional.push(a);
  }
  if (opts.engine !== undefined && !['fast', 'tree'].includes(opts.engine)) {
    console.error("Pēdāg: --engine takes 'fast' (the default) or 'tree'");
    process.exit(2);
  }
  if (!Number.isFinite(opts.seed)) { console.error('Pēdāg: --seed needs a number'); process.exit(2); }
  if (!Number.isFinite(opts.trials) || opts.trials < 1) { console.error('Pēdāg: --trials needs a positive number'); process.exit(2); }
  return opts;
}

// A missing file has to stop the command outright rather than return nothing
// for the caller to destructure. This one keeps process.exit deliberately:
// nothing has been printed to stdout yet, so there is nothing to truncate.
function readSource(file) {
  const full = path.resolve(process.cwd(), file);
  if (!fs.existsSync(full)) {
    console.error(`pedag: no such file: ${file}`);
    process.exit(2);
  }
  return { full, source: fs.readFileSync(full, 'utf8') };
}

// Static findings carry a kind; this is where each one gets its number.
const CODE_FOR_FINDING = {
  race: 'E0404',
  'inexhaustive match': 'E0605',
  'control flow': 'E0604',
  'undeclared capability': 'E0406',
  'frozen value': 'E0203',
};

const COLOUR = process.stderr.isTTY && !process.env.NO_COLOR;

function reportError(e, source, file) {
  if (e instanceof PedagError) {
    console.error(e.format(source, file, { colour: COLOUR }));
    return;
  }
  if (e instanceof RangeError && /call stack/i.test(e.message)) {
    console.error('RecursionError: the interpreter ran out of stack');
    return;
  }
  throw e;
}

function printTrace(interp) {
  const t = interp.trace;
  console.error('--- trace ---------------------------------------------------');
  console.error(`seed ${interp.seed}   calls ${t.calls}   forks ${t.forks}   contracts checked ${t.contracts}`);
  for (const b of t.branches) {
    if (b.kind === 'maybe') {
      console.error(`  line ${b.line}: maybe p=${b.p} drew ${b.draw.toFixed(4)} -> ${b.taken ? 'taken' : 'skipped'}`);
    } else {
      console.error(`  line ${b.line}: choose drew ${b.draw.toFixed(4)} -> arm ${b.taken}`);
    }
  }
  for (const l of t.laundered) {
    console.error(`  line ${l.line}: trust() cleared [${l.cleared.join(', ')}] because "${l.reason}"`);
  }
}

function printProfile(interp) {
  const rows = [...interp.profile.entries()]
    .map(([name, r]) => ({ name, ...r, ms: Number(r.nanos) / 1e6 }))
    .sort((a, b) => b.ms - a.ms);
  console.error('--- profile (time is inclusive of nested calls) --------------');
  console.error('  calls      steps        ms   function');
  for (const r of rows) {
    console.error(
      `  ${String(r.calls).padStart(5)}  ${String(r.steps).padStart(9)}  ${r.ms.toFixed(3).padStart(8)}   ${r.name}`);
  }
  if (rows.length === 0) console.error('  (no function calls)');
}

function cmdRun(opts) {
  const file = opts.positional[0];
  if (!file) { console.error('Pēdāg: run needs a file'); process.exit(2); }
  const { full, source } = readSource(file);

  // Static findings are worth knowing before the program runs, not instead of.
  try {
    const findings = analyze(parse(source, file)).filter((f) => f.kind === 'race');
    for (const f of findings) console.error(`warning: ${file}:${f.line}  ${f.message}`);
  } catch {
    // A parse error here will be reported properly by the run below.
  }

  // Under --json the program's own output is collected rather than printed, so
  // that what reaches stdout is one JSON document a caller can parse.
  const collected = [];
  const interp = new Interpreter({
    seed: opts.seed,
    caps: opts.grant,
    principals: opts.principals,
    foreign: opts.foreign,
    cwd: path.dirname(full),
    ...(opts.json ? { out: (line) => collected.push(line) } : {}),
  });
  interp.profiling = Boolean(opts.profile);
  // `--engine tree` runs the original tree-walker. It is the specification the
  // compiled engine is checked against, and roughly four times slower; keeping
  // it reachable is what makes `tools/differential.mjs` possible.
  if (opts.engine === 'tree') interp.compiled = false;
  interp.entryPath = full;
  let outcome = 'completed';
  let failure = null;
  try {
    interp.run(source, file);
  } catch (e) {
    outcome = e instanceof PedagError ? `failed: ${e.kind}` : 'failed';
    failure = e;
  }

  // The record is written whether or not the program succeeded. A run that was
  // stopped by a refused capability is exactly the run a reviewer most wants to
  // see, so writing the manifest only on success would defeat the purpose.
  if (opts.audit) writeManifest(interp, { file, source, full, opts, outcome });

  // A program that generates Pedag needs the failure as data: what kind, where,
  // and what to read about it. Scraping that back out of a rendered caret is
  // the thing that makes an automated fix loop brittle.
  if (opts.json) {
    console.log(JSON.stringify({
      ok: !failure,
      command: 'run',
      file,
      outcome,
      stdout: collected,
      failure: failure ? failureJSON(failure, source, file) : null,
      replay: {
        seed: opts.seed,
        capabilities: [...interp.grantedCaps].sort(),
        principals: [...interp.grantedAuthority].sort(),
      },
      work: {
        steps: interp.steps,
        calls: interp.trace.calls,
        contracts_checked: interp.trace.contracts,
      },
    }, null, 2));
    process.exitCode = failure ? 1 : 0;
    return;
  }

  if (failure) {
    reportError(failure, source, file);
    if (opts.trace) printTrace(interp);
    if (opts.profile) printProfile(interp);
    process.exitCode = 1;
    return;
  }
  if (opts.trace) printTrace(interp);
  if (opts.profile) printProfile(interp);
}

// A runtime failure, as data. Mirrors Diagnostic.toJSON so that a caller sees
// one shape whether the problem was found by `check` or by running.
function failureJSON(e, source, file) {
  if (!(e instanceof PedagError)) {
    return {
      severity: 'error',
      code: null,
      kind: e && e.constructor ? e.constructor.name : typeof e,
      message: String(e && e.message ? e.message : e),
      file,
      line: null,
    };
  }
  const code = KIND_TO_CODE[e.kind] ?? null;
  const at = (e.span && source != null) ? positionOf(source, Math.max(0, e.span[0])) : null;
  return {
    severity: 'error',
    code,
    title: code ? (CODES[code] ?? null) : null,
    kind: e.kind,
    message: e.message,
    file,
    line: at ? at.line : e.line,
    column: at ? at.column : null,
    span: e.span ?? null,
    helps: e.helps ?? [],
    notes: e.notes ?? [],
    // Innermost last, the way a person reads a stack.
    stack: (e.frames ?? []).map((f) => ({ function: f.name, line: f.line })),
    explain: code ? `pedag explain ${code}` : null,
  };
}

// Read back a record someone else produced and check it has not been edited.
function cmdAudit(opts) {
  const file = opts.positional[0];
  if (!file) { console.error('pedag: audit needs a manifest file'); process.exit(2); }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file), 'utf8'));
  } catch (e) {
    console.error(`pedag: cannot read ${file}: ${e.message}`);
    process.exitCode = 2;
    return;
  }

  console.log(summarise(manifest));
  console.log('');

  const { ok, problems } = verifyManifest(manifest);
  const signed = manifest.signature
    ? verifyMessage(manifest.signature.public_key, manifest.head, manifest.signature.value)
    : null;

  // Both facts are reported together, and neither is stated in a way that
  // could be read alone. A signature only ever attests to the head; if the
  // events no longer produce that head, a "valid signature" means the record
  // was signed and *then* edited, which is worse than an invalid one, and a
  // reviewer skimming two separate lines could easily read it the other way.
  if (ok && signed !== false) {
    console.log('INTACT — every event hashes onto the one before it');
    if (signed) console.log(`         and the head is signed by ${manifest.signature.public_key.slice(-16)}`);
    else console.log('         unsigned: this proves nothing about who produced it');
  } else {
    console.log('ALTERED — this record does not describe the run it claims to');
    for (const p of problems) console.log(`  ${p}`);
    if (signed === true) {
      console.log('  the signature covers the recorded head, but the events no longer');
      console.log('  produce that head: the record was signed and then edited');
    } else if (signed === false) {
      console.log('  the signature does not match the recorded head either');
    }
  }

  process.exitCode = ok && signed !== false ? 0 : 1;
  return;
}

// A key the operator kept, or a throwaway. The difference is what the
// signature is able to claim, so it is stated rather than left to be assumed.
function signingKey(opts) {
  if (!opts.sign) return null;
  if (!opts.key) return { key: generateKeypair(), persistent: false };
  const full = path.resolve(process.cwd(), opts.key);
  if (!fs.existsSync(full)) {
    console.error(`pedag: no such key file: ${opts.key}  (make one with \`pedag keygen\`)`);
    process.exit(2);
  }
  try {
    return { key: loadKeypair(fs.readFileSync(full, 'utf8')), persistent: true };
  } catch (e) {
    console.error(`pedag: cannot use ${opts.key}: ${e.message}`);
    process.exit(2);
  }
}

function writeManifest(interp, { file, source, opts, outcome }) {
  const signer = signingKey(opts);
  const key = signer ? signer.key : null;
  const manifest = buildManifest(interp, {
    file, source, runtimeVersion: VERSION, signWith: key, outcome,
  });
  fs.writeFileSync(path.resolve(process.cwd(), opts.audit), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.error(`\nwrote ${opts.audit} — ${manifest.events.length} events, head ${manifest.head.slice(0, 16)}`);
  if (key && signer.persistent) {
    console.error(`signed by ${key.publicHex.slice(-16)} (from ${opts.key})`);
  } else if (key) {
    console.error(`signed with a throwaway key ${key.publicHex.slice(-16)}`);
    console.error('note: a throwaway key proves the record was not edited after this run, '
      + 'not who produced it. Use --key with a kept identity to claim that, '
      + 'and `pedag keygen` to make one.');
  }
}

// The names the runtime will provide, so the checker does not report a builtin
// as undefined. Taken from a real interpreter rather than a duplicated list.
function builtinNames() {
  const interp = new Interpreter({ out: () => {} });
  const names = [...interp.prelude.vars.keys()];
  interp.devices.shutdown();
  return names;
}

// What each builtin costs in authority, taken from a real interpreter rather
// than a duplicated list -- the same reason `builtinNames` is built this way.
function builtinNeeds() {
  const interp = new Interpreter({ out: () => {} });
  const needs = new Map();
  for (const [name, slot] of interp.prelude.vars) {
    const v = slot.value;
    if (v && Array.isArray(v.needs) && v.needs.length > 0) needs.set(name, v.needs);
  }
  interp.devices.shutdown();
  return needs;
}

function diagnose(source, file) {
  // Every syntax error, not just the first. If the file does not parse there is
  // nothing further worth saying about it.
  const { program, errors } = parseAll(source, file);
  if (errors.length > 0) {
    return errors.map((e) => new Diagnostic({
      code: 'E0101',
      message: e.message,
      span: e.span,
      file,
      label: 'here',
      helps: e.helps,
      notes: e.notes,
      line: e.line,
    }));
  }

  const out = typecheck(program, { builtins: builtinNames() }).map((d) => {
    d.kind = 'type';
    return d;
  });
  for (const f of analyze(program, { builtinNeeds: builtinNeeds() })) {
    out.push(Object.assign(new Diagnostic({
      code: CODE_FOR_FINDING[f.kind] ?? 'E0604',
      message: f.message,
      span: f.span,
      file,
      label: f.kind,
      helps: f.hint ? [f.hint] : [],
    }), { kind: f.kind }));
  }
  for (const f of analyseTaint(program)) {
    out.push(Object.assign(new Diagnostic({
      code: 'E0403',
      message: f.message,
      span: f.span,
      file,
      label: 'reaches a sink',
      helps: f.hint ? [f.hint] : [],
      notes: ['this is every path, not only the one a run took'],
    }), { kind: 'taint' }));
  }
  return applySuppressions(out, program, source);
}

// A checker with no way to say "yes, I know" is a checker people switch off
// wholesale, which is worse than one they silence in three places. So the
// escape hatch exists — and it is a comment in the source, greppable, tied to a
// specific line and a specific kind, and counted in the summary. A suppression
// nobody can see is the thing to avoid, not a suppression.
//
//     // pedag-allow: taint  (deliberate: this demonstrates the error)
//     grounded { print(reply) }
function applySuppressions(diagnostics, program, source) {
  const pragmas = [];
  for (const c of program.comments ?? []) {
    const m = /pedag-allow:\s*([a-z, ]+)/.exec(c.text);
    if (!m) continue;
    pragmas.push({ line: c.line, kinds: new Set(m[1].split(',').map((s) => s.trim()).filter(Boolean)) });
  }
  if (pragmas.length === 0) return diagnostics;

  // A pragma covers the whole statement it introduces, not one line. The
  // finding it is meant to silence is usually a line or two inside a block.
  const ranges = [];
  const collect = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const c of n) collect(c); return; }
    if (n.type && n.span) {
      const startLine = positionOf(source, n.span[0]).line;
      for (const p of pragmas) {
        if (startLine === p.line || startLine === p.line + 1) ranges.push({ span: n.span, kinds: p.kinds });
      }
    }
    for (const v of Object.values(n)) if (v && typeof v === 'object') collect(v);
  };
  collect(program.body);

  const kept = [];
  let suppressed = 0;
  for (const d of diagnostics) {
    const at = d.span ? d.span[0] : null;
    const covered = at !== null && ranges.some((r) =>
      at >= r.span[0] && at <= r.span[1] && (r.kinds.has(d.kind) || r.kinds.has('all')));
    if (covered) { suppressed += 1; continue; }
    kept.push(d);
  }
  kept.suppressed = suppressed;
  return kept;
}

function cmdCheck(opts) {
  const file = opts.positional[0];
  if (!file) { console.error('Pēdāg: check needs a file'); process.exit(2); }
  const { source } = readSource(file);
  let diagnostics;
  try {
    diagnostics = diagnose(source, file);
  } catch (e) {
    reportError(e, source, file);
    process.exitCode = 1;
    return;
  }
  const errors = diagnostics.filter((d) => d.severity === 'error').length;

  // Most Pedag will be written by a program, and a program cannot act on a
  // caret drawn under a span with box characters. Same diagnostics, as data.
  if (opts.json) {
    for (const d of diagnostics) d.file = file;
    console.log(JSON.stringify({
      ok: errors === 0,
      command: 'check',
      file,
      suppressed: diagnostics.suppressed ?? 0,
      diagnostics: diagnostics.map((d) => d.toJSON(source)),
    }, null, 2));
    process.exitCode = errors === 0 ? 0 : 1;
    return;
  }

  for (const d of diagnostics) {
    d.file = file;
    console.log(d.render(source, { colour: process.stdout.isTTY && !process.env.NO_COLOR }));
    console.log('');
  }
  // Suppressions are always reported. They are a decision someone made, and a
  // reviewer should be able to see how many were made without reading the file.
  const silenced = diagnostics.suppressed
    ? ` (${diagnostics.suppressed} suppressed by pedag-allow)` : '';
  console.log(errors === 0
    ? `${file}: no problems found${silenced}`
    : `${errors} problem${errors === 1 ? '' : 's'} found${silenced}`);
  process.exitCode = errors === 0 ? 0 : 1;
  return;
}

function cmdEval(opts) {
  const source = opts.positional[0];
  if (!source) { console.error('Pēdāg: eval needs source text'); process.exit(2); }
  const interp = new Interpreter({ seed: opts.seed, caps: opts.grant });
  try {
    const v = interp.run(source, '<eval>');
    if (v !== null && v !== undefined) console.log(stringify(v, 0));
  } catch (e) {
    reportError(e, source, '<eval>');
    process.exitCode = 1;
    return;
  }
  if (opts.trace) printTrace(interp);
}

function cmdProve(opts) {
  const file = opts.positional[0];
  if (!file) { console.error('Pēdāg: prove needs a file'); process.exit(2); }
  const { source } = readSource(file);
  let reports;
  try {
    reports = proveSource(source, { file, seed: opts.seed, trials: opts.trials });
  } catch (e) {
    reportError(e, source, file);
    process.exitCode = 1;
    return;
  }
  const { text, findings, checked } = formatReports(reports);
  console.log(`prove ${file} (seed ${opts.seed}, ${opts.trials} inputs per function)`);
  if (text) console.log(text);
  if (checked === 0 && reports.length === 0) {
    console.log('  no function in this file states a contract, so there is nothing to check');
  }
  console.log(findings === 0
    ? `\n${checked} contracted function${checked === 1 ? '' : 's'}, no counterexamples found`
    : `\n${findings} counterexample${findings === 1 ? '' : 's'} across ${checked} contracted function${checked === 1 ? '' : 's'}`);
  process.exitCode = findings === 0 ? 0 : 1;
  return;
}

function cmdBuild(opts) {
  const file = opts.positional[0];
  if (!file) { console.error('Pēdāg: build needs a file'); process.exit(2); }
  const { source } = readSource(file);
  const out = opts.output ?? `${path.basename(file, '.pedag')}.mjs`;
  let bundle;
  try {
    bundle = buildBundle(source, path.basename(file), { seed: opts.seed, caps: opts.grant });
  } catch (e) {
    console.error(`Pēdāg: cannot build: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(out, bundle, 'utf8');
  const kb = (Buffer.byteLength(bundle) / 1024).toFixed(1);
  console.log(`wrote ${out} (${kb} KB, no dependencies)`);
  console.log(`run it with:  node ${out}`);
  if (opts.grant.length) console.log(`capabilities baked in: ${opts.grant.join(', ')}`);
  console.log('note: the parallel device needs the source tree; a bundle runs tensor work on this thread');
}

function cmdTest(opts) {
  const target = opts.positional[0] ?? '.';
  let files;
  try {
    files = discover(target);
  } catch (e) {
    console.error(`Pēdāg: cannot read ${target}: ${e.code ?? e.message}`);
    process.exitCode = 2;
    return;
  }
  if (files.length === 0) {
    console.log(`no test files found in ${target} (they are named *_test.pedag)`);
    return;
  }
  const results = files.map((f) => runFile(f, { seed: opts.seed, caps: opts.grant, trials: opts.trials }));

  // What a program driving this one needs: which tests failed, why, and what
  // the failing test printed on its way there.
  if (opts.json) {
    const failed = results.reduce((n, r) => n + r.failed.length, 0);
    const counterexamples = results.reduce(
      (n, r) => n + r.proved.reduce((m, p) => m + p.violations.length + p.crashes.length, 0), 0);
    const staticProblems = results.reduce((n, r) => n + r.static.length, 0);
    console.log(JSON.stringify({
      ok: failed === 0 && counterexamples === 0 && staticProblems === 0,
      command: 'test',
      files: results.map((r) => ({
        file: r.file,
        passed: r.passed.map((t) => t.name),
        failed: r.failed.map((t) => ({
          name: t.name,
          ...failureJSON(t.error, r.source, r.file),
          stdout: t.output ?? [],
        })),
        skipped: r.skipped,
        static: r.static.map((d) => ({
          code: d.code ?? null,
          message: d.message,
          helps: d.helps ?? [],
        })),
        contracts: r.proved.map((p) => ({
          name: p.name,
          inputs_tried: p.accepted,
          counterexamples: [...p.violations, ...p.crashes].map((b) => ({
            arguments: b.args,
            message: b.message,
          })),
        })),
      })),
      totals: {
        passed: results.reduce((n, r) => n + r.passed.length, 0),
        failed,
        counterexamples,
        static_problems: staticProblems,
      },
    }, null, 2));
    process.exitCode = (failed === 0 && counterexamples === 0 && staticProblems === 0) ? 0 : 1;
    return;
  }

  const { text, ok } = format(results, { colour: COLOUR });
  console.log(text);
  process.exitCode = ok ? 0 : 1;
  return;
}

function cmdFmt(opts) {
  const target = opts.positional[0];
  if (!target) { console.error('Pēdāg: fmt needs a file or directory'); process.exit(2); }

  const files = [];
  const collect = (p) => {
    const stat = fs.statSync(p);
    if (stat.isFile()) { files.push(p); return; }
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const child = path.join(p, entry.name);
      if (entry.isDirectory()) collect(child);
      else if (entry.name.endsWith('.pedag')) files.push(child);
    }
  };
  try {
    collect(path.resolve(target));
  } catch (e) {
    console.error(`Pēdāg: cannot read ${target}: ${e.code ?? e.message}`);
    process.exitCode = 2;
    return;
  }

  let changed = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    let formatted;
    try {
      formatted = formatSource(source, path.basename(file));
    } catch (e) {
      reportError(e, source, path.relative(process.cwd(), file));
      process.exitCode = 1;
      return;
    }
    if (formatted === source) continue;
    changed += 1;
    const shown = path.relative(process.cwd(), file) || file;
    if (opts.check) {
      console.log(`would reformat ${shown}`);
    } else {
      fs.writeFileSync(file, formatted, 'utf8');
      console.log(`formatted ${shown}`);
    }
  }

  if (changed === 0) console.log(`${files.length} file${files.length === 1 ? '' : 's'} already formatted`);
  process.exitCode = opts.check && changed > 0 ? 1 : 0;
  return;
}

function cmdVerify(opts) {
  const file = opts.positional[0];
  if (!file) { console.error('Pēdāg: verify needs a file'); process.exit(2); }
  const { source } = readSource(file);

  let program;
  try {
    program = parse(source, file);
  } catch (e) {
    reportError(e, source, file);
    process.exitCode = 1;
    return;
  }

  const results = verifyProgram(program);
  const report = formatVerification(results, file);

  console.log(`verify ${file}`);
  if (report.text) console.log(report.text);
  if (results.length === 0) {
    console.log('  nothing to prove: no function here states a contract or a loop annotation');
  }
  console.log(`\n${report.summary}`);
  if (report.unknown > 0) {
    console.log('undecided means the solver could not settle it, not that it is false;');
    console.log('the runtime still checks every contract, and `pedag prove` still tests them');
  }
  process.exitCode = report.failed === 0 ? 0 : 1;
  return;
}

function cmdExplain(opts) {
  const code = (opts.positional[0] ?? '').toUpperCase();
  if (!code) {
    console.error('Pēdāg: explain needs an error code, e.g. Pēdāg explain E0402');
    process.exitCode = 2;
    return;
  }
  if (EXPLANATIONS[code]) {
    console.log(`${code}: ${CODES[code] ?? ''}\n`);
    console.log(EXPLANATIONS[code]);
    return;
  }
  if (CODES[code]) {
    console.log(`${code}: ${CODES[code]}\n`);
    console.log('there is no longer explanation for this code yet');
    return;
  }
  console.error(`Pēdāg: no such error code \`${code}\``);
  const known = Object.keys(CODES).filter((c) => EXPLANATIONS[c]);
  console.error(`codes with a longer explanation: ${known.join(', ')}`);
  process.exitCode = 2;
  return;
}

function cmdRepl(opts) {
  const interp = new Interpreter({ seed: opts.seed, caps: opts.grant });
  interp.allowRedeclare = true;

  console.log(`Pēdāg ${VERSION}  (seed ${opts.seed}, holding: ${opts.grant.length ? opts.grant.join(', ') : 'no capabilities'})`);
  console.log('type an expression, or .help / .exit');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '>> ' });
  let buffer = '';
  rl.prompt();

  rl.on('line', (raw) => {
    const line = raw.trim();

    if (buffer === '' && line.startsWith('.')) {
      if (line === '.exit' || line === '.quit') { rl.close(); return; }
      if (line === '.help') {
        console.log('.exit  leave    .trace  branches so far    .caps  capabilities held');
      } else if (line === '.trace') {
        printTrace(interp);
      } else if (line === '.caps') {
        console.log(interp.caps.size ? [...interp.caps].join(', ') : 'none');
      } else {
        console.log(`unknown command ${line}`);
      }
      rl.prompt();
      return;
    }

    buffer = buffer ? `${buffer}\n${raw}` : raw;
    if (buffer.trim() === '') { rl.prompt(); return; }

    try {
      const value = interp.run(buffer, '<repl>');
      buffer = '';
      if (value !== null && value !== undefined) console.log(stringify(value, 0));
    } catch (e) {
      // An unfinished block is not an error yet -- keep reading.
      if (e instanceof PedagError && e.kind === 'SyntaxError' && /end of file/.test(e.message)) {
        rl.setPrompt('.. ');
        rl.prompt();
        return;
      }
      const failed = buffer;
      buffer = '';
      reportError(e, failed, '<repl>');
    }
    rl.setPrompt('>> ');
    rl.prompt();
  });

  rl.on('close', () => process.exit(0));
}

function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);

  if (opts.version) { console.log(VERSION); return; }
  if (opts.help || argv.length === 0) { console.log(HELP); return; }

  const first = opts.positional[0];
  const commands = new Set([
    'run', 'prove', 'repl', 'eval', 'check', 'build', 'explain', 'test', 'fmt', 'verify', 'audit',
    'demo', 'keygen',
  ]);

  let command;
  if (commands.has(first)) {
    command = first;
    opts.positional.shift();
  } else if (first && first.endsWith('.pedag')) {
    command = 'run';
  } else {
    console.error(`Pēdāg: unknown command '${first}'\n`);
    console.log(HELP);
    process.exitCode = 2;
    return;
  }

  if (command === 'demo') cmdDemo(opts);
  else if (command === 'keygen') cmdKeygen(opts);
  else if (command === 'run') cmdRun(opts);
  else if (command === 'check') cmdCheck(opts);
  else if (command === 'eval') cmdEval(opts);
  else if (command === 'prove') cmdProve(opts);
  else if (command === 'build') cmdBuild(opts);
  else if (command === 'explain') cmdExplain(opts);
  else if (command === 'verify') cmdVerify(opts);
  else if (command === 'audit') cmdAudit(opts);
  else if (command === 'test') cmdTest(opts);
  else if (command === 'fmt') cmdFmt(opts);
  else if (command === 'repl') cmdRepl(opts);
}

// `pedag demo` -- no arguments, no file to write, nothing to read first.
//
// The point of the language is an artifact, not a syntax, and an artifact has
// to be seen to mean anything. So this runs a real program with real
// capabilities, and then shows the signed record it left, which is the thing
// worth evaluating.
// A signing identity, in the formats every other tool already reads.
function cmdKeygen(opts) {
  const out = opts.output ?? 'pedag-key.pem';
  const full = path.resolve(process.cwd(), out);
  if (fs.existsSync(full)) {
    console.error(`pedag: ${out} already exists; refusing to overwrite a signing key`);
    process.exitCode = 2;
    return;
  }
  const key = generateKeypair();
  const { privatePem, publicPem } = exportKeypair(key);
  fs.writeFileSync(full, privatePem, { mode: 0o600 });
  fs.writeFileSync(`${full}.pub`, publicPem);
  console.log(`wrote ${out} (private, keep it) and ${out}.pub (public, hand it out)`);
  console.log(`fingerprint ${key.publicHex.slice(-16)}`);
  console.log('');
  console.log('  sign a run   pedag run app.pedag --audit run.json --key ' + out);
  console.log('  PKCS#8 and SPKI PEM, so openssl and every HSM already read these.');
}

function cmdDemo(opts) {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'demo.pedag');
  if (!fs.existsSync(file)) {
    console.error('Pēdāg: the demo program is missing from this installation');
    process.exitCode = 2;
    return;
  }
  const source = fs.readFileSync(file, 'utf8');
  const manifestPath = path.join(os.tmpdir(), `pedag-demo-${process.pid}.json`);

  const interp = new Interpreter({
    seed: opts.seed,
    caps: ['fs'],
    principals: ['compliance'],
    cwd: path.dirname(file),
  });
  interp.entryPath = file;

  let outcome = 'completed';
  try {
    interp.run(source, 'demo.pedag');
  } catch (e) {
    outcome = e instanceof PedagError ? `failed: ${e.kind}` : 'failed';
    reportError(e, source, 'demo.pedag');
  }

  // The record. This is the part that does not exist anywhere else -- and it
  // is signed, because an unsigned chain proves only that the file is
  // self-consistent, not that it is the one this run produced.
  const key = generateKeypair();
  const manifest = buildManifest(interp, {
    file: 'demo.pedag', source, runtimeVersion: VERSION, signWith: key, outcome,
  });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log('  ---------------------------------------------------------------');
  console.log('  None of that was printed by the program on trust.');
  console.log('  Every line of it is in a signed record the program cannot edit:');
  console.log('');
  console.log(summarise(manifest).split(String.fromCharCode(10)).map((l) => `  ${l}`).join(String.fromCharCode(10)));

  const { ok, problems } = verifyManifest(manifest);
  const signed = verifyMessage(manifest.signature.public_key, manifest.head, manifest.signature.value);
  console.log('');
  if (ok && signed) {
    console.log('  INTACT -- every event hashes onto the one before it,');
    console.log(`            and the head is signed by ${key.publicHex.slice(-16)}`);
  } else {
    console.log(`  BROKEN -- ${problems.join('; ') || 'the signature does not match the head'}`);
    process.exitCode = 1;
  }
  console.log('');
  console.log('  ---------------------------------------------------------------');
  console.log(`  The record is at ${manifestPath}`);
  console.log('  Edit any line of it and run `pedag audit` on it: the chain breaks.');
  console.log('');
  console.log('  The program that produced this is examples/demo.pedag -- 90 lines.');
  console.log('  Nothing in it is narration; every refusal above was enforced.');
  console.log('');
  interp.devices.shutdown();
}

main();
