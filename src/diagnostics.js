import { PedagError } from './errors.js';

// Rendered diagnostics.
//
// The phrasing rules here follow rustc's diagnostic guide, because it is the
// best-documented set of conventions anyone has written down:
//
//   - messages start lowercase and do not end in a full stop
//   - identifiers and code are wrapped in backticks
//   - the span is the smallest piece of source that still shows the problem
//   - `help:` is for a change you can make; `note:` is for context you cannot
//     act on. Mixing them up is what makes compiler output feel like noise
//   - suggestions are stated, not asked: "there is a builtin with a similar
//     name" rather than "did you mean...?"
//
// A diagnostic renders as:
//
//   error[E0201]: `writ` is not defined
//     --> examples/tour.pedag:12:5
//      |
//   12 |     writ("hello")
//      |     ^^^^ not found in this scope
//      |
//   help: there is a builtin with a similar name: `write`

export const CODES = {
  E0101: 'syntax error',
  E0201: 'name not found',
  E0202: 'name already declared',
  E0203: 'assignment to an immutable binding',
  E0301: 'type mismatch',
  E0302: 'wrong number of arguments',
  E0303: 'tensor shapes do not fit',
  E0304: 'operation not defined for this type',
  E0401: 'contract violated',
  E0402: 'capability not held',
  E0403: 'provenance rule violated',
  E0404: 'agent isolation violated',
  E0405: 'budget exhausted',
  E0501: 'redefinition refused',
  E0502: 'module could not be loaded',
  E0503: 'schema mismatch',
  E0504: 'no pattern matched',
  E0601: 'index out of range',
  E0602: 'division by zero',
  E0603: 'recursion too deep',
  E0604: 'control flow has no target',
  E0605: 'match does not cover every variant',
};

// Runtime error kinds mapped onto codes, so every failure a program can hit is
// explainable by the same command.
export const KIND_TO_CODE = {
  SyntaxError: 'E0101',
  NameError: 'E0201',
  ImmutableError: 'E0203',
  TypeError: 'E0301',
  ArityError: 'E0302',
  ShapeError: 'E0303',
  AttributeError: 'E0304',
  ContractError: 'E0401',
  CapabilityError: 'E0402',
  TaintError: 'E0403',
  SecretError: 'E0403',
  AgentIsolationError: 'E0404',
  BudgetError: 'E0405',
  ControlFlowError: 'E0604',
  RedefineError: 'E0501',
  ImportError: 'E0502',
  RestoreError: 'E0502',
  SchemaError: 'E0503',
  MatchError: 'E0504',
  IndexError: 'E0601',
  KeyError: 'E0601',
  ZeroDivisionError: 'E0602',
  RecursionError: 'E0603',
};

export const EXPLANATIONS = {
  E0201: `A name was used that is not in scope.

Pēdāg resolves names lexically: a name must be declared before the point it is
used, in the same block or an enclosing one. Builtins live in a scope beneath
your program's globals, so you may shadow one freely -- but a typo in a builtin
name reads as an undeclared variable, which is why this error often points at a
misspelling.

    let total = 0
    print(totl)        // error: \`totl\` is not defined

Inside an agent handler, only the agent's own state and the program's globals
are in scope. An enclosing function's locals are not.`,

  E0301: `A value was used where a different type was required.

Pēdāg is gradually typed. Annotations are optional, and any expression you have
not annotated has the type \`dyn\`, which is compatible with everything. Where
you have annotated, the checker holds you to it:

    fn area(w: num, h: num) -> num { return w * h }
    area("3", 4)       // error: expected \`num\`, found \`str\`

Run \`Pēdāg typecheck\` to see these before the program runs. A program with no
annotations at all still type-checks clean -- that is the point of gradual.`,

  E0402: `A function tried to use a capability it does not hold.

Capabilities are held, not ambient. The top level holds exactly what \`--grant\`
gave it, and a function holds exactly what it declared with \`needs\` -- never
what its caller held:

    fn save(text) needs fs { write("out.txt", text) }   // fine
    fn sneaky(text) { write("out.txt", text) }          // error: needs fs

This is attenuation, and it is deliberate: it means reading a function's
signature tells you the worst it can do.`,

  E0403: `A value's provenance forbids this use.

Values carry labels through every operation that reads them. A \`grounded\` block
refuses to read anything labelled \`ungrounded\` or \`untrusted\`; a \`region\` block
refuses to read a value restricted to a different jurisdiction.

    let reply = ungrounded(model_output)
    grounded { print(reply) }        // error

The only way to remove a label is \`trust(value, reason)\`, which demands a
written reason and records the laundering in the run trace.`,

  E0405: `A budget block used its whole allowance.

    budget steps 5000 { ... }

This is not a catchable failure inside the block. Code under a budget cannot
rescue its own stop, cannot raise its own ceiling, and a nested budget can only
tighten. Only the boundary converts it into an ordinary error, for whoever set
the budget to handle -- a runaway agent must not be able to talk its way out of
being stopped.`,

  E0604: `A control-flow keyword had nothing to act on.

    break                            // error: no loop around it
    fn f() { while true { break } }  // fine

\`return\` needs a function, \`break\` and \`continue\` need a \`while\` or \`for\`.
Enclosing constructs that are not loops -- \`atomic\`, \`grounded\`, \`region\`,
\`fork\` -- are transparent, so a \`break\` inside one leaves the loop outside it.
A function body is not: a \`break\` with no loop inside the function is an error
rather than something that reaches into the caller's loop.

\`pedag check\` reports this before the program runs.`,

  E0605: `A \`match\` on a \`choice\` left one of its variants without an arm.

    choice Payment { Card(n)  Cash(n)  Refused(why) }

    match p { Card(n) => n, Cash(n) => n }    // error: \`Refused\` has no arm

A choice is a closed set, which is what makes this decidable: the declared
variants, minus the ones that have an arm, is either empty or a list of cases
that will fall off the end of the match and raise a MatchError on the first
input that reaches them.

Add the missing arms, or \`_ => ...\` if the rest genuinely need no case. A
\`when\` guard does not close its variant, because a guarded arm may decline to
fire.

The checker stays quiet wherever it cannot be certain: a wildcard or a bare
binding in the match, arms spanning two different choices, or a variant name
declared by more than one choice.`,

  E0401: `A function's stated contract did not hold.

    fn share(total, n) requires n > 0 ensures result * n == total { ... }

\`requires\` is checked on the way in, \`ensures\` on the way out with \`result\`
bound. \`pedag prove\` generates inputs against these same contracts and reports
counterexamples, so a contract is a specification and a test suite at once.`,

  E0501: `A redefinition was refused.

\`redefine\` may change what a function does while the program runs, but not what
it is: the arity must match, it may drop capabilities but never add one, and it
inherits the original's contracts and is property-tested against them before it
goes live. A refused rewrite leaves the working version running.`,
};

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function lineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  return starts;
}

export function positionOf(source, offset) {
  const starts = lineStarts(source);
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo] + 1, lineStart: starts[lo] };
}

// Damerau-Levenshtein, bounded.
//
// The transposition case matters more than it looks: swapping two letters is
// among the most common typos there is, and plain Levenshtein scores it as two
// edits -- which is how `aera` ends up being told about `arena` when `area` was
// sitting right there. Counting a swap as one edit fixes that class outright.
export function editDistance(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let twoBack = null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array(b.length + 1);
    row[0] = i;
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, twoBack[j - 2] + 1);
      }
      row[j] = d;
      best = Math.min(best, d);
    }
    if (best > max) return max + 1;
    twoBack = prev;
    prev = row;
  }
  return prev[b.length];
}

// The closest candidate, if one is close enough to be worth mentioning. Short
// names need a tighter threshold or every two-letter typo matches everything.
export function closestName(name, candidates) {
  const max = name.length <= 3 ? 1 : name.length <= 6 ? 2 : 3;
  let best = null;
  let bestScore = max + 1;
  for (const candidate of candidates) {
    if (candidate === name) continue;
    const d = editDistance(name, candidate, max);
    if (d < bestScore) { bestScore = d; best = candidate; }
  }
  return bestScore <= max ? best : null;
}

export class Diagnostic {
  constructor({ code, message, span, file, label, helps = [], notes = [], severity = 'error', line = null }) {
    this.code = code;
    this.message = message;
    this.span = span;            // [startOffset, endOffset]
    this.line = line;            // fallback when there is no span
    this.file = file;
    this.label = label;          // shown under the caret
    this.helps = helps;
    this.notes = notes;
    this.severity = severity;
  }

  render(source, { colour = false } = {}) {
    const paint = (open, text) => (colour ? `[${open}m${text}[0m` : text);
    const red = (t) => paint(this.severity === 'error' ? '1;31' : '1;33', t);
    const blue = (t) => paint('1;34', t);
    const bold = (t) => paint('1', t);

    const head = `${this.severity}${this.code ? `[${this.code}]` : ''}`;
    const out = [`${red(head)}: ${bold(this.message)}`];

    if (source != null && this.span) {
      const [start, end] = this.span;
      const at = positionOf(source, clamp(start, 0, Math.max(0, source.length - 1)));
      const lineText = source.slice(at.lineStart).split(/\r?\n/)[0] ?? '';
      const gutter = String(at.line);
      const pad = ' '.repeat(gutter.length);

      // Underline stops at the end of the line: a span covering a whole
      // multi-line block should point at where it starts, not paint the screen.
      const width = clamp(end - start, 1, Math.max(1, lineText.length - (at.column - 1)));

      out.push(`${pad}${blue('-->')} ${this.file ?? '<source>'}:${at.line}:${at.column}`);
      out.push(`${pad} ${blue('|')}`);
      out.push(`${blue(gutter)} ${blue('|')} ${lineText}`);
      out.push(`${pad} ${blue('|')} ${' '.repeat(at.column - 1)}${red('^'.repeat(width))}${this.label ? ` ${red(this.label)}` : ''}`);
      out.push(`${pad} ${blue('|')}`);
    } else if (this.file) {
      out.push(`  ${blue('-->')} ${this.file}`);
    }

    for (const help of this.helps) out.push(`${paint('1;36', 'help')}: ${help}`);
    for (const note of this.notes) out.push(`${paint('1;37', 'note')}: ${note}`);

    if (this.code && EXPLANATIONS[this.code]) {
      out.push(`  run \`pedag explain ${this.code}\` for a longer explanation`);
    }
    return out.join('\n');
  }
}

// Turn a raised PedagError into a rendered diagnostic. Installed onto
// PedagError so every call site keeps using `err.format(source, file)`.
export function renderPedagError(err, source, file, options = {}) {
  const code = KIND_TO_CODE[err.kind] ?? null;
  const span = err.span ?? (err.line != null && source != null ? spanOfLine(source, err.line) : null);
  const diagnostic = new Diagnostic({
    code,
    message: err.message,
    span,
    file,
    label: err.label ?? err.kind,
    helps: err.helps,
    notes: err.notes,
  });
  const parts = [diagnostic.render(source, options)];
  const stack = renderStack(err.frames, file, err.line);
  if (stack) parts.push(stack);
  return parts.join('\n');
}

// Installing it here means anything that imports this module gets rendered
// errors, and anything that does not still gets the plain fallback.
PedagError.renderer = renderPedagError;

function spanOfLine(source, line) {
  const lines = source.split(/\r?\n/);
  if (line < 1 || line > lines.length) return null;
  let offset = 0;
  for (let i = 0; i < line - 1; i++) offset += lines[i].length + 1;
  const text = lines[line - 1];
  const indent = text.length - text.trimStart().length;
  return [offset + indent, offset + text.trimEnd().length];
}

// A runtime failure's frames, innermost first.
//
// Each frame records the line it was *called from*, but what a reader wants is
// the line each frame was executing at. Those are off by one level: the line a
// frame is executing at is the call site of the frame inside it, and for the
// innermost frame it is wherever the error was raised. So this walks inward,
// carrying that line along.
export function renderStack(frames, file, errorLine = null) {
  if (!frames || frames.length === 0) return '';
  const where = file ?? '<source>';
  const lines = ['stack:'];
  let executing = errorLine;
  for (let i = frames.length - 1; i >= 0; i--) {
    lines.push(`  at ${frames[i].name} (${where}:${executing ?? frames[i].line})`);
    executing = frames[i].line;
  }
  lines.push(`  at <top level> (${where}:${executing})`);
  return lines.join('\n');
}
