// Every failure in Pēdāg is one of a small, named set of kinds. The kind is part
// of the language's surface: `CapabilityError` and `TaintError` are not library
// concepts bolted on, they are things the runtime itself can refuse to do.

export class PedagError extends Error {
  constructor(kind, message, line = null) {
    super(message);
    this.name = 'PedagError';
    this.kind = kind;
    this.line = line;
    this.span = null;       // [start, end] offsets, when the raiser knew them
    this.label = null;      // shown under the caret
    this.helps = [];        // actionable: a change you can make
    this.notes = [];        // context you cannot act on
    this.frames = [];       // the call stack, innermost last
  }

  // Fluent, because most raise sites add exactly one of these.
  at(span) { if (span) this.span = span; return this; }
  withLabel(text) { this.label = text; return this; }
  help(text) { this.helps.push(text); return this; }
  note(text) { this.notes.push(text); return this; }

  format(source = null, file = null, options = {}) {
    // Rendering lives in diagnostics.js; this keeps errors.js dependency-free
    // so every other module can import it without pulling the renderer in.
    if (typeof PedagError.renderer === 'function') {
      return PedagError.renderer(this, source, file, options);
    }
    const where = this.line != null ? ` (line ${this.line}${file ? ` of ${file}` : ''})` : '';
    return `${this.kind}: ${this.message}${where}`;
  }
}

// Installed by diagnostics-aware entry points (the CLI, tests that want it).
PedagError.renderer = null;

export const pedagError = (kind, message, line) => new PedagError(kind, message, line);

// Non-error control flow. These are thrown and caught internally; they never
// escape to the user.
export class ReturnSignal {
  constructor(value) { this.value = value; }
}
export class BreakSignal {}
export class ContinueSignal {}

// A budget running out is deliberately NOT a PedagError, so `attempt` cannot
// catch it. Code inside a budget block has no way to talk its way out of being
// stopped; only the boundary itself converts it into an ordinary, catchable
// failure for whoever set the budget.
export class BudgetExceeded {
  constructor(budget) {
    this.budget = budget;
  }
}
