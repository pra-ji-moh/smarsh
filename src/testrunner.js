import fs from 'node:fs';
import path from 'node:path';

import { Interpreter } from './interpreter.js';
import { SmarshFunction } from './values.js';
import { SmarshError } from './errors.js';
import { parse } from './parser.js';
import { typecheck } from './types.js';
import { analyze } from './analysis.js';
import { exercise } from './exercise.js';
import { Rng } from './rng.js';

// `smarsh test` — one command that runs three kinds of check.
//
//   1. every `test_*` function, as an ordinary unit test
//   2. the type checker and the race checker over the file
//   3. `prove` against every contracted function in it
//
// The third is the one that earns the command. A contract is a specification, so
// a file's contracts are already a test suite; running them here means adding a
// `requires` clause immediately buys you generated tests, with no separate step
// to remember.

export function discover(target) {
  const full = path.resolve(target);
  const stat = fs.statSync(full);
  if (stat.isFile()) return [full];

  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('_test.smarsh')) found.push(child);
    }
  };
  walk(full);
  return found.sort();
}

function builtinNames() {
  const interp = new Interpreter({ out: () => {} });
  const names = [...interp.prelude.vars.keys()];
  interp.devices.shutdown();
  return names;
}

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

const CODE_FOR_FINDING = {
  race: 'E0404',
  'inexhaustive match': 'E0605',
  'control flow': 'E0604',
  'undeclared capability': 'E0406',
  'frozen value': 'E0203',
};

export function runFile(file, { seed = 0, caps = [], trials = 60, quiet = true } = {}) {
  const source = fs.readFileSync(file, 'utf8');
  const relative = path.relative(process.cwd(), file) || path.basename(file);
  const result = {
    file: relative, source, passed: [], failed: [], static: [], proved: [], skipped: [],
  };

  let program;
  try {
    program = parse(source, relative);
  } catch (e) {
    result.failed.push({ name: '<parse>', error: e });
    return result;
  }

  // Static problems are reported, but do not stop the tests -- a type error in
  // one function should not hide a passing test in another.
  result.static = [
    ...typecheck(program, { builtins: builtinNames() }),
    ...analyze(program, { builtinNeeds: builtinNeeds() }).map((f) => ({
      message: f.message,
      span: f.span,
      code: CODE_FOR_FINDING[f.kind] ?? 'E0604',
      helps: f.hint ? [f.hint] : [],
    })),
  ];

  const out = [];
  const interp = new Interpreter({
    seed, caps, cwd: path.dirname(file), out: (s) => out.push(s),
  });
  interp.entryPath = file;

  try {
    interp.run(source, relative);
  } catch (e) {
    result.failed.push({ name: '<top level>', error: e, output: out.slice() });
    interp.devices.shutdown();
    return result;
  }

  const tests = [];
  for (const [name, slot] of interp.globals.vars) {
    if (!name.startsWith('test_')) continue;
    if (!(slot.value instanceof SmarshFunction)) continue;
    if (slot.value.decl.params.length !== 0) {
      result.skipped.push({ name, why: 'takes arguments; a test takes none' });
      continue;
    }
    tests.push([name, slot.value]);
  }

  for (const [name, fn] of tests) {
    const before = out.length;
    const started = process.hrtime.bigint();
    try {
      interp.callValue(fn, [], fn.decl.line, name);
      result.passed.push({ name, ms: Number(process.hrtime.bigint() - started) / 1e6 });
    } catch (e) {
      result.failed.push({
        name,
        error: e,
        ms: Number(process.hrtime.bigint() - started) / 1e6,
        output: out.slice(before),
      });
    }
  }

  // Contracts, exercised.
  const rng = new Rng((seed ^ 0x5bf03635) >>> 0);
  for (const [name, slot] of interp.globals.vars) {
    const fn = slot.value;
    if (!(fn instanceof SmarshFunction)) continue;
    if (name.startsWith('test_')) continue;
    const d = fn.decl;
    if (d.requires.length === 0 && d.ensures.length === 0) continue;
    if (d.needs.length > 0) continue;      // effectful: not called
    result.proved.push(exercise(interp, name, fn, rng, trials));
  }

  interp.devices.shutdown();
  return result;
}

export function format(results, { colour = false } = {}) {
  const paint = (c, t) => (colour ? `[${c}m${t}[0m` : t);
  const green = (t) => paint('32', t);
  const red = (t) => paint('1;31', t);
  const dim = (t) => paint('2', t);

  const lines = [];
  let passed = 0;
  let failed = 0;
  let proved = 0;
  let counterexamples = 0;
  let staticProblems = 0;

  for (const r of results) {
    const problems = r.failed.length + r.static.length
      + r.proved.reduce((n, p) => n + p.violations.length + p.crashes.length, 0);
    lines.push(`${problems === 0 ? green('  ok  ') : red(' FAIL ')} ${r.file}`);

    for (const d of r.static) {
      staticProblems += 1;
      lines.push(red(`        static: ${d.message}`));
    }

    for (const t of r.passed) {
      passed += 1;
      lines.push(dim(`        ${t.name} (${t.ms.toFixed(1)}ms)`));
    }

    for (const t of r.failed) {
      failed += 1;
      const message = t.error instanceof SmarshError
        ? t.error.format(r.source, r.file)
        : String(t.error && t.error.stack ? t.error.stack : t.error);
      lines.push(red(`        ${t.name} FAILED`));
      for (const line of message.split('\n')) lines.push(`          ${line}`);
      for (const line of t.output ?? []) lines.push(dim(`          stdout: ${line}`));
    }

    for (const p of r.proved) {
      proved += 1;
      const bad = [...p.violations, ...p.crashes];
      counterexamples += bad.length;
      if (bad.length === 0) {
        lines.push(dim(`        contract ${p.name} held over ${p.accepted} generated inputs`));
      } else {
        lines.push(red(`        contract ${p.name} broken:`));
        for (const b of bad) lines.push(red(`          ${p.name}(${b.args}) -> ${b.message}`));
      }
    }

    for (const s of r.skipped) lines.push(dim(`        ${s.name} skipped: ${s.why}`));
  }

  const clean = failed === 0 && counterexamples === 0 && staticProblems === 0;
  lines.push('');
  lines.push(`${passed} test${passed === 1 ? '' : 's'} passed, ${failed} failed, `
    + `${proved} contract${proved === 1 ? '' : 's'} exercised (${counterexamples} counterexample${counterexamples === 1 ? '' : 's'}), `
    + `${staticProblems} static problem${staticProblems === 1 ? '' : 's'}`);

  return { text: lines.join('\n'), ok: clean };
}
