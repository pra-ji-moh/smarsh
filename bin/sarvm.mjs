#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { Interpreter } from '../src/interpreter.js';
import { SarvmError } from '../src/errors.js';
import { stringify } from '../src/values.js';
import { proveSource, formatReports } from '../src/prove.js';
import { analyze, formatFindings } from '../src/analysis.js';
import { parse, parseAll } from '../src/parser.js';
import { analyseTaint } from '../src/taint.js';
import { buildBundle } from '../src/bundle.js';
import { CODES, EXPLANATIONS, Diagnostic, positionOf } from '../src/diagnostics.js';
import { typecheck } from '../src/types.js';
import { verifyProgram, formatVerification } from '../src/verify.js';
import { discover, runFile, format } from '../src/testrunner.js';
import { formatSource } from '../src/format.js';

const VERSION = '0.3.0';

const HELP = `Sarvm ${VERSION} -- a language for programs that reason under uncertainty

usage:
  sarvm run <file.sarvm> [options]     run a program
  sarvm check <file.sarvm>             static checks, without running anything
  sarvm build <file.sarvm> [-o out]    one self-contained .mjs, no dependencies
  sarvm prove <file.sarvm> [options]   generate inputs and check every contract
  sarvm repl [options]                interactive session
  sarvm eval "<source>" [options]     run a one-liner

options:
  --seed <n>          seed for all probabilistic control flow (default 0)
  --grant <a,b,c>     capabilities the top level holds: fs, clock, crypto, net
  --trace             after the run, print every probabilistic branch taken
  --profile           after the run, print time and steps per function
  --trials <n>        prove: inputs generated per function (default 200)
  --version, --help

Every run with the same seed takes the same branches. Nothing reaches the
filesystem or the clock without --grant.`;

function parseArgs(argv) {
  const opts = { seed: 0, grant: [], trace: false, trials: 200, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seed') opts.seed = Number(argv[++i]);
    else if (a === '--grant') opts.grant = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--principal') opts.principals = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--trials') opts.trials = Number(argv[++i]);
    else if (a === '--trace') opts.trace = true;
    else if (a === '--profile') opts.profile = true;
    else if (a === '-o' || a === '--out') opts.output = argv[++i];
    else if (a === '--check') opts.check = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--version' || a === '-v') opts.version = true;
    else opts.positional.push(a);
  }
  if (!Number.isFinite(opts.seed)) { console.error('Sarvm: --seed needs a number'); process.exit(2); }
  if (!Number.isFinite(opts.trials) || opts.trials < 1) { console.error('Sarvm: --trials needs a positive number'); process.exit(2); }
  return opts;
}

function readSource(file) {
  const full = path.resolve(process.cwd(), file);
  if (!fs.existsSync(full)) {
    console.error(`Sarvm: no such file: ${file}`);
    process.exit(2);
  }
  return { full, source: fs.readFileSync(full, 'utf8') };
}

const COLOUR = process.stderr.isTTY && !process.env.NO_COLOR;

function reportError(e, source, file) {
  if (e instanceof SarvmError) {
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
  if (!file) { console.error('Sarvm: run needs a file'); process.exit(2); }
  const { full, source } = readSource(file);

  // Static findings are worth knowing before the program runs, not instead of.
  try {
    const findings = analyze(parse(source, file)).filter((f) => f.kind === 'race');
    for (const f of findings) console.error(`warning: ${file}:${f.line}  ${f.message}`);
  } catch {
    // A parse error here will be reported properly by the run below.
  }

  const interp = new Interpreter({
    seed: opts.seed,
    caps: opts.grant,
    principals: opts.principals,
    cwd: path.dirname(full),
  });
  interp.profiling = Boolean(opts.profile);
  interp.entryPath = full;
  try {
    interp.run(source, file);
  } catch (e) {
    reportError(e, source, file);
    if (opts.trace) printTrace(interp);
    if (opts.profile) printProfile(interp);
    process.exit(1);
  }
  if (opts.trace) printTrace(interp);
  if (opts.profile) printProfile(interp);
}

// The names the runtime will provide, so the checker does not report a builtin
// as undefined. Taken from a real interpreter rather than a duplicated list.
function builtinNames() {
  const interp = new Interpreter({ out: () => {} });
  const names = [...interp.prelude.vars.keys()];
  interp.devices.shutdown();
  return names;
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
  for (const f of analyze(program)) {
    out.push(Object.assign(new Diagnostic({
      code: 'E0404',
      message: f.message,
      span: f.span,
      file,
      label: f.kind,
      helps: f.hint ? [f.hint] : [],
    }), { kind: 'race' }));
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
//     // sarvm-allow: taint  (deliberate: this demonstrates the error)
//     grounded { print(reply) }
function applySuppressions(diagnostics, program, source) {
  const pragmas = [];
  for (const c of program.comments ?? []) {
    const m = /sarvm-allow:\s*([a-z, ]+)/.exec(c.text);
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
  if (!file) { console.error('Sarvm: check needs a file'); process.exit(2); }
  const { source } = readSource(file);
  let diagnostics;
  try {
    diagnostics = diagnose(source, file);
  } catch (e) {
    reportError(e, source, file);
    process.exit(1);
  }
  for (const d of diagnostics) {
    d.file = file;
    console.log(d.render(source, { colour: process.stdout.isTTY && !process.env.NO_COLOR }));
    console.log('');
  }
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  // Suppressions are always reported. They are a decision someone made, and a
  // reviewer should be able to see how many were made without reading the file.
  const silenced = diagnostics.suppressed
    ? ` (${diagnostics.suppressed} suppressed by sarvm-allow)` : '';
  console.log(errors === 0
    ? `${file}: no problems found${silenced}`
    : `${errors} problem${errors === 1 ? '' : 's'} found${silenced}`);
  process.exit(errors === 0 ? 0 : 1);
}

function cmdEval(opts) {
  const source = opts.positional[0];
  if (!source) { console.error('Sarvm: eval needs source text'); process.exit(2); }
  const interp = new Interpreter({ seed: opts.seed, caps: opts.grant });
  try {
    const v = interp.run(source, '<eval>');
    if (v !== null && v !== undefined) console.log(stringify(v, 0));
  } catch (e) {
    reportError(e, source, '<eval>');
    process.exit(1);
  }
  if (opts.trace) printTrace(interp);
}

function cmdProve(opts) {
  const file = opts.positional[0];
  if (!file) { console.error('Sarvm: prove needs a file'); process.exit(2); }
  const { source } = readSource(file);
  let reports;
  try {
    reports = proveSource(source, { file, seed: opts.seed, trials: opts.trials });
  } catch (e) {
    reportError(e, source, file);
    process.exit(1);
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
  process.exit(findings === 0 ? 0 : 1);
}

function cmdBuild(opts) {
  const file = opts.positional[0];
  if (!file) { console.error('Sarvm: build needs a file'); process.exit(2); }
  const { source } = readSource(file);
  const out = opts.output ?? `${path.basename(file, '.sarvm')}.mjs`;
  let bundle;
  try {
    bundle = buildBundle(source, path.basename(file), { seed: opts.seed, caps: opts.grant });
  } catch (e) {
    console.error(`Sarvm: cannot build: ${e.message}`);
    process.exit(1);
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
    console.error(`Sarvm: cannot read ${target}: ${e.code ?? e.message}`);
    process.exit(2);
  }
  if (files.length === 0) {
    console.log(`no test files found in ${target} (they are named *_test.sarvm)`);
    return;
  }
  const results = files.map((f) => runFile(f, { seed: opts.seed, caps: opts.grant, trials: opts.trials }));
  const { text, ok } = format(results, { colour: COLOUR });
  console.log(text);
  process.exit(ok ? 0 : 1);
}

function cmdFmt(opts) {
  const target = opts.positional[0];
  if (!target) { console.error('Sarvm: fmt needs a file or directory'); process.exit(2); }

  const files = [];
  const collect = (p) => {
    const stat = fs.statSync(p);
    if (stat.isFile()) { files.push(p); return; }
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const child = path.join(p, entry.name);
      if (entry.isDirectory()) collect(child);
      else if (entry.name.endsWith('.sarvm')) files.push(child);
    }
  };
  try {
    collect(path.resolve(target));
  } catch (e) {
    console.error(`Sarvm: cannot read ${target}: ${e.code ?? e.message}`);
    process.exit(2);
  }

  let changed = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    let formatted;
    try {
      formatted = formatSource(source, path.basename(file));
    } catch (e) {
      reportError(e, source, path.relative(process.cwd(), file));
      process.exit(1);
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
  process.exit(opts.check && changed > 0 ? 1 : 0);
}

function cmdVerify(opts) {
  const file = opts.positional[0];
  if (!file) { console.error('Sarvm: verify needs a file'); process.exit(2); }
  const { source } = readSource(file);

  let program;
  try {
    program = parse(source, file);
  } catch (e) {
    reportError(e, source, file);
    process.exit(1);
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
    console.log('the runtime still checks every contract, and `sarvm prove` still tests them');
  }
  process.exit(report.failed === 0 ? 0 : 1);
}

function cmdExplain(opts) {
  const code = (opts.positional[0] ?? '').toUpperCase();
  if (!code) {
    console.error('Sarvm: explain needs an error code, e.g. Sarvm explain E0402');
    process.exit(2);
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
  console.error(`Sarvm: no such error code \`${code}\``);
  const known = Object.keys(CODES).filter((c) => EXPLANATIONS[c]);
  console.error(`codes with a longer explanation: ${known.join(', ')}`);
  process.exit(2);
}

function cmdRepl(opts) {
  const interp = new Interpreter({ seed: opts.seed, caps: opts.grant });
  interp.allowRedeclare = true;

  console.log(`Sarvm ${VERSION}  (seed ${opts.seed}, holding: ${opts.grant.length ? opts.grant.join(', ') : 'no capabilities'})`);
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
      if (e instanceof SarvmError && e.kind === 'SyntaxError' && /end of file/.test(e.message)) {
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
  const commands = new Set(['run', 'prove', 'repl', 'eval', 'check', 'build', 'explain', 'test', 'fmt', 'verify']);

  let command;
  if (commands.has(first)) {
    command = first;
    opts.positional.shift();
  } else if (first && first.endsWith('.sarvm')) {
    command = 'run';
  } else {
    console.error(`Sarvm: unknown command '${first}'\n`);
    console.log(HELP);
    process.exit(2);
  }

  if (command === 'run') cmdRun(opts);
  else if (command === 'check') cmdCheck(opts);
  else if (command === 'eval') cmdEval(opts);
  else if (command === 'prove') cmdProve(opts);
  else if (command === 'build') cmdBuild(opts);
  else if (command === 'explain') cmdExplain(opts);
  else if (command === 'verify') cmdVerify(opts);
  else if (command === 'test') cmdTest(opts);
  else if (command === 'fmt') cmdFmt(opts);
  else if (command === 'repl') cmdRepl(opts);
}

main();
