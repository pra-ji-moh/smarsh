// The program's call graph, derived from the source rather than declared.
//
// It exists so that when a function is replaced at runtime, the question
// "what else is affected by this?" has an answer that is computed instead of
// guessed. Recomputing it after a redefinition is cheap: it is a walk over the
// syntax, not a compilation.

function walk(node, visit) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type === 'string') visit(node);
  for (const child of Object.values(node)) {
    if (child && typeof child === 'object') walk(child, visit);
  }
}

// Names this function body calls directly.
export function calleesOf(fnDecl) {
  const out = new Set();
  walk(fnDecl.body, (n) => {
    if (n.type === 'Call' && n.callee.type === 'Ident') out.add(n.callee.name);
    if (n.type === 'Spawn') out.add(n.name);
  });
  return out;
}

export class CallGraph {
  constructor() {
    this.edges = new Map();          // caller -> Set(callee)
  }

  define(name, fnDecl) {
    this.edges.set(name, calleesOf(fnDecl));
  }

  remove(name) { this.edges.delete(name); }

  callees(name) { return [...(this.edges.get(name) ?? [])]; }

  callers(name) {
    const out = [];
    for (const [caller, callees] of this.edges) {
      if (callees.has(name)) out.push(caller);
    }
    return out.sort();
  }

  // Everything that could be affected by a change to `name`, transitively.
  // Cycles are fine -- the visited set closes them.
  dependents(name) {
    const seen = new Set();
    const stack = [name];
    while (stack.length) {
      const current = stack.pop();
      for (const caller of this.callers(current)) {
        if (seen.has(caller)) continue;
        seen.add(caller);
        stack.push(caller);
      }
    }
    return [...seen].sort();
  }

  // A cycle through the graph means mutual recursion. Worth being able to see.
  cycles() {
    const found = [];
    const colour = new Map();
    const path = [];
    const visit = (name) => {
      colour.set(name, 'grey');
      path.push(name);
      for (const next of this.edges.get(name) ?? []) {
        if (!this.edges.has(next)) continue;
        if (colour.get(next) === 'grey') {
          found.push([...path.slice(path.indexOf(next)), next]);
        } else if (!colour.has(next)) {
          visit(next);
        }
      }
      path.pop();
      colour.set(name, 'black');
    };
    for (const name of this.edges.keys()) if (!colour.has(name)) visit(name);
    return found;
  }

  toMap() {
    const m = new Map();
    for (const [caller, callees] of this.edges) m.set(caller, [...callees].sort());
    return m;
  }
}

export function buildCallGraph(program) {
  const graph = new CallGraph();
  walk(program, (n) => {
    if (n.type === 'FnDecl') graph.define(n.fn.name, n.fn);
  });
  return graph;
}
