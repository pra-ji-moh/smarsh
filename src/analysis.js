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

function baseIdentifier(node) {
  let cur = node;
  while (cur && (cur.type === 'Index' || cur.type === 'Member')) cur = cur.object;
  return cur && cur.type === 'Ident' ? cur.name : null;
}

export function analyze(program) {
  const findings = [];

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
