import { parse } from './parser.js';

// `smarsh fmt` — one canonical layout.
//
// Formatting is not a matter of taste worth anyone's time, so this offers no
// options. Two spaces, no semicolons, braces on the same line, blank lines
// between top-level declarations. The only thing it preserves from the original
// is comments and deliberate blank lines inside blocks, because those carry
// meaning the syntax tree does not.
//
// It works from the token stream rather than the AST for exactly that reason:
// an AST has thrown the comments away by the time you can walk it.

const INDENT = '  ';

class Printer {
  constructor(source, comments = []) {
    this.source = source;
    this.out = [];
    this.depth = 0;
    this.comments = comments.slice().sort((a, b) => a.start - b.start);
    this.next = 0;
  }

  // Emit every comment that appeared before this point in the original source.
  // A comment that sat on its own line stays on its own line; one that trailed
  // code is appended to the line that code produced.
  // Standalone comments above the coming statement. Each keeps whatever blank
  // line preceded it, which is what makes formatting settle after one pass:
  // otherwise a blank drifts across the comment block on every run.
  flushBefore(offset) {
    while (this.next < this.comments.length && this.comments[this.next].start < offset) {
      const c = this.comments[this.next++];
      if (!c.standalone) { this.attach(c); continue; }
      if (this.out.length > 0 && this.hadBlankBefore(c.start)) this.blank();
      for (const piece of c.text.split('\n')) this.line(piece.trim());
    }
  }


  // Comments that trailed the line just emitted. They have to be attached
  // before any blank line is added, or they end up hanging off the blank.
  flushTrailing(offset) {
    while (this.next < this.comments.length) {
      const c = this.comments[this.next];
      if (c.start >= offset || c.standalone) break;
      this.next += 1;
      this.attach(c);
    }
  }

  attach(comment) {
    const first = comment.text.split('\n')[0];
    if (this.out.length > 0 && this.out[this.out.length - 1] !== '') {
      this.out[this.out.length - 1] += `  ${first}`;
    } else {
      this.line(comment.text);
    }
  }

  flushRest() {
    this.flushBefore(Infinity);
  }

  // Was there a blank line here in the original? Blank lines are the author's
  // paragraphing and worth keeping.
  hadBlankBefore(offset) {
    if (offset === undefined || offset === null) return false;
    const before = this.source.slice(0, offset);
    const lastNewline = before.lastIndexOf('\n');
    if (lastNewline === -1) return false;
    return /\n[ \t\r]*\n[ \t\r]*$/.test(before.slice(0, lastNewline + 1));
  }

  line(text) {
    this.out.push(text === '' ? '' : INDENT.repeat(this.depth) + text);
  }

  blank() {
    if (this.out.length > 0 && this.out[this.out.length - 1] !== '') this.out.push('');
  }

  text() {
    // Never leave trailing blank lines, and always end with exactly one newline.
    while (this.out.length && this.out[this.out.length - 1] === '') this.out.pop();
    return `${this.out.join('\n')}\n`;
  }
}

// --- expressions -------------------------------------------------------------

const PRECEDENCE = {
  or: 1, and: 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5, '*': 6, '/': 6, '%': 6, '@': 6, '**': 8,
};

function expr(node, parentPrec = 0) {
  if (!node) return 'nil';
  switch (node.type) {
    case 'Num': return formatNumber(node.value);
    // The digits exactly as written -- reformatting money must not round it.
    case 'DecLit': return `${node.value}d`;
    case 'Str': return quote(node.value);
    case 'Bool': return node.value ? 'true' : 'false';
    case 'Nil': return 'nil';
    case 'Ident': return node.name;

    case 'Template': {
      let out = '"';
      for (const part of node.parts) {
        if (part.kind === 'text') out += quote(part.value).slice(1, -1);
        else out += `\${${expr(part.expr)}}`;
      }
      return `${out}"`;
    }

    case 'ListLit': return `[${node.elements.map((e) => expr(e)).join(', ')}]`;

    case 'MapLit': {
      if (node.entries.length === 0) return '{ }';
      const parts = node.entries.map((e) => `${expr(e.key)}: ${expr(e.value)}`);
      return `{ ${parts.join(', ')} }`;
    }

    case 'TensorLit': return `tensor ${expr(node.value)}`;

    case 'Unary': return node.op === 'not' ? `not ${expr(node.operand, 7)}` : `-${expr(node.operand, 7)}`;

    case 'Logical':
    case 'Binary': {
      const prec = PRECEDENCE[node.op] ?? 0;
      const text = `${expr(node.left, prec)} ${node.op} ${expr(node.right, prec + 1)}`;
      return prec < parentPrec ? `(${text})` : text;
    }

    case 'Assign': return `${expr(node.target)} = ${expr(node.value)}`;
    case 'Call': return `${expr(node.callee, 9)}(${node.args.map((a) => expr(a)).join(', ')})`;
    case 'Index': return `${expr(node.object, 9)}[${node.indices.map((i) => expr(i)).join(', ')}]`;
    case 'Member': return `${expr(node.object, 9)}.${node.name}`;

    case 'Fn': return `fn(${params(node)})${returns(node)} ${inlineBlock(node.body)}`;

    case 'Choose': {
      const arms = node.arms.map((a) => `${expr(a.weight)} => ${expr(a.value)}`);
      return `choose { ${arms.join(', ')} }`;
    }

    case 'Fork': return `fork ${expr(node.count)} ${inlineBlock(node.body)}`;
    case 'Spawn': return `spawn ${node.name}(${node.args.map((a) => expr(a)).join(', ')})`;

    case 'Match': {
      const arms = node.arms.map((a) =>
        `${pattern(a.pattern)}${a.guard ? ` when ${expr(a.guard)}` : ''} => ${expr(a.body)}`);
      return `match ${expr(node.subject)} { ${arms.join(', ')} }`;
    }

    default:
      throw new Error(
        `the formatter does not know the expression \`${node.type}\`; `
        + 'teach it before shipping the syntax',
      );
  }
}

// A string literal, re-quoted safely. `${` has to be escaped: the lexer already
// turned `\${` into literal text, and printing it back bare would silently turn
// it into an interpolation the author never wrote.
function quote(text) {
  return JSON.stringify(text).replace(/\$\{/g, '\\${');
}

// Print a number the way it was meant, not the way IEEE stores it.
function formatNumber(n) {
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n);
  return String(n);
}

function pattern(p) {
  switch (p.kind) {
    case 'wildcard': return '_';
    case 'bind': return p.name;
    case 'literal':
      if (p.value === null) return 'nil';
      if (typeof p.value === 'string') return JSON.stringify(p.value);
      return String(p.value);
    case 'list': return `[${p.items.map(pattern).join(', ')}]`;
    case 'record': return `${p.name}(${p.fields.map(pattern).join(', ')})`;
    default: return '_';
  }
}

function typeText(t) {
  if (!t) return '';
  if (t.kind === 'fn') return `fn(${t.params.map(typeText).join(', ')}) -> ${typeText(t.ret)}`;
  return t.args && t.args.length ? `${t.name}<${t.args.map(typeText).join(', ')}>` : t.name;
}

function params(fn) {
  const types = fn.paramTypes ?? [];
  return fn.params.map((p, i) => (types[i] ? `${p}: ${typeText(types[i])}` : p)).join(', ');
}

const returns = (fn) => (fn.returnType ? ` -> ${typeText(fn.returnType)}` : '');

// A block appearing inside an expression -- a lambda body, a fork body, a match
// arm. It has to stay on one line, because the surrounding expression is a
// string being built rather than lines being emitted.
//
// Statements are separated with `;`, which the grammar accepts everywhere. This
// used to emit a literal `{ ... }` placeholder for anything with more than one
// statement, which silently deleted the body. A formatter that loses code is a
// data-loss bug, not a cosmetic one.
function inlineBlock(block) {
  if (block.body.length === 0) return '{ }';
  return `{ ${block.body.map(oneLine).join('; ')} }`;
}

function oneLine(node) {
  switch (node.type) {
    case 'Declare': {
      const kind = node.mutable ? 'var' : 'let';
      const type = node.declared ? `: ${typeText(node.declared)}` : '';
      return `${kind} ${node.name}${type} = ${expr(node.value)}`;
    }
    case 'ExprStmt': return expr(node.expr);
    case 'Return': return node.value ? `return ${expr(node.value)}` : 'return';
    case 'Break': return 'break';
    case 'Continue': return 'continue';
    case 'If':
      return `if ${expr(node.test)} ${inlineBlock(node.then)}`
        + (node.alt ? ` else ${node.alt.type === 'Block' ? inlineBlock(node.alt) : oneLine(node.alt)}` : '');
    case 'While': return `while ${expr(node.test)} ${inlineBlock(node.body)}`;
    case 'For': return `for ${node.name} in ${expr(node.iter)} ${inlineBlock(node.body)}`;
    case 'Maybe':
      return `maybe ${expr(node.prob)} ${inlineBlock(node.then)}`
        + (node.alt ? ` else ${inlineBlock(node.alt)}` : '');
    case 'Block': return inlineBlock(node);
    case 'Grounded': return `grounded ${inlineBlock(node.body)}`;
    case 'Atomic': return `atomic ${inlineBlock(node.body)}`;
    case 'Secret': return `secret ${inlineBlock(node.body)}`;
    case 'Region': return `region ${JSON.stringify(node.name)} ${inlineBlock(node.body)}`;
    case 'Attempt':
      return `attempt ${inlineBlock(node.body)} rescue ${node.name} ${inlineBlock(node.handler)}`;
    case 'FnDecl':
      return `fn ${node.fn.name}(${params(node.fn)})${returns(node.fn)} ${inlineBlock(node.fn.body)}`;
    case 'RecordDecl': return `record ${node.name}(${node.fields.join(', ')})`;
    default: return expr(node.expr ?? node);
  }
}

// --- statements --------------------------------------------------------------

function statements(list, p) {
  let previous = null;
  for (const stmt of list) {
    const start = stmt.span ? stmt.span[0] : Infinity;
    p.flushTrailing(start);          // attach to the line just emitted

    // Comments carry their own preceding blank lines (see flushBefore), so the
    // only blank decided here is the one immediately above the statement.
    if (previous && needsBlankBefore(stmt, previous)) p.blank();
    p.flushBefore(start);            // standalone comments, above the statement
    // Keyed on output, not on `previous`: the first statement of a file often
    // sits below a header comment, and that blank line matters just as much.
    if (p.out.length > 0 && p.hadBlankBefore(start)) p.blank();
    statement(stmt, p);
    previous = stmt;
  }
  if (list.length > 0) p.flushTrailing(lastOffset(list));
}

// Where the final statement of a block ends, so a comment trailing it lands on
// its line rather than escaping to the enclosing scope.
function lastOffset(list) {
  const last = list[list.length - 1];
  return last.span ? last.span[1] + 1 : Infinity;
}

// Declarations get room around them. Consecutive one-line declarations of the
// same kind do not -- a column of records reads better packed than spaced.
function needsBlankBefore(stmt, previous) {
  const big = new Set(['FnDecl', 'AgentDecl', 'Redefine']);
  if (stmt.type === previous.type && (stmt.type === 'RecordDecl' || stmt.type === 'Import')) return false;
  return big.has(stmt.type) || big.has(previous.type);
}

function statement(node, p, prefix = '') {
  switch (node.type) {
    case 'Declare': {
      const kind = node.mutable ? 'var' : 'let';
      const type = node.declared ? `: ${typeText(node.declared)}` : '';
      const head = `${kind} ${node.name}${type} = `;
      if (emitTrailingBlock(head, node.value, p)) return;
      p.line(head + expr(node.value));
      return;
    }

    case 'FnDecl': {
      const fn = node.fn;
      const clauses = [];
      if (fn.needs.length) clauses.push(`needs ${fn.needs.join(', ')}`);
      for (const c of fn.requires) clauses.push(`requires ${c.src}`);
      for (const c of fn.ensures) clauses.push(`ensures ${c.src}`);

      const head = `${prefix}fn ${fn.name}(${params(fn)})${returns(fn)}`;
      if (clauses.length === 0) {
        p.line(`${head} {`);
      } else if (clauses.length === 1 && `${head} ${clauses[0]}`.length < 80) {
        p.line(`${head} ${clauses[0]} {`);
      } else {
        // Contracts on their own lines: they are the specification, and they
        // should be as readable as the body.
        p.line(head);
        p.depth += 1;
        for (const c of clauses) p.line(c);
        p.depth -= 1;
        p.line('{');
      }
      p.depth += 1;
      statements(fn.body.body, p);
      p.depth -= 1;
      p.line('}');
      return;
    }

    case 'RecordDecl': {
      const types = node.fieldTypes ?? [];
      const fields = node.fields.map((f, i) => (types[i] ? `${f}: ${typeText(types[i])}` : f));
      const head = `record ${node.name}(${fields.join(', ')})`;
      const invariants = node.invariants ?? [];
      if (invariants.length === 0) { p.line(head); return; }
      if (invariants.length === 1 && `${head} invariant ${invariants[0].src}`.length < 80) {
        p.line(`${head} invariant ${invariants[0].src}`);
        return;
      }
      p.line(head);
      p.depth += 1;
      for (const c of invariants) p.line(`invariant ${c.src}`);
      p.depth -= 1;
      return;
    }

    case 'ChoiceDecl': {
      p.line(`choice ${node.name} {`);
      p.depth += 1;
      for (const v of node.variants) {
        const types = v.fieldTypes ?? [];
        const fields = v.fields.map((f, i) => (types[i] ? `${f}: ${typeText(types[i])}` : f));
        // A variant carrying nothing is written without parentheses, because
        // that is how it is constructed and matched.
        const head = v.fields.length === 0 ? v.name : `${v.name}(${fields.join(', ')})`;
        const invariants = v.invariants ?? [];
        if (invariants.length === 0) { p.line(head); continue; }
        if (invariants.length === 1 && `${head} invariant ${invariants[0].src}`.length < 80) {
          p.line(`${head} invariant ${invariants[0].src}`);
          continue;
        }
        p.line(head);
        p.depth += 1;
        for (const c of invariants) p.line(`invariant ${c.src}`);
        p.depth -= 1;
      }
      p.depth -= 1;
      p.line('}');
      return;
    }

    case 'AgentDecl': {
      p.line(`agent ${node.name}(${node.params.join(', ')}) {`);
      p.depth += 1;
      statements(node.stateDecls, p);
      for (const [message, handler] of node.handlers) {
        p.blank();
        p.line(`on ${message}(${handler.params.join(', ')}) {`);
        p.depth += 1;
        statements(handler.body.body, p);
        p.depth -= 1;
        p.line('}');
      }
      p.depth -= 1;
      p.line('}');
      return;
    }

    case 'If': {
      p.line(`if ${expr(node.test)} {`);
      p.depth += 1;
      statements(node.then.body, p);
      p.depth -= 1;
      if (!node.alt) { p.line('}'); return; }
      if (node.alt.type === 'If') {
        const saved = p.out.pop();
        p.out.push(saved);
        p.line('} else if ' + expr(node.alt.test) + ' {');
        p.depth += 1;
        statements(node.alt.then.body, p);
        p.depth -= 1;
        if (node.alt.alt) {
          p.line('} else {');
          p.depth += 1;
          statements(node.alt.alt.body ?? [], p);
          p.depth -= 1;
        }
        p.line('}');
        return;
      }
      p.line('} else {');
      p.depth += 1;
      statements(node.alt.body, p);
      p.depth -= 1;
      p.line('}');
      return;
    }

    case 'While': return loopStatement(p, `while ${expr(node.test)}`, node);
    case 'For': return loopStatement(p, `for ${node.name} in ${expr(node.iter)}`, node);
    case 'Using': return wrap(p, `using ${expr(node.grant)} {`, node.body.body);
    case 'Authority': return wrap(p, `authority ${expr(node.who)} {`, node.body.body);
    case 'ReleaseTo': return wrap(p, `release_to ${expr(node.to)} {`, node.body.body);
    case 'VouchedBy': return wrap(p, `vouched_by ${expr(node.by)} {`, node.body.body);
    case 'Block': return wrap(p, '{', node.body);
    case 'Grounded': return wrap(p, 'grounded {', node.body.body);
    case 'Atomic': return wrap(p, 'atomic {', node.body.body);
    case 'Secret': return wrap(p, 'secret {', node.body.body);
    case 'Region': return wrap(p, `region ${JSON.stringify(node.name)} {`, node.body.body);
    case 'Budget': return wrap(p, `budget ${node.kind} ${expr(node.amount)} {`, node.body.body);
    case 'Device':
      return wrap(p, `device ${expr(node.target)}${node.threads ? ` ${expr(node.threads)}` : ''} {`, node.body.body);

    case 'Maybe': {
      p.line(`maybe ${expr(node.prob)} {`);
      p.depth += 1;
      statements(node.then.body, p);
      p.depth -= 1;
      if (node.alt) {
        p.line('} else {');
        p.depth += 1;
        statements(node.alt.body ?? [], p);
        p.depth -= 1;
      }
      p.line('}');
      return;
    }

    case 'Attempt': {
      p.line('attempt {');
      p.depth += 1;
      statements(node.body.body, p);
      p.depth -= 1;
      p.line(`} rescue ${node.name} {`);
      p.depth += 1;
      statements(node.handler.body, p);
      p.depth -= 1;
      p.line('}');
      return;
    }

    case 'Return':
      if (node.value && emitTrailingBlock('return ', node.value, p)) return;
      p.line(node.value ? `return ${expr(node.value)}` : 'return');
      return;
    case 'Break': p.line('break'); return;
    case 'Continue': p.line('continue'); return;
    case 'ExprStmt':
      if (emitTrailingBlock('', node.expr, p)) return;
      p.line(expr(node.expr));
      return;
    case 'Import':
      p.line(`import ${JSON.stringify(node.path)}${node.alias ? ` as ${node.alias}` : ''}`);
      return;

    case 'Redefine':
      // The keyword is not decoration: dropping it turns a redefinition into a
      // second declaration of the same name, which is a different program.
      if (node.kind === 'fn') { statement({ type: 'FnDecl', fn: node.fn }, p, 'redefine '); return; }
      p.line(`redefine on ${node.agentName}.${node.message}(${node.params.join(', ')}) {`);
      p.depth += 1;
      statements(node.body.body, p);
      p.depth -= 1;
      p.line('}');
      return;

    // Never a placeholder. A formatter that emits `<Whatever>` for a node it
    // does not know has silently deleted the user's code and produced something
    // that will not even parse. This has happened twice; failing loudly is the
    // only version of this branch that is safe.
    default:
      throw new Error(
        `the formatter does not know the statement \`${node.type}\`; `
        + 'teach it before shipping the syntax, because the alternative is losing code',
      );
  }
}

// An expression whose body is a block -- a fork, a lambda -- laid out over
// several lines instead of squashed onto one. Without this a five-line fork
// body becomes a 120-character line of semicolons, which is valid and unusable.
function emitTrailingBlock(head, node, p) {
  if (!node) return false;
  let open = null;
  let block = null;
  if (node.type === 'Fork') { open = `fork ${expr(node.count)} {`; block = node.body; }
  else if (node.type === 'Fn') { open = `fn(${params(node)})${returns(node)} {`; block = node.body; }
  else return false;

  if (block.body.length < 2) return false;    // short bodies read better inline

  p.line(head + open);
  p.depth += 1;
  statements(block.body, p);
  p.depth -= 1;
  p.line('}');
  return true;
}

// A loop's contracts sit between its header and its body, one per line, the
// way a function's do. They are the specification and should read like it.
function loopStatement(p, head, node) {
  const invariants = node.invariants ?? [];
  if (invariants.length === 0 && !node.variant) return wrap(p, `${head} {`, node.body.body);

  const clauses = [
    ...invariants.map((c) => `invariant ${c.src}`),
    ...(node.variant ? [`variant ${node.variant.src}`] : []),
  ];
  if (clauses.length === 1 && `${head} ${clauses[0]}`.length < 80) {
    return wrap(p, `${head} ${clauses[0]} {`, node.body.body);
  }
  p.line(head);
  p.depth += 1;
  for (const c of clauses) p.line(c);
  p.depth -= 1;
  return wrap(p, '{', node.body.body);
}

function wrap(p, head, body) {
  p.line(head);
  p.depth += 1;
  statements(body, p);
  p.depth -= 1;
  p.line('}');
}

// --- entry point -------------------------------------------------------------

// Exposed so a test can prove an unknown construct stops the formatter.
export function statementPrinterFor(node) {
  return statement(node, new Printer('', []));
}

export function formatSource(source, file = '<source>') {
  const program = parse(source, file);
  const printer = new Printer(source, program.comments);
  statements(program.body, printer);
  printer.flushRest();
  return printer.text();
}

// Formatting must be a fixed point: formatting twice changes nothing. If it
// does not hold, the formatter is losing or inventing something.
export function isStable(source, file = '<source>') {
  const once = formatSource(source, file);
  const twice = formatSource(once, file);
  return once === twice;
}
