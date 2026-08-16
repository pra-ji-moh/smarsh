import { Interpreter } from './interpreter.js';
import { PedagFunction } from './values.js';
import { Rng } from './rng.js';
import { exercise } from './exercise.js';

// Contract-driven test generation.
//
// Every function that carries `requires`/`ensures` already states its own
// specification. This walks the program, throws generated inputs at each such
// function, discards the ones its preconditions reject, and reports any input
// where the preconditions held but the postcondition did not -- or where the
// body crashed on input it claimed to accept.
//
// It does not invent tests for uncontracted functions. A function that promises
// nothing cannot be checked against anything, and pretending otherwise would be
// the dishonest part of "automatic test generation".

export function proveSource(source, { file = '<script>', seed = 0, trials = 200 } = {}) {
  const interp = new Interpreter({ seed, caps: [], out: () => {} });
  try {
    interp.run(source, file);

    const rng = new Rng((seed ^ 0x5bf03635) >>> 0);
    const reports = [];

    for (const [name, slot] of interp.globals.vars) {
      const fn = slot.value;
      if (!(fn instanceof PedagFunction)) continue;
      const d = fn.decl;
      if (d.requires.length === 0 && d.ensures.length === 0) continue;

      if (d.needs.length > 0) {
        reports.push({
          name,
          skipped: `declares needs ${d.needs.join(', ')}; not exercised, because calling it would perform real effects`,
        });
        continue;
      }
      reports.push(exercise(interp, name, fn, rng, trials));
    }

    return reports;
  } finally {
    interp.devices.shutdown();
  }
}

export function formatReports(reports) {
  const lines = [];
  let findings = 0;
  let checked = 0;

  for (const r of reports) {
    if (r.skipped) {
      lines.push(`  ~ ${r.name}  skipped: ${r.skipped}`);
      continue;
    }
    checked += 1;
    const problems = r.violations.length + r.crashes.length;
    findings += problems;

    const aside = [];
    if (r.rejected) aside.push(`${r.rejected} rejected by preconditions`);
    if (r.mismatched) aside.push(`${r.mismatched} outside its domain`);
    const tail = aside.length ? ` (${aside.join(', ')})` : '';

    if (r.accepted === 0) {
      lines.push(`  ? ${r.name}  no generated input satisfied its preconditions (${r.trials} tried) -- the contract may be unsatisfiable`);
      continue;
    }

    if (problems === 0) {
      lines.push(`  . ${r.name}  held over ${r.accepted} accepted input${r.accepted === 1 ? '' : 's'}${tail}`);
      continue;
    }

    lines.push(`  X ${r.name}  ${problems} counterexample${problems === 1 ? '' : 's'} over ${r.accepted} accepted inputs${tail}`);
    for (const v of r.violations) lines.push(`      ${r.name}(${v.args})  ->  ${v.message}`);
    for (const c of r.crashes) lines.push(`      ${r.name}(${c.args})  ->  ${c.message}`);
  }

  return { text: lines.join('\n'), findings, checked };
}
