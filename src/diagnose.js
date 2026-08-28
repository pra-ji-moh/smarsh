import { parseAll } from './parser.js';
import { typecheck } from './types.js';
import { analyze } from './analysis.js';
import { analyseTaint } from './taint.js';
import { Diagnostic, positionOf } from './diagnostics.js';
import { Interpreter } from './interpreter.js';

// Everything the checker knows about a file, in one place.
//
// This lived in `bin/smarsh.mjs`, which was fine while the CLI was the only
// caller. The language server needs exactly the same answers, and a checker
// that says one thing on the command line and another in the editor is worse
// than either -- so it moved here rather than being copied. Two rules in this
// project have already lived in two places with only one of them updated, and
// this is the rule that decides whether code is correct.

// Static findings carry a kind; this is where each one gets its number.
export const CODE_FOR_FINDING = {
  race: 'E0404',
  'inexhaustive match': 'E0605',
  'control flow': 'E0604',
  'undeclared capability': 'E0406',
  'frozen value': 'E0203',
};

// The names the runtime will provide, so the checker does not report a builtin
// as undefined. Taken from a real interpreter rather than a duplicated list.
//
// Building one costs a few milliseconds, which the CLI paid once per run and
// never noticed. A language server re-checks on every keystroke, so the answer
// is computed once and kept -- the prelude cannot change while the process is
// alive.
let cachedSurface = null;

export function builtinSurface() {
  if (cachedSurface) return cachedSurface;
  const interp = new Interpreter({ out: () => {} });
  const names = [...interp.prelude.vars.keys()];
  const needs = new Map();
  const arities = new Map();
  for (const [name, slot] of interp.prelude.vars) {
    const v = slot.value;
    if (!v) continue;
    if (Array.isArray(v.needs) && v.needs.length > 0) needs.set(name, v.needs);
    if (typeof v.arity === 'number') arities.set(name, v.arity);
  }
  interp.devices.shutdown();
  cachedSurface = { names, needs, arities };
  return cachedSurface;
}

export const builtinNames = () => builtinSurface().names;
export const builtinNeeds = () => builtinSurface().needs;

export function diagnose(source, file) {
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

// The same, but keeping the parsed program for a caller that wants it. The
// language server needs the AST for hover, go-to-definition and completion, and
// parsing twice on every keystroke is a waste it can see.
export function diagnoseWithProgram(source, file) {
  const { program, errors } = parseAll(source, file);
  if (errors.length > 0) {
    return {
      program: null,
      diagnostics: errors.map((e) => new Diagnostic({
        code: 'E0101',
        message: e.message,
        span: e.span,
        file,
        label: 'here',
        helps: e.helps,
        notes: e.notes,
        line: e.line,
      })),
    };
  }
  return { program, diagnostics: diagnose(source, file) };
}

// A checker with no way to say "yes, I know" is a checker people switch off
// wholesale, which is worse than one they silence in three places. So the
// escape hatch exists -- and it is a comment in the source, greppable, tied to
// a specific line and a specific kind, and counted in the summary. A
// suppression nobody can see is the thing to avoid, not a suppression.
//
//     // smarsh-allow: taint  (deliberate: this demonstrates the error)
//     grounded { print(reply) }
export function applySuppressions(diagnostics, program, source) {
  const pragmas = [];
  for (const c of program.comments ?? []) {
    const m = /smarsh-allow:\s*([a-z, ]+)/.exec(c.text);
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
