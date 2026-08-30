import { tokenize } from './lexer.js';
import { smarshError, SmarshError } from './errors.js';

// Recursive-descent parser producing a plain-object AST.
//
// Precedence, loosest to tightest:
//   =  |  or  |  and  |  == !=  |  < <= > >=  |  + -  |  * / % @  |  unary  |
//   **  |  call/index/member  |  primary

export class Parser {
  constructor(source, file = '<script>') {
    this.source = source;
    this.file = file;
    this.tokens = tokenize(source);
    this.pos = 0;
  }

  // --- token helpers -------------------------------------------------------

  peek(offset = 0) { return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]; }
  get current() { return this.peek(); }
  get line() { return this.current.line; }
  advance() { return this.tokens[this.pos++]; }

  check(type, value = undefined) {
    const t = this.current;
    return t.type === type && (value === undefined || t.value === value);
  }
  checkOp(value) { return this.check('op', value); }
  checkKw(value) { return this.check('kw', value); }

  match(type, value = undefined) {
    if (this.check(type, value)) { this.advance(); return true; }
    return false;
  }
  matchOp(value) { return this.match('op', value); }
  matchKw(value) { return this.match('kw', value); }

  // A contextual keyword: an ordinary identifier everywhere except the one
  // position where it cannot mean anything else. `shape` says what must follow.
  //
  //   'block'  region "eu" { }     the word, then a string or name
  //   'brace'  secret { }          the word, then a block
  //   'ident'  budget steps 5 { }  the word, then a bare word
  //   'name'   record Point(x, y)  the word, a name, then a paren
  matchSoft(word, shape) {
    if (!this.check('ident', word)) return false;
    const next = this.peek(1);
    const after = this.peek(2);
    let fits = false;
    if (shape === 'block') fits = next.type === 'str' || next.type === 'ident';
    else if (shape === 'brace') fits = next.type === 'op' && next.value === '{';
    else if (shape === 'ident') fits = next.type === 'ident';
    else if (shape === 'name') fits = next.type === 'ident' && after.type === 'op' && after.value === '(';
    if (!fits) return false;
    this.advance();
    return true;
  }

  expect(type, value, what) {
    if (this.check(type, value)) return this.advance();
    const got = this.current.type === 'eof' ? 'end of file' : `'${this.current.value}'`;
    throw smarshError('SyntaxError', `expected ${what ?? `'${value}'`}, found ${got}`, this.line);
  }
  expectOp(value, what) { return this.expect('op', value, what); }

  // Optional statement terminator -- semicolons are allowed, never required.
  terminator() { while (this.matchOp(';')); }

  // --- spans ---------------------------------------------------------------
  //
  // Every node records the exact stretch of source it came from, so a
  // diagnostic can underline the expression that is actually wrong rather than
  // gesturing at a line. Each precedence level below is a thin wrapper that
  // stamps the span of whatever it parsed, which keeps the span logic in one
  // place instead of at the thirty-odd sites that build nodes.

  spanned(startTok, node) {
    if (node && typeof node === 'object' && node.type) {
      const prev = this.tokens[Math.max(0, this.pos - 1)];
      node.span = [startTok.start, prev.end];
      if (node.line === undefined) node.line = startTok.line;
    }
    return node;
  }

  statement() { const t = this.current; return this.spanned(t, this.statementInner()); }
  assignment() { const t = this.current; return this.spanned(t, this.assignmentInner()); }
  logicalOr() { const t = this.current; return this.spanned(t, this.logicalOrInner()); }
  logicalAnd() { const t = this.current; return this.spanned(t, this.logicalAndInner()); }
  equality() { const t = this.current; return this.spanned(t, this.equalityInner()); }
  comparison() { const t = this.current; return this.spanned(t, this.comparisonInner()); }
  additive() { const t = this.current; return this.spanned(t, this.additiveInner()); }
  multiplicative() { const t = this.current; return this.spanned(t, this.multiplicativeInner()); }
  unary() { const t = this.current; return this.spanned(t, this.unaryInner()); }
  power() { const t = this.current; return this.spanned(t, this.powerInner()); }
  callChain() { const t = this.current; return this.spanned(t, this.callChainInner()); }
  primary() { const t = this.current; return this.spanned(t, this.primaryInner()); }

  // --- entry point ---------------------------------------------------------

  parseProgram() {
    const body = [];
    while (!this.check('eof')) body.push(this.statement());
    return { type: 'Program', body, comments: this.tokens.comments ?? [], source: this.source };
  }

  // Parse for a tool rather than for execution: keep going after a syntax
  // error so a file with four mistakes reports four, not one at a time across
  // four edit-run cycles. After an error, skip to something that plausibly
  // starts a new statement, so one stray brace does not cascade into noise.
  parseRecovering(limit = 25) {
    const body = [];
    const errors = [];
    while (!this.check('eof') && errors.length < limit) {
      const before = this.pos;
      try {
        body.push(this.statement());
      } catch (e) {
        if (!(e instanceof SmarshError)) throw e;
        errors.push(e);
        if (this.pos === before) this.advance();   // always make progress
        this.recover();
      }
    }
    return { program: { type: 'Program', body, comments: this.tokens.comments ?? [], source: this.source }, errors };
  }

  recover() {
    const starters = new Set([
      'let', 'var', 'fn', 'if', 'while', 'for', 'return', 'import', 'agent',
      'record', 'match', 'attempt', 'grounded', 'region', 'atomic', 'secret',
      'budget', 'device', 'redefine', 'break', 'continue', 'maybe',
    ]);
    let depth = 0;
    while (!this.check('eof')) {
      const t = this.current;
      if (t.type === 'op' && t.value === '{') depth += 1;
      else if (t.type === 'op' && t.value === '}') {
        if (depth === 0) { this.advance(); return; }
        depth -= 1;
      } else if (t.type === 'op' && t.value === ';' && depth === 0) {
        this.advance();
        return;
      } else if (depth === 0 && t.nlBefore
          && ((t.type === 'kw' && starters.has(t.value)) || (t.type === 'ident' && t.value === 'record'))) {
        return;
      }
      this.advance();
    }
  }

  // --- statements ----------------------------------------------------------

  statementInner() {
    const line = this.line;

    if (this.checkKw('let') || this.checkKw('var')) {
      const mutable = this.advance().value === 'var';
      const name = this.expect('ident', undefined, 'a variable name').value;
      const declared = this.matchOp(':') ? this.typeAnnotation() : null;
      this.expectOp('=', "'=' after a variable name");
      const value = this.expression();
      this.terminator();
      return { type: 'Declare', name, value, mutable, declared, line };
    }

    if (this.checkKw('fn') && this.peek(1).type === 'ident') {
      this.advance();
      const name = this.advance().value;
      const fn = this.functionRest(name, line);
      return { type: 'FnDecl', fn, line };
    }

    if (this.matchKw('if')) return this.ifStatement(line);
    if (this.matchKw('while')) {
      const test = this.expression();
      const { invariants, variant } = this.loopContracts();
      const body = this.block();
      return { type: 'While', test, invariants, variant, body, line };
    }
    if (this.matchKw('for')) {
      const name = this.expect('ident', undefined, 'a loop variable').value;
      this.expect('kw', 'in', "'in'");
      const iter = this.expression();
      const { invariants, variant } = this.loopContracts();
      const body = this.block();
      return { type: 'For', name, iter, invariants, variant, body, line };
    }
    if (this.matchKw('return')) {
      let value = null;
      if (!this.checkOp(';') && !this.checkOp('}') && !this.check('eof')) value = this.expression();
      this.terminator();
      return { type: 'Return', value, line };
    }
    if (this.matchKw('break')) { this.terminator(); return { type: 'Break', line }; }
    if (this.matchKw('continue')) { this.terminator(); return { type: 'Continue', line }; }

    // maybe <prob> { ... } else { ... }
    if (this.matchKw('maybe')) {
      const prob = this.expression();
      const then = this.block();
      let alt = null;
      if (this.matchKw('else')) alt = this.checkKw('if') ? this.statement() : this.block();
      return { type: 'Maybe', prob, then, alt, line };
    }

    // attempt { ... } rescue e { ... }
    if (this.matchKw('attempt')) {
      const body = this.block();
      this.expect('kw', 'rescue', "'rescue' after an attempt block");
      const name = this.expect('ident', undefined, 'a name for the failure').value;
      const handler = this.block();
      return { type: 'Attempt', body, name, handler, line };
    }

    // choice Shape {
    //   Circle(radius)
    //   Rect(width, height)
    //   Empty
    // }
    //
    // Contextual, like `record`: only `choice <Name> {` is a declaration, so a
    // program may still use `choice` as a name of its own.
    if (this.check('ident', 'choice') && this.peek(1).type === 'ident'
        && this.peek(2).type === 'op' && this.peek(2).value === '{') {
      this.advance();
      const name = this.advance().value;
      this.expectOp('{', "'{' after the choice name");
      const variants = [];
      while (!this.checkOp('}') && !this.check('eof')) {
        const vline = this.line;
        const vname = this.expect('ident', undefined, 'a variant name').value;
        const fields = [];
        const fieldTypes = [];
        // `Empty`, with no parentheses, is a variant that carries nothing.
        if (this.matchOp('(')) {
          if (!this.checkOp(')')) {
            do {
              fields.push(this.expect('ident', undefined, 'a field name').value);
              fieldTypes.push(this.matchOp(':') ? this.typeAnnotation() : null);
            } while (this.matchOp(','));
          }
          this.expectOp(')', "')' to close the variant fields");
        }
        const invariants = [];
        while (this.matchKw('invariant')) invariants.push(this.contract());
        variants.push({ name: vname, fields, fieldTypes, invariants, line: vline });
        // Separators between variants are allowed, not required.
        if (!this.matchOp(',')) this.matchOp(';');
      }
      this.expectOp('}', "'}' to close the choice");
      if (variants.length === 0) {
        throw smarshError('SyntaxError', 'a choice needs at least one variant', line);
      }
      const seen = new Set();
      for (const v of variants) {
        if (seen.has(v.name)) {
          throw smarshError('SyntaxError',
            `\`${name}\` declares the variant \`${v.name}\` twice`, v.line);
        }
        seen.add(v.name);
      }
      this.terminator();
      return { type: 'ChoiceDecl', name, variants, line };
    }

    // record Point(x, y)  -- an immutable data carrier.
    // Contextual: only this exact shape is a declaration.
    if (this.check('ident', 'record') && this.peek(1).type === 'ident'
        && this.peek(2).type === 'op' && this.peek(2).value === '(') {
      this.advance();
      const name = this.advance().value;
      this.expectOp('(', "'(' after the record name");
      const fields = [];
      const fieldTypes = [];
      if (!this.checkOp(')')) {
        do {
          fields.push(this.expect('ident', undefined, 'a field name').value);
          fieldTypes.push(this.matchOp(':') ? this.typeAnnotation() : null);
        } while (this.matchOp(','));
      }
      this.expectOp(')', "')' to close the record fields");
      // record Account(balance) invariant balance >= 0
      //
      // Eiffel's class invariant: a promise about the value itself, checked
      // when one is built and again whenever `.with()` produces a new one, so a
      // record that satisfies it can never be observed not satisfying it.
      const invariants = [];
      while (this.matchKw('invariant')) invariants.push(this.contract());
      this.terminator();
      return { type: 'RecordDecl', name, fields, fieldTypes, invariants, line };
    }

    // agent Name(args) { var state = ...   on message(a, b) { ... } }
    if (this.checkKw('agent') && this.peek(1).type === 'ident') {
      this.advance();
      const name = this.advance().value;

      const params = [];
      if (this.matchOp('(')) {
        if (!this.checkOp(')')) {
          do { params.push(this.expect('ident', undefined, 'a parameter name').value); }
          while (this.matchOp(','));
        }
        this.expectOp(')', "')' to close the agent's parameters");
      }

      this.expectOp('{', "'{' to open the agent body");
      const stateDecls = [];
      const handlers = new Map();
      while (!this.checkOp('}') && !this.check('eof')) {
        if (this.matchKw('on')) {
          const hline = this.line;
          const message = this.expect('ident', undefined, 'a message name').value;
          if (handlers.has(message)) {
            throw smarshError('SyntaxError', `agent ${name} handles '${message}' twice`, hline);
          }
          this.expectOp('(', "'(' after the message name");
          const hparams = [];
          if (!this.checkOp(')')) {
            do { hparams.push(this.expect('ident', undefined, 'a parameter name').value); }
            while (this.matchOp(','));
          }
          this.expectOp(')', "')' to close the handler parameters");
          handlers.set(message, { params: hparams, body: this.block(), line: hline });
        } else {
          stateDecls.push(this.statement());
        }
      }
      this.expectOp('}', "'}' to close the agent body");
      return { type: 'AgentDecl', name, params, stateDecls, handlers, line };
    }

    // budget steps 50000 { ... }  -- cannot be raised or caught from inside
    if (this.matchSoft('budget', 'ident')) {
      const kindTok = this.expect('ident', undefined, "'steps', 'tokens' or 'memory'");
      if (!['steps', 'tokens', 'memory'].includes(kindTok.value)) {
        throw smarshError('SyntaxError',
          `a budget is measured in 'steps', 'tokens' or 'memory', not '${kindTok.value}'`, kindTok.line);
      }
      const amount = this.expression();
      return { type: 'Budget', kind: kindTok.value, amount, body: this.block(), line };
    }

    // import "./lib.smarsh"            -- bring its names into this scope
    // import "./lib.smarsh" as lib     -- bind them under one name
    if (this.matchKw('import')) {
      const pathTok = this.expect('str', undefined, 'a quoted module path');
      let alias = null;
      if (this.matchKw('as')) {
        alias = this.expect('ident', undefined, 'a name for the module').value;
      }
      this.terminator();
      return { type: 'Import', path: pathTok.value, alias, line };
    }

    // redefine fn name(...) { ... }   or   redefine on Agent.message(...) { ... }
    if (this.matchKw('redefine')) {
      if (this.matchKw('fn')) {
        const name = this.expect('ident', undefined, 'the name of the function being replaced').value;
        return { type: 'Redefine', kind: 'fn', fn: this.functionRest(name, line), line };
      }
      this.expect('kw', 'on', "'fn' or 'on' after redefine");
      const agentName = this.expect('ident', undefined, 'an agent name').value;
      this.expectOp('.', "'.' between the agent and the message");
      const message = this.expect('ident', undefined, 'a message name').value;
      this.expectOp('(', "'(' after the message name");
      const params = [];
      if (!this.checkOp(')')) {
        do { params.push(this.expect('ident', undefined, 'a parameter name').value); }
        while (this.matchOp(','));
      }
      this.expectOp(')', "')' to close the parameters");
      return { type: 'Redefine', kind: 'handler', agentName, message, params, body: this.block(), line };
    }

    // device "workers" { ... }  or  device "workers" 4 { ... }
    if (this.matchSoft('device', 'block')) {
      const target = this.expression();
      const threads = this.checkOp('{') ? null : this.expression();
      return { type: 'Device', target, threads, body: this.block(), line };
    }

    // atomic { ... }  -- every ledger append inside lands, or none does
    if (this.matchSoft('atomic', 'brace')) {
      return { type: 'Atomic', body: this.block(), line };
    }

    // secret { ... }  -- secrets created inside are shredded on the way out
    if (this.matchSoft('secret', 'brace')) {
      return { type: 'Secret', body: this.block(), line };
    }

    // using access { ... }  -- hold a delegated capability for this block only
    if (this.matchKw('using')) {
      const grant = this.expression();
      const body = this.block();
      return { type: 'Using', grant, body, line };
    }

    // authority "alice" { ... }  -- act for a principal, so their policies can
    // be declassified inside. The run must have been started holding it.
    if (this.matchSoft('authority', 'block')) {
      const who = this.expression();
      const body = this.block();
      return { type: 'Authority', who, body, line };
    }

    // release_to "bob" { ... }  -- code that hands data to a party. Reading a
    // value whose owners do not all permit bob is refused here, at the boundary
    // where it would actually leave.
    if (this.check('ident', 'release_to') && this.peek(1).type !== 'op') {
      this.advance();
      const to = this.expression();
      const body = this.block();
      return { type: 'ReleaseTo', to, body, line };
    }

    // vouched_by "alice" { ... }  -- the dual. Code that will only act on what
    // alice stands behind. Reading a labelled value alice does not vouch for is
    // refused here, which is where a vouch lost by composition shows up.
    if (this.check('ident', 'vouched_by') && this.peek(1).type !== 'op') {
      this.advance();
      const by = this.expression();
      const body = this.block();
      return { type: 'VouchedBy', by, body, line };
    }

    // grounded { ... }  -- no ungrounded/untrusted value may be read inside
    if (this.matchSoft('grounded', 'brace')) {
      const body = this.block();
      return { type: 'Grounded', body, line };
    }

    // region "eu" { ... }  -- no value tagged to another jurisdiction may be read
    if (this.matchSoft('region', 'block')) {
      const name = this.expect('str', undefined, 'a region name string').value;
      const body = this.block();
      return { type: 'Region', name, body, line };
    }

    if (this.checkOp('{')) return this.block();

    const expr = this.expression();
    this.terminator();
    return { type: 'ExprStmt', expr, line };
  }

  ifStatement(line) {
    const test = this.expression();
    const then = this.block();
    let alt = null;
    if (this.matchKw('else')) {
      alt = this.matchKw('if') ? this.ifStatement(this.line) : this.block();
    }
    return { type: 'If', test, then, alt, line };
  }

  block() {
    const line = this.line;
    this.expectOp('{', "'{'");
    const body = [];
    while (!this.checkOp('}') && !this.check('eof')) body.push(this.statement());
    this.expectOp('}', "'}' to close the block");
    return { type: 'Block', body, line };
  }

  // A type annotation. Optional everywhere -- this is a gradual type system,
  // so an unannotated program is a valid program.
  //
  //   num | str | bool | nil | dyn | tensor
  //   list<num> | map<str>
  //   fn(num, str) -> bool
  typeAnnotation() {
    const t0 = this.current;
    if (this.checkKw('fn')) {
      this.advance();
      this.expectOp('(', "'(' after `fn` in a type");
      const params = [];
      if (!this.checkOp(')')) {
        do { params.push(this.typeAnnotation()); } while (this.matchOp(','));
      }
      this.expectOp(')', "')' to close the parameter types");
      let ret = { kind: 'name', name: 'dyn', args: [], line: t0.line };
      if (this.matchOp('-')) {
        this.expectOp('>', "'->' before the return type");
        ret = this.typeAnnotation();
      }
      return { kind: 'fn', params, ret, line: t0.line, span: [t0.start, this.tokens[this.pos - 1].end] };
    }

    const tok = this.current;
    if (tok.type !== 'ident' && tok.type !== 'kw') {
      throw smarshError('SyntaxError', `expected a type, found \`${tok.value}\``, tok.line);
    }
    this.advance();
    const args = [];
    if (this.matchOp('<')) {
      do { args.push(this.typeAnnotation()); } while (this.matchOp(','));
      this.expectOp('>', "'>' to close the type arguments");
    }
    return { kind: 'name', name: tok.value, args, line: tok.line, span: [tok.start, this.tokens[this.pos - 1].end] };
  }

  // fn name(a, b) needs net requires a > 0 ensures result > 0 { ... }
  //
  // Annotations ride alongside `params` rather than replacing it, so every
  // consumer that treats a parameter list as names keeps working untouched.
  functionRest(name, line) {
    this.expectOp('(', "'(' after the function name");
    const params = [];
    const paramTypes = [];
    if (!this.checkOp(')')) {
      do {
        params.push(this.expect('ident', undefined, 'a parameter name').value);
        paramTypes.push(this.matchOp(':') ? this.typeAnnotation() : null);
      } while (this.matchOp(','));
    }
    this.expectOp(')', "')' to close the parameter list");

    let returnType = null;
    if (this.checkOp('-') && this.peek(1).type === 'op' && this.peek(1).value === '>') {
      this.advance();
      this.advance();
      returnType = this.typeAnnotation();
    }

    const needs = [];
    const requires = [];
    const ensures = [];
    for (;;) {
      if (this.matchKw('needs')) {
        do {
          needs.push(this.expect('ident', undefined, 'a capability name').value);
        } while (this.matchOp(','));
        continue;
      }
      if (this.checkKw('requires')) { this.advance(); requires.push(this.contract()); continue; }
      if (this.checkKw('ensures')) { this.advance(); ensures.push(this.contract()); continue; }
      break;
    }

    const body = this.block();
    return { type: 'Fn', name, params, paramTypes, returnType, body, needs, requires, ensures, line };
  }

  // Patterns, for `match`:
  //
  //   42, "text", true, nil     a literal, matched by value
  //   Point(x, y)               a record, destructured into new bindings
  //   Point(0, y)               ...with a literal in one position
  //   [a, b]                    a list of exactly that length
  //   name                      binds anything to `name`
  //   _                         matches anything, binds nothing
  pattern() {
    const t0 = this.current;
    const line = t0.line;

    if (this.check('num')) return { kind: 'literal', value: this.advance().value, line };
    if (this.check('str')) return { kind: 'literal', value: this.advance().value, line };
    if (this.matchKw('true')) return { kind: 'literal', value: true, line };
    if (this.matchKw('false')) return { kind: 'literal', value: false, line };
    if (this.matchKw('nil')) return { kind: 'literal', value: null, line };

    if (this.matchOp('-') && this.check('num')) {
      return { kind: 'literal', value: -this.advance().value, line };
    }

    if (this.matchOp('[')) {
      const items = [];
      if (!this.checkOp(']')) {
        do {
          if (this.checkOp(']')) break;
          items.push(this.pattern());
        } while (this.matchOp(','));
      }
      this.expectOp(']', "']' to close the list pattern");
      return { kind: 'list', items, line };
    }

    if (this.check('ident')) {
      const name = this.advance().value;
      if (this.checkOp('(')) {
        this.advance();
        const fields = [];
        if (!this.checkOp(')')) {
          do { fields.push(this.pattern()); } while (this.matchOp(','));
        }
        this.expectOp(')', "')' to close the record pattern");
        return { kind: 'record', name, fields, line };
      }
      if (name === '_') return { kind: 'wildcard', line };
      return { kind: 'bind', name, line };
    }

    throw smarshError('SyntaxError', `expected a pattern, found \`${t0.value}\``, line);
  }

  // What a loop promises about itself.
  //
  //   while i < n
  //     invariant total >= 0
  //     variant n - i
  //   { ... }
  //
  // The invariant is checked before the loop and after every pass. The variant
  // is Eiffel's termination argument: a quantity that must stay non-negative
  // and strictly decrease on each pass. A loop with a variant cannot spin
  // forever without the runtime noticing which promise it broke.
  loopContracts() {
    const invariants = [];
    let variant = null;
    for (;;) {
      if (this.matchKw('invariant')) { invariants.push(this.contract()); continue; }
      if (this.checkKw('variant')) {
        const line = this.line;
        this.advance();
        if (variant) throw smarshError('SyntaxError', 'a loop has at most one variant', line);
        variant = this.contract();
        continue;
      }
      break;
    }
    return { invariants, variant };
  }

  // A contract predicate, plus its own source text so a violation can quote it.
  contract() {
    const startTok = this.current;
    const expr = this.expression();
    const endTok = this.tokens[this.pos - 1];
    return { expr, src: this.source.slice(startTok.start, endTok.end).trim(), line: startTok.line };
  }

  // --- expressions ---------------------------------------------------------

  expression() { return this.assignment(); }

  assignmentInner() {
    const left = this.logicalOr();
    if (this.checkOp('=')) {
      const line = this.line;
      this.advance();
      const value = this.assignment();
      if (left.type !== 'Ident' && left.type !== 'Index' && left.type !== 'Member') {
        throw smarshError('SyntaxError', 'left side of = is not something that can be assigned to', line);
      }
      return { type: 'Assign', target: left, value, line };
    }
    return left;
  }

  logicalOrInner() {
    let left = this.logicalAnd();
    while (this.checkKw('or') || this.checkOp('||')) {
      const line = this.line;
      this.advance();
      left = { type: 'Logical', op: 'or', left, right: this.logicalAnd(), line };
    }
    return left;
  }

  logicalAndInner() {
    let left = this.equality();
    while (this.checkKw('and') || this.checkOp('&&')) {
      const line = this.line;
      this.advance();
      left = { type: 'Logical', op: 'and', left, right: this.equality(), line };
    }
    return left;
  }

  equalityInner() {
    let left = this.comparison();
    while (this.checkOp('==') || this.checkOp('!=')) {
      const line = this.line;
      const op = this.advance().value;
      left = { type: 'Binary', op, left, right: this.comparison(), line };
    }
    return left;
  }

  comparisonInner() {
    let left = this.additive();
    while (this.checkOp('<') || this.checkOp('<=') || this.checkOp('>') || this.checkOp('>=')) {
      const line = this.line;
      const op = this.advance().value;
      left = { type: 'Binary', op, left, right: this.additive(), line };
    }
    return left;
  }

  additiveInner() {
    let left = this.multiplicative();
    while (this.checkOp('+') || this.checkOp('-')) {
      const line = this.line;
      const op = this.advance().value;
      left = { type: 'Binary', op, left, right: this.multiplicative(), line };
    }
    return left;
  }

  multiplicativeInner() {
    let left = this.unary();
    while (this.checkOp('*') || this.checkOp('/') || this.checkOp('%') || this.checkOp('@')) {
      const line = this.line;
      const op = this.advance().value;
      left = { type: 'Binary', op, left, right: this.unary(), line };
    }
    return left;
  }

  unaryInner() {
    if (this.checkOp('-') || this.checkOp('!') || this.checkKw('not')) {
      const line = this.line;
      const op = this.advance().value === '-' ? '-' : 'not';
      return { type: 'Unary', op, operand: this.unary(), line };
    }
    return this.power();
  }

  powerInner() {
    const base = this.callChain();
    if (this.checkOp('**')) {
      const line = this.line;
      this.advance();
      return { type: 'Binary', op: '**', left: base, right: this.unary(), line };
    }
    return base;
  }

  callChainInner() {
    let expr = this.primary();
    for (;;) {
      // A '(' or '[' on a new line starts a new statement; it does not call or
      // index the previous line's result. A '.' may still continue a chain.
      if ((this.checkOp('(') || this.checkOp('[')) && this.current.nlBefore) return expr;

      if (this.checkOp('(')) {
        const line = this.line;
        this.advance();
        const args = [];
        if (!this.checkOp(')')) {
          do { args.push(this.expression()); } while (this.matchOp(','));
        }
        this.expectOp(')', "')' to close the argument list");
        expr = { type: 'Call', callee: expr, args, line };
      } else if (this.checkOp('[')) {
        const line = this.line;
        this.advance();
        const indices = [];
        do { indices.push(this.expression()); } while (this.matchOp(','));
        this.expectOp(']', "']' to close the index");
        expr = { type: 'Index', object: expr, indices, line };
      } else if (this.checkOp('.')) {
        const line = this.line;
        this.advance();
        const tok = this.current;
        if (tok.type !== 'ident' && tok.type !== 'kw') {
          throw smarshError('SyntaxError', `expected a property name after '.', found '${tok.value}'`, line);
        }
        this.advance();
        expr = { type: 'Member', object: expr, name: tok.value, line };
      } else {
        return expr;
      }
    }
  }

  primaryInner() {
    const t = this.current;
    const line = t.line;

    if (t.type === 'num') { this.advance(); return { type: 'Num', value: t.value, line }; }
    // `19.99d` -- the digits as written, handed to `dec` unchanged.
    if (t.type === 'dec') { this.advance(); return { type: 'DecLit', value: t.value, line }; }
    if (t.type === 'str') {
      this.advance();
      // `raw` is carried purely so the formatter can print it back as a raw
      // string; nothing about evaluation depends on it.
      return { type: 'Str', value: t.value, raw: t.raw === true, line };
    }

    // "a ${b} c" -- the embedded pieces are parsed here, as full expressions.
    if (t.type === 'template') {
      this.advance();
      const parts = t.value.map((part) => {
        if (part.text !== undefined) return { kind: 'text', value: part.text };
        const sub = new Parser(part.source, this.file);
        const expr = sub.expression();
        if (!sub.check('eof')) {
          throw smarshError('SyntaxError',
            `\`\${...}\` holds more than one expression`, part.line);
        }
        return { kind: 'expr', expr, line: part.line };
      });
      return { type: 'Template', parts, line };
    }
    if (t.type === 'ident') { this.advance(); return { type: 'Ident', name: t.value, line }; }

    if (this.matchKw('true')) return { type: 'Bool', value: true, line };
    if (this.matchKw('false')) return { type: 'Bool', value: false, line };
    if (this.matchKw('nil')) return { type: 'Nil', line };

    if (this.checkKw('fn')) {
      this.advance();
      return this.functionRest(null, line);
    }

    // tensor [[1, 2], [3, 4]]
    if (this.matchKw('tensor')) {
      const inner = this.primary();
      return { type: 'TensorLit', value: inner, line };
    }

    // choose { 0.5 => "explore", 0.5 => "exploit" }
    if (this.matchKw('choose')) {
      this.expectOp('{', "'{' after choose");
      const arms = [];
      if (!this.checkOp('}')) {
        do {
          if (this.checkOp('}')) break;   // tolerate a trailing comma
          const weight = this.expression();
          this.expectOp('=>', "'=>' between a weight and its outcome");
          const value = this.expression();
          arms.push({ weight, value });
        } while (this.matchOp(','));
      }
      this.expectOp('}', "'}' to close choose");
      if (arms.length === 0) throw smarshError('SyntaxError', 'choose needs at least one arm', line);
      return { type: 'Choose', arms, line };
    }

    // match subject { pattern => expr, ... }
    if (this.matchKw('match')) {
      const subject = this.expression();
      this.expectOp('{', "'{' after the value being matched");
      const arms = [];
      while (!this.checkOp('}') && !this.check('eof')) {
        const pattern = this.pattern();
        const guard = this.matchKw('when') ? this.expression() : null;
        this.expectOp('=>', "'=>' after a pattern");
        const body = this.expression();
        arms.push({ pattern, guard, body, line: pattern.line });
        if (!this.matchOp(',')) break;
      }
      this.expectOp('}', "'}' to close the match");
      if (arms.length === 0) throw smarshError('SyntaxError', 'a match needs at least one arm', line);
      return { type: 'Match', subject, arms, line };
    }

    // spawn Worker(args) -> an agent reference
    if (this.matchKw('spawn')) {
      const name = this.expect('ident', undefined, 'an agent name').value;
      const args = [];
      if (this.matchOp('(')) {
        if (!this.checkOp(')')) {
          do { args.push(this.expression()); } while (this.matchOp(','));
        }
        this.expectOp(')', "')' to close the spawn arguments");
      }
      return { type: 'Spawn', name, args, line };
    }

    // fork 4 { ...last expression is the path's result... }
    if (this.matchKw('fork')) {
      const count = this.expression();
      const body = this.block();
      return { type: 'Fork', count, body, line };
    }

    if (this.matchOp('(')) {
      const expr = this.expression();
      this.expectOp(')', "')'");
      return expr;
    }

    if (this.matchOp('[')) {
      const elements = [];
      if (!this.checkOp(']')) {
        do {
          if (this.checkOp(']')) break;
          elements.push(this.expression());
        } while (this.matchOp(','));
      }
      this.expectOp(']', "']' to close the list");
      return { type: 'ListLit', elements, line };
    }

    if (this.matchOp('{')) {
      const entries = [];
      if (!this.checkOp('}')) {
        do {
          if (this.checkOp('}')) break;
          const keyTok = this.current;
          let key;
          if (keyTok.type === 'str') { this.advance(); key = { type: 'Str', value: keyTok.value, line }; }
          else if (keyTok.type === 'ident') { this.advance(); key = { type: 'Str', value: keyTok.value, line }; }
          else key = this.expression();
          this.expectOp(':', "':' after a map key");
          entries.push({ key, value: this.expression() });
        } while (this.matchOp(','));
      }
      this.expectOp('}', "'}' to close the map");
      return { type: 'MapLit', entries, line };
    }

    const got = t.type === 'eof' ? 'end of file' : `'${t.value}'`;
    throw smarshError('SyntaxError', `expected an expression, found ${got}`, line);
  }
}

export function parse(source, file = '<script>') {
  return new Parser(source, file).parseProgram();
}

// Every syntax error in the file, for `check` and for editors. Running a
// program still uses parse(), which stops at the first: there is no point
// executing a file that does not parse.
export function parseAll(source, file = '<script>') {
  try {
    return new Parser(source, file).parseRecovering();
  } catch (e) {
    // A lexer failure has no token stream to recover within.
    if (e instanceof SmarshError) {
      return { program: { type: 'Program', body: [], comments: [], source }, errors: [e] };
    }
    throw e;
  }
}
