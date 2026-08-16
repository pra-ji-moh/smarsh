import { stringify } from './values.js';
import { PedagError } from './errors.js';

// Throwing generated inputs at a contracted function and seeing what survives.
//
// Lives in its own module because two callers need it: `pedag prove`, and the
// runtime's own check that a redefinition has not broken a promise the original
// made. Keeping it here means neither has to import the other.

const EDGE = [0, 1, -1, 2, -2, 0.5, -0.5, 10, -10, 1000, -1000, 1e-9];

export function genArg(rng, trial, index) {
  if (trial < EDGE.length) return EDGE[(trial + index) % EDGE.length];
  const r = rng.next();
  if (r < 0.75) {
    const k = rng.next();
    if (k < 0.45) return Math.floor(rng.next() * 2001) - 1000;
    if (k < 0.85) return Number(((rng.next() * 2000) - 1000).toPrecision(6));
    return [0, 1, -1, 1e6, -1e6][Math.floor(rng.next() * 5)];
  }
  if (r < 0.85) return ['', 'a', 'hello', 'Pēdāg', 'x y z'][Math.floor(rng.next() * 5)];
  if (r < 0.92) return rng.next() < 0.5;
  if (r < 0.98) {
    const n = Math.floor(rng.next() * 4);
    return Array.from({ length: n }, () => Math.floor(rng.next() * 20) - 10);
  }
  return null;
}

const STEP_LIMIT = 200000;

// Pēdāg is dynamically typed and contracts cannot state types, so a generated
// bool landing in a function written for nums is the generator wandering out of
// the domain -- not a defect. Counted, reported, but not a finding.
const DOMAIN_MISMATCH = new Set(['TypeError', 'ShapeError', 'AttributeError', 'ArityError']);

export function exercise(interp, name, fn, rng, trials) {
  const arity = fn.decl.params.length;
  const report = {
    name,
    arity,
    trials,
    accepted: 0,      // inputs the preconditions let through
    rejected: 0,      // inputs the preconditions turned away
    mismatched: 0,    // inputs of a shape the function was never written for
    violations: [],   // preconditions held, postcondition failed
    crashes: [],      // preconditions held, body blew up
  };

  for (let t = 0; t < trials; t++) {
    const args = [];
    for (let i = 0; i < arity; i++) args.push(genArg(rng, t, i));

    const savedSteps = interp.steps;
    const savedLimit = interp.stepLimit;
    interp.steps = 0;
    interp.stepLimit = STEP_LIMIT;
    try {
      interp.callValue(fn, args, fn.decl.line, name);
      report.accepted += 1;
    } catch (e) {
      if (!(e instanceof PedagError)) throw e;

      // Anything raised while checking *this* function's preconditions means
      // the input is not in its stated domain. A tag from a deeper frame is a
      // different matter: this function accepted the input and then broke
      // something downstream, which is a real finding.
      if (e.phase === 'pre' && e.fn === name) { report.rejected += 1; continue; }

      if (e.phase === undefined && DOMAIN_MISMATCH.has(e.kind)) {
        report.mismatched += 1;
        continue;
      }

      report.accepted += 1;
      const shown = args.map((a) => stringify(a, 1)).join(', ');
      if (e.phase === 'post') {
        if (report.violations.length < 3) report.violations.push({ args: shown, message: e.message });
      } else if (report.crashes.length < 3) {
        report.crashes.push({ args: shown, message: `${e.kind}: ${e.message}` });
      }
    } finally {
      interp.stepLimit = savedLimit;
      interp.steps = savedSteps;
    }
  }

  return report;
}
