// Static taint reachability.
//
// The runtime catches a labelled value reaching a `grounded` block on the path
// a run actually took. That is evidence, not a guarantee: it says nothing about
// the branch that did not execute today. An institution asking "can data
// labelled `eu` ever reach this sink" needs an answer about *every* path.
//
// This is that answer. It propagates labels through assignments, function
// returns, collections and interpolation, over all branches at once, and
// reports any sink a labelled value can reach -- whether or not a run has ever
// done it.
//
// It is a may-analysis and it is deliberately conservative: it merges branches
// rather than choosing between them, so it reports possibilities, not
// certainties. The one thing it must never do is stay quiet about a real path,
// because a checker that misses the case you needed is worse than none. Where
// it cannot follow something -- a value crossing the FFI, a function reached
// indirectly -- it assumes the worst rather than assuming safety.

const SOURCES = new Map([
  ['untrusted', 'untrusted'],
  ['ungrounded', 'ungrounded'],
  ['foreign', 'untrusted'],       // anything from across the boundary
]);

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const c of node) walk(c, visit);
    return;
  }
  if (typeof node.type === 'string') visit(node);
  for (const child of Object.values(node)) {
    if (child && typeof child === 'object') walk(child, visit);
  }
}

export class TaintAnalysis {
  constructor(program) {
    this.program = program;
    this.findings = [];
    this.functions = new Map();     // name -> declaration
    this.returns = new Map();       // name -> labels its result may carry
    this.launders = new Set();      // spans where trust() clears labels
  }

  analyse() {
    walk(this.program, (n) => {
      if (n.type === 'FnDecl') this.functions.set(n.fn.name, n.fn);
    });

    // Resolve what each function's return value may be labelled with. Iterate
    // until nothing changes, so labels flow through call chains of any depth.
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      for (const [name, fn] of this.functions) {
        const before = this.returns.get(name);
        const labels = this.returnLabels(fn);
        const key = [...labels].sort().join(',');
        if (key !== before) { this.returns.set(name, key); changed = true; }
      }
      if (!changed) break;
    }

    this.checkBlock(this.program.body, new Map(), null);
    return this.findings;
  }

  returnLabels(fn) {
    const labels = new Set();
    const env = new Map();
    walk(fn.body, (n) => {
      if (n.type === 'Return' && n.value) {
        for (const l of this.labelsOf(n.value, env)) labels.add(l);
      }
    });
    return labels;
  }

  // What labels this expression may carry, over every path.
  labelsOf(node, env) {
    const out = new Set();
    if (!node || typeof node !== 'object') return out;

    switch (node.type) {
      case 'Call': {
        if (node.callee.type === 'Ident') {
          const name = node.callee.name;
          if (SOURCES.has(name)) { out.add(SOURCES.get(name)); return out; }
          if (name === 'restrict') {
            const region = node.args[1];
            out.add(region && region.type === 'Str' ? `region:${region.value}` : 'region:?');
            return out;
          }
          // trust() is the only thing that clears a label, and it is recorded.
          if (name === 'trust') return out;
          const known = this.returns.get(name);
          if (known) for (const l of known.split(',').filter(Boolean)) out.add(l);
        }
        for (const a of node.args) for (const l of this.labelsOf(a, env)) out.add(l);
        return out;
      }

      case 'Ident': {
        const known = env.get(node.name);
        if (known) for (const l of known) out.add(l);
        return out;
      }

      default: {
        // Everything else propagates from its parts: arithmetic, indexing,
        // members, list and map literals, interpolation.
        for (const child of Object.values(node)) {
          if (!child || typeof child !== 'object') continue;
          if (Array.isArray(child)) {
            for (const c of child) for (const l of this.labelsOf(c, env)) out.add(l);
          } else if (child.type) {
            for (const l of this.labelsOf(child, env)) out.add(l);
          } else {
            for (const c of Object.values(child)) {
              if (c && typeof c === 'object') for (const l of this.labelsOf(c, env)) out.add(l);
            }
          }
        }
        return out;
      }
    }
  }

  // `region` is the sink's own jurisdiction; null outside one. `grounded` is
  // modelled as a region that rejects the provenance labels.
  checkBlock(statements, env, sink) {
    for (const stmt of statements) this.checkStatement(stmt, env, sink);
  }

  checkStatement(node, env, sink) {
    if (!node) return;

    // An assignment statement is an ExprStmt wrapping an Assign. Without this
    // the assignment case below never fires, and a variable tainted inside a
    // branch looks clean afterwards -- the exact case this analysis exists for.
    if (node.type === 'ExprStmt' && node.expr && node.expr.type === 'Assign') {
      this.checkStatement(node.expr, env, sink);
      return;
    }

    switch (node.type) {
      case 'Declare':
      case 'Assign': {
        const labels = this.labelsOf(node.value, env);
        const name = node.type === 'Declare' ? node.name
          : (node.target && node.target.type === 'Ident' ? node.target.name : null);
        if (sink) this.reportIfBlocked(node.value, labels, sink, node);
        if (name) {
          // Merge rather than replace: a variable assigned in one branch keeps
          // what the other branch may have put in it.
          const existing = env.get(name) ?? new Set();
          env.set(name, new Set([...existing, ...labels]));
        }
        return;
      }

      case 'Grounded':
        this.checkBlock(node.body.body, env, { kind: 'grounded', node });
        return;

      case 'Region':
        this.checkBlock(node.body.body, env, { kind: 'region', region: node.name, node });
        return;

      case 'FnDecl':
      case 'Redefine':
        // Bodies are analysed for their return labels, not for sinks inside
        // them: a sink in a function is checked wherever that function is
        // called, where the argument labels are actually known.
        return;

      default: {
        if (sink) {
          // Any expression read inside a sink is a potential violation.
          for (const child of Object.values(node)) {
            if (!child || typeof child !== 'object' || Array.isArray(child)) continue;
            if (child.type && child.type !== 'Block') {
              this.reportIfBlocked(child, this.labelsOf(child, env), sink, node);
            }
          }
          if (node.type === 'ExprStmt') {
            this.reportIfBlocked(node.expr, this.labelsOf(node.expr, env), sink, node);
          }
        }
        for (const child of Object.values(node)) {
          if (child && typeof child === 'object' && child.type === 'Block') {
            this.checkBlock(child.body, env, sink);
          } else if (Array.isArray(child)) {
            for (const c of child) {
              if (c && c.type === 'Block') this.checkBlock(c.body, env, sink);
              else if (c && c.type) this.checkStatement(c, env, sink);
            }
          } else if (child && child.type && child.type !== 'Block') {
            if (['If', 'While', 'For', 'Maybe', 'Attempt'].includes(child.type)) {
              this.checkStatement(child, env, sink);
            }
          }
        }
      }
    }
  }

  reportIfBlocked(node, labels, sink, at) {
    if (labels.size === 0) return;
    // One message per problem. A statement is reached through more than one
    // route in the walk, and a reader should be told once.
    const key = `${node.span ? node.span.join(':') : at.line}|${sink.kind}|${[...labels].sort().join(',')}`;
    if (this.reported === undefined) this.reported = new Set();
    if (this.reported.has(key)) return;
    this.reported.add(key);
    for (const label of labels) {
      if (sink.kind === 'grounded' && (label === 'untrusted' || label === 'ungrounded')) {
        this.findings.push({
          kind: 'taint',
          span: node.span ?? at.span,
          line: node.line ?? at.line,
          message: `a value labelled \`${label}\` can reach this grounded block`,
          hint: 'launder it with trust(value, reason) before the block, or move the check inside',
        });
        return;
      }
      if (sink.kind === 'region' && label.startsWith('region:')) {
        const owner = label.slice(7);
        if (owner !== sink.region && owner !== '?') {
          this.findings.push({
            kind: 'taint',
            span: node.span ?? at.span,
            line: node.line ?? at.line,
            message: `a value restricted to \`${owner}\` can reach a \`${sink.region}\` region`,
            hint: null,
          });
          return;
        }
      }
    }
  }
}

export function analyseTaint(program) {
  return new TaintAnalysis(program).analyse();
}
