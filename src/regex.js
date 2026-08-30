import { smarshError } from './errors.js';

// Regular expressions, matched in linear time.
//
// Not JavaScript's `RegExp`, and the reason is the same reason this language
// exists. `RegExp` backtracks: `/(a+)+b/` against forty a's takes longer than
// the age of the universe, and that is a denial of service any program handling
// a pattern or a subject from outside is exposed to. A runtime whose claim is
// bounded authority cannot hand a program an operation whose cost is unbounded
// in its input.
//
// So this is Thompson's construction, simulated as an NFA. Every match is
// O(pattern x subject), always, with no input that makes it worse. What that
// costs is the features that require backtracking to define at all:
//
//   No backreferences (`\1`). They make matching NP-hard; that is not an
//   implementation limit, it is what the feature means.
//   No lookahead or lookbehind. Expressible in a DFA, but not in this
//   construction, and adding them without care is how the linear bound is lost.
//   No lazy quantifiers (`*?`). With leftmost-longest semantics there is
//   nothing for them to do.
//
// Everything a program actually reaches for is here: literals, character
// classes, escapes, anchors, alternation, groups, and the three quantifiers
// with bounded repetition.
//
// The engine is small on purpose. A regex engine is a place where a subtle bug
// is a security bug -- a pattern that matches something it should not is a
// validator that lets something through -- so it is written to be read.

// ---------------------------------------------------------------------------
// the pattern, parsed
// ---------------------------------------------------------------------------

const MAX_REPEAT = 1000;          // `a{1001}` is a mistake, not an intention
const MAX_PATTERN = 4096;

class Parser {
  constructor(source) {
    this.source = source;
    this.i = 0;
    this.groups = 0;
  }

  fail(message) {
    throw smarshError('RegexError',
      `${message} at position ${this.i} of \`${this.source}\``, null);
  }

  peek() { return this.source[this.i]; }

  eat(c) {
    if (this.source[this.i] === c) { this.i += 1; return true; }
    return false;
  }

  parse() {
    const node = this.alternation();
    if (this.i < this.source.length) {
      // `concatenation` stops at `)`, so a stray one arrives here rather than
      // at the `atom` case that knows what it is. Saying "unmatched" instead of
      // "unexpected" is the difference between a hint and a shrug.
      if (this.peek() === ')') this.fail('unmatched `)`');
      this.fail(`unexpected \`${this.peek()}\``);
    }
    return node;
  }

  // a|b|c
  alternation() {
    const branches = [this.concatenation()];
    while (this.eat('|')) branches.push(this.concatenation());
    return branches.length === 1 ? branches[0] : { type: 'alt', branches };
  }

  // abc
  concatenation() {
    const parts = [];
    while (this.i < this.source.length && this.peek() !== '|' && this.peek() !== ')') {
      parts.push(this.quantified());
    }
    if (parts.length === 0) return { type: 'empty' };
    return parts.length === 1 ? parts[0] : { type: 'cat', parts };
  }

  // a*  a+  a?  a{2}  a{2,}  a{2,5}
  quantified() {
    const atom = this.atom();
    for (;;) {
      const c = this.peek();
      if (c === '*') { this.i += 1; this.checkRepeatable(atom); return this.wrap(atom, 0, Infinity); }
      if (c === '+') { this.i += 1; this.checkRepeatable(atom); return this.wrap(atom, 1, Infinity); }
      if (c === '?') { this.i += 1; this.checkRepeatable(atom); return this.wrap(atom, 0, 1); }
      if (c === '{') {
        const saved = this.i;
        const bounds = this.tryBounds();
        // `{` is a literal brace unless it opens a well-formed count, which is
        // how every other engine treats it and what people expect.
        if (bounds === null) { this.i = saved; return atom; }
        this.checkRepeatable(atom);
        return this.wrap(atom, bounds.min, bounds.max);
      }
      return atom;
    }
  }

  // Quantifying a quantifier is where the exponential blowup would live if this
  // engine could blow up. It cannot -- but `(a*)*` is still meaningless, and
  // refusing it is friendlier than silently matching.
  checkRepeatable(atom) {
    if (atom.type === 'repeat') this.fail('a quantifier cannot be quantified again');
    if (atom.type === 'anchor') this.fail('an anchor cannot be quantified');
  }

  wrap(node, min, max) {
    return { type: 'repeat', node, min, max };
  }

  tryBounds() {
    this.i += 1;                    // {
    const digits = () => {
      const start = this.i;
      while (/[0-9]/.test(this.source[this.i] ?? '')) this.i += 1;
      return this.i === start ? null : Number(this.source.slice(start, this.i));
    };
    const min = digits();
    if (min === null) return null;
    let max = min;
    if (this.eat(',')) {
      max = /[0-9]/.test(this.source[this.i] ?? '') ? digits() : Infinity;
    }
    if (!this.eat('}')) return null;
    if (max !== Infinity && max < min) this.fail('the upper bound is below the lower one');
    if (min > MAX_REPEAT || (max !== Infinity && max > MAX_REPEAT)) {
      this.fail(`a repetition above ${MAX_REPEAT} is refused`);
    }
    return { min, max };
  }

  atom() {
    const c = this.peek();
    if (c === undefined) this.fail('the pattern ended early');

    if (c === '(') {
      this.i += 1;
      // (?: ... ) groups without capturing. Anything else after `(?` is a
      // feature this engine does not have, and saying so beats matching
      // something unexpected.
      let capturing = true;
      if (this.source.startsWith('?:', this.i)) { this.i += 2; capturing = false; } else if (this.peek() === '?') {
        this.fail('lookahead, lookbehind and named groups are not supported; this engine matches in linear time and they do not');
      }
      const index = capturing ? ++this.groups : null;
      const inner = this.alternation();
      if (!this.eat(')')) this.fail('the group was never closed');
      return { type: 'group', node: inner, index };
    }

    if (c === '[') return this.charClass();
    if (c === '.') { this.i += 1; return { type: 'any' }; }
    if (c === '^') { this.i += 1; return { type: 'anchor', at: 'start' }; }
    if (c === '$') { this.i += 1; return { type: 'anchor', at: 'end' }; }
    if (c === '\\') return this.escape();
    if (c === '*' || c === '+' || c === '?') this.fail(`\`${c}\` has nothing to repeat`);
    if (c === ')') this.fail('unmatched `)`');

    this.i += 1;
    return { type: 'char', set: single(c) };
  }

  escape() {
    this.i += 1;
    const c = this.source[this.i];
    if (c === undefined) this.fail('the pattern ended after a backslash');
    this.i += 1;

    const named = NAMED_CLASSES[c];
    if (named) return { type: 'char', set: named };
    if (/[1-9]/.test(c)) {
      this.fail('backreferences are not supported; they make matching exponential, which this engine will not do');
    }
    const control = { n: '\n', r: '\r', t: '\t', f: '\f', v: '\v', 0: '\0' }[c];
    if (control !== undefined) return { type: 'char', set: single(control) };
    // Everything else is itself: `\.` `\*` `\\` and so on.
    return { type: 'char', set: single(c) };
  }

  charClass() {
    this.i += 1;                    // [
    const negated = this.eat('^');
    const ranges = [];
    let first = true;
    for (;;) {
      const c = this.peek();
      if (c === undefined) this.fail('the character class was never closed');
      if (c === ']' && !first) { this.i += 1; break; }
      first = false;

      let lo;
      if (c === '\\') {
        this.i += 1;
        const e = this.source[this.i];
        if (e === undefined) this.fail('the pattern ended after a backslash');
        this.i += 1;
        const named = NAMED_CLASSES[e];
        if (named) { ranges.push(...named.ranges); continue; }
        const control = { n: '\n', r: '\r', t: '\t', f: '\f', v: '\v', 0: '\0' }[e];
        lo = (control ?? e).codePointAt(0);
      } else {
        this.i += 1;
        lo = c.codePointAt(0);
      }

      // A dash is a range only between two characters; `[a-]` ends with a
      // literal dash, which is what every other engine does.
      if (this.peek() === '-' && this.source[this.i + 1] !== undefined && this.source[this.i + 1] !== ']') {
        this.i += 1;
        let hiChar = this.peek();
        if (hiChar === '\\') {
          this.i += 1;
          hiChar = this.source[this.i];
          const control = { n: '\n', r: '\r', t: '\t', f: '\f', v: '\v', 0: '\0' }[hiChar];
          hiChar = control ?? hiChar;
        }
        this.i += 1;
        const hi = hiChar.codePointAt(0);
        if (hi < lo) this.fail('the range runs backwards');
        ranges.push([lo, hi]);
      } else {
        ranges.push([lo, lo]);
      }
    }
    return { type: 'char', set: { negated, ranges } };
  }
}

const single = (ch) => ({ negated: false, ranges: [[ch.codePointAt(0), ch.codePointAt(0)]] });

const RANGE = (a, b) => [a.codePointAt(0), b.codePointAt(0)];

const DIGIT = { negated: false, ranges: [RANGE('0', '9')] };
const WORD = {
  negated: false,
  ranges: [RANGE('a', 'z'), RANGE('A', 'Z'), RANGE('0', '9'), RANGE('_', '_')],
};
const SPACE = {
  negated: false,
  ranges: [[9, 13], [32, 32]],       // tab..carriage return, and space
};
const negate = (set) => ({ negated: !set.negated, ranges: set.ranges });

const NAMED_CLASSES = {
  d: DIGIT, D: negate(DIGIT),
  w: WORD, W: negate(WORD),
  s: SPACE, S: negate(SPACE),
};

function inSet(set, code) {
  let hit = false;
  for (const [lo, hi] of set.ranges) {
    if (code >= lo && code <= hi) { hit = true; break; }
  }
  return set.negated ? !hit : hit;
}

// ---------------------------------------------------------------------------
// the program, and the machine that runs it
// ---------------------------------------------------------------------------
//
// Instructions, in the shape Pike's VM uses:
//
//   char   consume one character in `set`, or die
//   any    consume any character except a newline
//   split  go two ways at once
//   jmp    go one way
//   save   record a position, for a group
//   assert a zero-width condition (^ or $)
//   match  this thread has succeeded

const CHAR = 0; const ANY = 1; const SPLIT = 2; const JMP = 3;
const SAVE = 4; const ASSERT = 5; const MATCH = 6;

function compile(node, program, saves) {
  switch (node.type) {
    case 'empty':
      return;
    case 'char':
      program.push({ op: CHAR, set: node.set });
      return;
    case 'any':
      program.push({ op: ANY });
      return;
    case 'anchor':
      program.push({ op: ASSERT, at: node.at });
      return;
    case 'cat':
      for (const part of node.parts) compile(part, program, saves);
      return;
    case 'group': {
      if (node.index === null) { compile(node.node, program, saves); return; }
      const slot = node.index * 2;
      saves.count = Math.max(saves.count, slot + 2);
      program.push({ op: SAVE, slot });
      compile(node.node, program, saves);
      program.push({ op: SAVE, slot: slot + 1 });
      return;
    }
    case 'alt': {
      // Chain of splits, each branch jumping to the end.
      const jumps = [];
      for (let i = 0; i < node.branches.length; i++) {
        if (i === node.branches.length - 1) {
          compile(node.branches[i], program, saves);
        } else {
          const split = program.length;
          program.push({ op: SPLIT, x: 0, y: 0 });
          program[split].x = program.length;
          compile(node.branches[i], program, saves);
          jumps.push(program.length);
          program.push({ op: JMP, x: 0 });
          program[split].y = program.length;
        }
      }
      for (const j of jumps) program[j].x = program.length;
      return;
    }
    case 'repeat': {
      const { min, max } = node;

      // The required copies come first, laid out one after another.
      for (let i = 0; i < min; i++) compile(node.node, program, saves);

      if (max === Infinity) {
        const split = program.length;
        program.push({ op: SPLIT, x: 0, y: 0 });
        program[split].x = program.length;
        compile(node.node, program, saves);
        program.push({ op: JMP, x: split });
        program[split].y = program.length;
        return;
      }

      // A bounded maximum becomes that many optional copies. `MAX_REPEAT`
      // keeps this from becoming a way to make the runtime allocate.
      const splits = [];
      for (let i = min; i < max; i++) {
        const split = program.length;
        program.push({ op: SPLIT, x: 0, y: 0 });
        program[split].x = program.length;
        splits.push(split);
        compile(node.node, program, saves);
      }
      for (const s of splits) program[s].y = program.length;
      return;
    }
    default:
      throw smarshError('RegexError', `unknown node ${node.type}`, null);
  }
}

export class Regex {
  constructor(source, { ignoreCase = false } = {}) {
    if (typeof source !== 'string') {
      throw smarshError('TypeError', 'a pattern must be a string', null);
    }
    if (source.length > MAX_PATTERN) {
      throw smarshError('RegexError', `a pattern longer than ${MAX_PATTERN} characters is refused`, null);
    }
    this.source = source;
    this.ignoreCase = ignoreCase;

    const parser = new Parser(source);
    const ast = parser.parse();
    const program = [];
    const saves = { count: 2 };
    program.push({ op: SAVE, slot: 0 });
    compile(ast, program, saves);
    program.push({ op: SAVE, slot: 1 });
    program.push({ op: MATCH });

    this.program = program;
    this.slots = saves.count;
    this.groups = parser.groups;
  }

  // Leftmost match starting at or after `from`. Returns null, or the captures:
  // an array of [start, end] pairs, index 0 being the whole match.
  //
  // The simulation runs every thread in lockstep, one character at a time, with
  // at most one thread per instruction. That bound is the whole point: the work
  // is at most (instructions x characters), whatever the pattern and whatever
  // the subject.
  exec(subject, from = 0) {
    const n = this.program.length;
    let clist = [];
    let nlist = [];
    let onClist = new Int32Array(n).fill(-1);
    let onNlist = new Int32Array(n).fill(-1);
    let matched = null;
    let generation = 0;

    const addThread = (list, seen, pc, position, saved, subjectPos) => {
      // Iterative rather than recursive: a pattern with deep alternation would
      // otherwise be a stack overflow, which is exactly the unbounded cost this
      // engine exists to avoid.
      const stack = [[pc, saved]];
      while (stack.length) {
        const [at, slots] = stack.pop();
        if (seen[at] === generation) continue;
        seen[at] = generation;
        const inst = this.program[at];
        switch (inst.op) {
          case JMP:
            stack.push([inst.x, slots]);
            break;
          case SPLIT:
            // y before x so x is explored first, which is what makes
            // alternation prefer its earlier branch.
            stack.push([inst.y, slots]);
            stack.push([inst.x, slots]);
            break;
          case SAVE: {
            const copy = slots.slice();
            copy[inst.slot] = subjectPos;
            stack.push([at + 1, copy]);
            break;
          }
          case ASSERT: {
            const ok = inst.at === 'start' ? subjectPos === 0 : subjectPos === subject.length;
            if (ok) stack.push([at + 1, slots]);
            break;
          }
          default:
            list.push({ pc: at, slots });
        }
      }
    };

    for (let start = from; start <= subject.length; start++) {
      generation += 1;
      clist = [];
      onClist.fill(-1);
      addThread(clist, onClist, 0, start, new Array(this.slots).fill(-1), start);

      for (let pos = start; ; pos++) {
        if (clist.length === 0) break;
        const ch = pos < subject.length ? subject.codePointAt(pos) : -1;
        const cased = this.ignoreCase && ch >= 0
          ? [ch, foldCase(ch)]
          : [ch];

        generation += 1;
        nlist = [];
        onNlist.fill(-1);

        for (const thread of clist) {
          const inst = this.program[thread.pc];
          if (inst.op === MATCH) {
            // Leftmost-longest: keep going in case a later thread matches
            // more, but remember this one.
            matched = thread.slots.slice();
            break;
          }
          if (ch < 0) continue;
          if (inst.op === CHAR) {
            if (cased.some((c) => inSet(inst.set, c))) {
              addThread(nlist, onNlist, thread.pc + 1, pos + 1, thread.slots, pos + 1);
            }
          } else if (inst.op === ANY) {
            if (ch !== 10) addThread(nlist, onNlist, thread.pc + 1, pos + 1, thread.slots, pos + 1);
          }
        }

        [clist, nlist] = [nlist, clist];
        [onClist, onNlist] = [onNlist, onClist];
        if (pos >= subject.length) break;
      }

      if (matched) {
        const captures = [];
        for (let g = 0; g * 2 < matched.length; g++) {
          const s = matched[g * 2];
          const e = matched[g * 2 + 1];
          captures.push(s === -1 || e === -1 ? null : [s, e]);
        }
        return captures;
      }
    }
    return null;
  }

  test(subject) { return this.exec(subject) !== null; }

  // Every non-overlapping match, left to right.
  all(subject, limit = 10000) {
    const out = [];
    let at = 0;
    while (at <= subject.length && out.length < limit) {
      const m = this.exec(subject, at);
      if (!m) break;
      out.push(m);
      // A zero-width match must still advance, or this never terminates.
      at = m[0][1] > m[0][0] ? m[0][1] : m[0][1] + 1;
    }
    return out;
  }
}

// Only the simple one-to-one folding. Full Unicode case folding is a table this
// project is not going to carry, and a half-implemented version would be worse
// than an honest limit -- see LIMITATIONS.md.
function foldCase(code) {
  if (code >= 65 && code <= 90) return code + 32;
  if (code >= 97 && code <= 122) return code - 32;
  return code;
}

export { MAX_REPEAT, MAX_PATTERN };
