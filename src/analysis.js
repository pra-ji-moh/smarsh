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

function baseIdentifier(node) {
  let cur = node;
  while (cur && (cur.type === 'Index' || cur.type === 'Member')) cur = cur.object;
  return cur && cur.type === 'Ident' ? cur.name : null;
}

export function analyze(program) {
  const findings = controlFlowFindings(program);

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
