// Static checks that run before a program does.
//
// The one that matters is the race check. `fork n { ... }` runs the same body
// as n independent paths; if that body writes to a variable declared outside
// it, the paths are fighting over one cell and the result depends on how they
// interleave. That is a defect whether or not the current implementation
// happens to run them in order, and it is detectable without running anything.
//
// Deliberately biased toward silence: a name declared anywhere inside the fork
// body is treated as local, so shadowing never produces a false alarm. The cost
// is that a few real races go unreported. A checker people switch off is worth
// less than one that only speaks when it is right.

const CHILD_KEYS = new Set(['type', 'line', 'name', 'op', 'value', 'src', 'needs', 'params']);

function walk(node, visit, parent = null) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, parent);
    return;
  }
  if (typeof node.type === 'string') visit(node, parent);
  for (const [key, child] of Object.entries(node)) {
    if (CHILD_KEYS.has(key) && typeof child !== 'object') continue;
    walk(child, visit, node);
  }
}

// Every name a block introduces, at any depth inside it.
function declaredWithin(node) {
  const names = new Set(['_']);          // fork binds the path index
  walk(node, (n) => {
    if (n.type === 'Declare') names.add(n.name);
    else if (n.type === 'FnDecl') names.add(n.fn.name);
    else if (n.type === 'For') names.add(n.name);
    else if (n.type === 'Attempt') names.add(n.name);
    else if (n.type === 'Fn') for (const p of n.params) names.add(p);
  });
  return names;
}

// `return` needs a function around it, `break` and `continue` need a loop.
// Without one the interpreter throws a signal that nothing catches. The runtime
// turns that into a ControlFlowError at its boundaries, but a misplaced keyword
// is decidable from the syntax alone, so `check` should say so before the
// program is ever run.
//
// Only `Fn` and the two loops are treated as scopes. Every other construct is
// transparent, which is what the interpreter does -- `break` inside `atomic`,
// `grounded` or `fork` really does leave the enclosing loop.
function controlFlowFindings(program) {
  const found = [];

  const scan = (node, inFn, inLoop) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) scan(child, inFn, inLoop);
      return;
    }

    switch (node.type) {
      case 'Return':
        if (!inFn) {
          found.push({
            line: node.line, span: node.span, kind: 'control flow',
            message: '`return` here has no function to return from',
            hint: 'at the top level the last expression is already the result',
          });
        }
        break;
      case 'Break':
      case 'Continue':
        if (!inLoop) {
          const word = node.type === 'Break' ? 'break' : 'continue';
          found.push({
            line: node.line, span: node.span, kind: 'control flow',
            message: `\`${word}\` here has no loop to ${word === 'break' ? 'leave' : 'continue'}`,
            hint: 'it needs an enclosing `while` or `for`',
          });
        }
        break;
      case 'Fn':
        // A function body starts fresh: a loop outside it is not reachable
        // from within, because the call boundary catches the signal.
        scan(node.body, true, false);
        return;
      case 'While':
        scan(node.test, inFn, inLoop);
        scan(node.body, inFn, true);
        scan(node.invariants, inFn, inLoop);
        scan(node.variant, inFn, inLoop);
        return;
      case 'For':
        scan(node.iter, inFn, inLoop);
        scan(node.body, inFn, true);
        scan(node.invariants, inFn, inLoop);
        scan(node.variant, inFn, inLoop);
        return;
      case 'AgentDecl':
        // Handlers live in a Map, so the generic walk never reaches them.
        // Each body is a function body of its own.
        scan(node.stateDecls, inFn, inLoop);
        for (const handler of node.handlers.values()) scan(handler.body, true, false);
        return;
      default:
        break;
    }

    for (const [key, child] of Object.entries(node)) {
      if (CHILD_KEYS.has(key) && typeof child !== 'object') continue;
      scan(child, inFn, inLoop);
    }
  };

  scan(program, false, false);
  return found;
}

// Exhaustiveness: does this `match` handle every variant of the choice it is
// matching on?
//
// A missed variant is otherwise a MatchError at run time, on whichever input
// finally reaches it -- the class of bug that closed sum types exist to remove.
// Reporting it before the program runs is most of the value of having `choice`
// at all.
//
// This works off the syntax rather than inferred types, so it is decidable
// without the type checker and it stays quiet when it cannot be sure. A match
// is only judged when every record pattern in it names a variant of one single
// choice. Then the answer is arithmetic: the declared variants, minus the ones
// with an arm.
//
// A wildcard, a bare binding, or a guard on the arm that would have covered a
// variant all mean the checker says nothing -- `_` is an explicit statement
// that the remaining cases are handled, and a guard means the arm may not fire
// even when the pattern fits.
function exhaustivenessFindings(program) {
  // Every choice declared anywhere in the file, and which choice each variant
  // name belongs to. Declaration order does not matter: a `match` written
  // above the `choice` is still checked.
  const variantOwner = new Map();   // variant name -> choice node
  const nullary = new Set();        // variants carrying no fields
  const choices = new Map();        // choice name  -> choice node
  walk(program, (n) => {
    if (n.type !== 'ChoiceDecl') return;
    choices.set(n.name, n);
    for (const v of n.variants) {
      // A name used by two different choices is ambiguous; refuse to guess.
      variantOwner.set(v.name, variantOwner.has(v.name) ? null : n);
      if (v.fields.length === 0) nullary.add(v.name);
    }
  });
  if (choices.size === 0) return [];

  const findings = [];
  walk(program, (node) => {
    if (node.type !== 'Match') return;

    let owner;
    const covered = new Set();
    for (const arm of node.arms) {
      const p = arm.pattern;
      // Anything that can match more than one variant ends the analysis.
      if (p.kind === 'wildcard') return;
      // A variant carrying nothing is written without parentheses, so it
      // parses as a binding. Only a binding that is *not* one of those is a
      // genuine catch-all. (The interpreter draws the same distinction, in
      // matchPattern -- they have to agree or the checker would be describing
      // a different language than the one that runs.)
      if (p.kind === 'bind' && !nullary.has(p.name)) return;
      if (p.kind !== 'record' && p.kind !== 'bind') return;

      const which = variantOwner.get(p.name);
      if (!which) return;                       // not a variant, or ambiguous
      if (owner === undefined) owner = which;
      else if (owner !== which) return;         // arms span two choices

      // A guarded arm may decline to fire, so it does not close its variant.
      if (!arm.guard) covered.add(p.name);
    }
    if (owner === undefined) return;

    const missing = owner.variants.map((v) => v.name).filter((n) => !covered.has(n));
    if (missing.length === 0) return;

    const guarded = node.arms.some((a) => a.guard);
    findings.push({
      line: node.line,
      span: node.span,
      kind: 'inexhaustive match',
      message: `this match on \`${owner.name}\` does not handle `
        + `${missing.map((m) => `\`${m}\``).join(', ')}`,
      hint: guarded
        ? 'an arm with a `when` guard may not fire, so it does not cover its variant; add an arm without one, or `_ => ...`'
        : `add ${missing.length === 1 ? 'an arm for it' : 'arms for them'}, or \`_ => ...\` if the rest genuinely need no case`,
    });
  });
  return findings;
}

// Does a function declare the authority it actually uses?
//
// Capabilities are checked at run time, at the boundary of every call: to call
// something that declares `needs fs`, the calling frame must itself hold `fs`.
// That is enforced, and it was enforced only when the line ran -- so a branch
// that reached the filesystem, in code nobody executed during review, said
// nothing until it did.
//
// It is decidable in advance. A builtin knows what it needs, a declared
// function says so in its signature, and requirements travel to the caller. So
// for each function: everything it calls directly, minus what it declared, is
// what it is missing.
//
// Deliberately quiet where it cannot be sure -- the same rule as the rest of
// this file:
//
//   * only direct calls to a name. A call through a value, or a method on an
//     object, could be anything.
//   * nothing inside a `using` block, which is exactly where a capability is
//     held that the signature does not mention.
//   * nothing where the name has been rebound locally, since it is then not
//     the builtin or the function this pass thinks it is.
//   * the top level is exempt. It holds whatever `--grant` gave it, which is
//     not knowable from the source.
//
// It does not need a fixpoint. Each function is measured against what its
// callees *declare*, not against what they use -- and a callee that uses more
// than it declares is reported in its own right.
function capabilityFindings(program, builtinNeeds) {
  if (!builtinNeeds || builtinNeeds.size === 0) return [];

  // Every function declared anywhere, by name, so a call can be resolved.
  const declaredFns = new Map();
  walk(program, (n) => {
    if (n.type === 'FnDecl') declaredFns.set(n.fn.name, n.fn);
  });

  const findings = [];

  // Names bound as parameters or locals shadow a builtin, so a call to one of
  // those is not a call to what this pass would otherwise assume.
  const shadowsIn = (fn) => {
    const names = new Set(fn.params);
    walk(fn.body, (n) => {
      if (n.type === 'Declare') names.add(n.name);
      else if (n.type === 'For') names.add(n.name);
      else if (n.type === 'Attempt') names.add(n.name);
    });
    return names;
  };

  const check = (fn) => {
    const declared = new Set(fn.needs ?? []);
    const shadowed = shadowsIn(fn);
    // capability -> the first line that wanted it, and who wanted it
    const wanted = new Map();

    const scan = (node, underUsing) => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const child of node) scan(child, underUsing);
        return;
      }
      // A nested function declares its own authority and is checked on its own.
      if (node.type === 'Fn' || node.type === 'FnDecl' || node.type === 'AgentDecl') return;
      // Inside `using`, a capability is held that the signature does not name.
      const inUsing = underUsing || node.type === 'Using';

      if (node.type === 'Call' && node.callee && node.callee.type === 'Ident' && !inUsing) {
        const name = node.callee.name;
        if (!shadowed.has(name)) {
          const needs = builtinNeeds.get(name)
            ?? (declaredFns.has(name) ? (declaredFns.get(name).needs ?? []) : null);
          if (needs) {
            for (const cap of needs) {
              if (!declared.has(cap) && !wanted.has(cap)) {
                wanted.set(cap, { line: node.line, span: node.span, via: name });
              }
            }
          }
        }
      }

      for (const [key, child] of Object.entries(node)) {
        if (CHILD_KEYS.has(key) && typeof child !== 'object') continue;
        scan(child, inUsing);
      }
    };

    scan(fn.body, false);

    for (const [cap, where] of wanted) {
      findings.push({
        line: where.line,
        span: where.span,
        kind: 'undeclared capability',
        message: `\`${fn.name}\` uses \`${cap}\` through \`${where.via}\`, but does not declare it`,
        hint: `write \`fn ${fn.name}(...) needs ${[...declared, cap].join(', ')}\`, `
          + 'so that reading the signature tells you what it can reach',
      });
    }
  };

  for (const fn of declaredFns.values()) check(fn);
  // Function expressions declare and are checked the same way.
  walk(program, (n) => {
    if (n.type === 'Fn' && !declaredFns.has(n.name)) check(n);
  });

  findings.sort((a, b) => a.line - b.line);
  return findings;
}

// Mutating something bound with `let`.
//
// `let` freezes the value, all the way down, and it freezes the *value* rather
// than the binding -- so this fails, and the second line is the surprising one:
//
//     let xs = []
//     xs.push(1)          // ImmutableError
//
//     var ys = [1, 2]
//     let alias = ys
//     ys.push(3)          // also ImmutableError, though `ys` is a var
//
// The guarantee is worth keeping: blocking rebinding while leaving the contents
// writable is the weaker promise people assume they are getting and are not.
// What is not worth keeping is finding out at run time, on whichever branch
// happens to execute. It is decidable from the syntax, so `check` says it.
//
// Conservative in the usual way. A name declared more than once anywhere is
// skipped entirely, because two bindings of the same name may be a `let` and a
// `var` in different scopes and this pass does not resolve scopes.
const MUTATING_METHODS = new Set(['push', 'pop', 'remove', 'set']);

// Only a list or a map can be frozen.
//
// `freezeDeep` leaves everything else alone: a record, a tensor and a decimal
// are already immutable, and a context window, a ledger or an agent is a live
// handle whose identity is the point -- freezing one would break the thing it
// refers to. So `let ctx = context(50)` followed by `ctx.push(...)` is correct
// code, and an earlier version of this check called it an error.
//
// The value therefore has to be known to be a collection, which it is only when
// the initialiser says so outright.
const isCollectionLiteral = (node) => node
  && (node.type === 'ListLit' || node.type === 'MapLit');

function frozenFindings(program) {
  // How many times each name is declared, and what it was declared from.
  const declaredCount = new Map();
  const declaredFrom = new Map();
  const bump = (name) => declaredCount.set(name, (declaredCount.get(name) ?? 0) + 1);
  walk(program, (n) => {
    if (n.type === 'Declare') { bump(n.name); declaredFrom.set(n.name, n); }
    else if (n.type === 'For') bump(n.name);
    else if (n.type === 'Attempt') bump(n.name);
    else if (n.type === 'FnDecl') bump(n.fn.name);
    else if (n.type === 'Fn') for (const param of n.params) bump(param);
  });
  const once = (name) => (declaredCount.get(name) ?? 0) === 1;

  // A name is frozen if it was bound with `let` to a collection, or if a `let`
  // bound a collection *through* it -- `let alias = xs` freezes what `xs` is.
  const frozen = new Map();   // name -> { line, via }
  walk(program, (n) => {
    if (n.type !== 'Declare' || n.mutable) return;

    if (once(n.name) && isCollectionLiteral(n.value)) {
      frozen.set(n.name, { line: n.line, via: null });
    }

    // The alias case, which is the one that surprises people: `xs` is a `var`
    // and still cannot be changed, because `let` froze the value it names.
    if (n.value && n.value.type === 'Ident' && once(n.value.name)) {
      const source = declaredFrom.get(n.value.name);
      if (source && isCollectionLiteral(source.value) && !frozen.has(n.value.name)) {
        frozen.set(n.value.name, { line: n.line, via: n.name });
      }
    }
  });
  if (frozen.size === 0) return [];

  const findings = [];
  const seen = new Set();

  const report = (name, node, what) => {
    const key = `${name}:${node.line}:${what}`;
    if (seen.has(key)) return;
    seen.add(key);
    const info = frozen.get(name);
    findings.push({
      line: node.line,
      span: node.span,
      kind: 'frozen value',
      message: info.via
        ? `\`${name}\` was frozen by \`let ${info.via} = ${name}\` on line ${info.line}, `
          + `so ${what} will be refused`
        : `\`${name}\` was bound with \`let\`, which freezes it, so ${what} will be refused`,
      hint: info.via
        ? '`let` freezes the value, not the binding, so it reaches every name for '
          + `it -- copy instead: \`let ${info.via} = ${name}.slice(0, ${name}.len())\``
        : 'bind it with `var` if it has to change, or build a new value',
    });
  };

  walk(program, (node) => {
    // xs.push(1)
    if (node.type === 'Call' && node.callee && node.callee.type === 'Member'
        && MUTATING_METHODS.has(node.callee.name)
        && node.callee.object && node.callee.object.type === 'Ident'
        && frozen.has(node.callee.object.name)) {
      report(node.callee.object.name, node, `\`.${node.callee.name}()\``);
      return;
    }
    if (node.type !== 'Assign' || !node.target) return;
    // xs[0] = 1
    if (node.target.type === 'Index' && node.target.object
        && node.target.object.type === 'Ident' && frozen.has(node.target.object.name)) {
      report(node.target.object.name, node, 'writing into it');
      return;
    }
    // m.field = 1
    if (node.target.type === 'Member' && node.target.object
        && node.target.object.type === 'Ident' && frozen.has(node.target.object.name)) {
      report(node.target.object.name, node, `assigning to \`.${node.target.name}\``);
    }
  });

  findings.sort((a, b) => a.line - b.line);
  return findings;
}

function baseIdentifier(node) {
  let cur = node;
  while (cur && (cur.type === 'Index' || cur.type === 'Member')) cur = cur.object;
  return cur && cur.type === 'Ident' ? cur.name : null;
}

export function analyze(program, { builtinNeeds = null } = {}) {
  const findings = [
    ...controlFlowFindings(program),
    ...exhaustivenessFindings(program),
    ...capabilityFindings(program, builtinNeeds),
    ...frozenFindings(program),
  ];

  walk(program, (node) => {
    if (node.type === 'Fork') {
      const local = declaredWithin(node.body);
      walk(node.body, (inner) => {
        if (inner.type !== 'Assign') return;
        const name = baseIdentifier(inner.target);
        if (!name || local.has(name)) return;
        findings.push({
          line: inner.line,
          span: inner.span,
          kind: 'race',
          message: inner.target.type === 'Ident'
            ? `every forked path assigns to '${name}', which is declared outside the fork; the paths are sharing one cell`
            : `every forked path writes into '${name}', which is declared outside the fork; the paths are sharing one structure`,
          hint: 'return a value from the path and combine the results afterwards',
        });
      });
    }

    // Arity used to be checked here too. It moved to the type checker, which
    // knows the whole signature rather than just the count -- and rustc's rule
    // is one message per problem, not one per pass that happens to notice it.
  });

  findings.sort((a, b) => a.line - b.line);
  return findings;
}

export function formatFindings(findings, file) {
  if (findings.length === 0) return `${file}: nothing to report`;
  const lines = findings.map((f) => {
    const head = `  ${file}:${f.line}  ${f.kind}: ${f.message}`;
    return f.hint ? `${head}\n      try: ${f.hint}` : head;
  });
  return `${lines.join('\n')}\n\n${findings.length} finding${findings.length === 1 ? '' : 's'}`;
}
