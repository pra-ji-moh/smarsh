import { smarshError } from './errors.js';

export const KEYWORDS = new Set([
  'let', 'var', 'fn', 'return', 'if', 'else', 'while', 'for', 'in',
  'true', 'false', 'nil', 'and', 'or', 'not', 'break', 'continue',
  // the parts that make this language what it is
  'maybe', 'choose', 'fork', 'tensor', 'needs', 'requires', 'ensures',
  'attempt', 'rescue',
  'agent', 'on', 'spawn', 'redefine', 'import', 'as',
  'invariant', 'variant', 'using',
  'match', 'when',
]);

// These are NOT reserved. Every one of them is an ordinary noun that a program
// will want as a field or a variable — `region`, `secret`, `budget`, `record`
// — and a language that confiscates common nouns makes people fight it.
//
// Each is recognised only in the one position where it cannot be anything else:
// `region "eu" {`, `secret {`, `budget steps 5 {`, `record Name(`. Everywhere
// else the lexer hands back a plain identifier. Java did this for `record` and
// `sealed` for the same reason.
//
// This was found the honest way, twice: an agent handler called `record`, then
// a customer field called `region`.
export const CONTEXTUAL = new Set([
  'record', 'region', 'secret', 'atomic', 'grounded', 'device', 'budget', 'authority',
]);

// Longest first: the matcher takes the first that fits.
const PUNCT = [
  '**', '==', '!=', '<=', '>=', '=>', '&&', '||',
  '+', '-', '*', '/', '%', '@', '<', '>', '=',
  '(', ')', '{', '}', '[', ']', ',', ';', '.', ':', '!',
];

const isDigit = (c) => c >= '0' && c <= '9';
const isIdentStart = (c) => /[A-Za-z_]/.test(c);
const isIdentPart = (c) => /[A-Za-z0-9_]/.test(c);

export function tokenize(source) {
  const tokens = [];
  // Comments are kept, not discarded: `smarsh fmt` has to put them back, and a
  // formatter that eats comments is worse than no formatter at all.
  const comments = [];
  let i = 0;
  let line = 1;
  const n = source.length;

  // Is there anything but whitespace before this point on its line?
  const startsItsLine = (at) => {
    let k = at - 1;
    while (k >= 0 && source[k] !== '\n') {
      if (source[k] !== ' ' && source[k] !== '\t' && source[k] !== '\r') return false;
      k--;
    }
    return true;
  };

  // Set when a newline has been passed since the previous token. The parser
  // uses it to stop a call chain at a line break, so that
  //     let b = f()
  //     [a, b]
  // is two statements rather than an index into f()'s result.
  let pendingNewline = false;

  const push = (type, value, start) => {
    tokens.push({ type, value, line, start, end: i, nlBefore: pendingNewline });
    pendingNewline = false;
  };

  while (i < n) {
    const c = source[i];

    if (c === '\n') { line++; i++; pendingNewline = true; continue; }
    // U+FEFF is a byte-order mark, which Windows editors and pipes put at the
    // head of a file. Skipped like whitespace, so offsets stay aligned with the
    // source and refusing to read such a file is not a way this can fail.
    // Written as an escape on purpose: a literal BOM here is invisible in every
    // editor and survives exactly one careless re-encoding.
    if (c === ' ' || c === '\t' || c === '\r' || c === '﻿') { i++; continue; }

    // comments: // ... , # ... , /* ... */
    if ((c === '/' && source[i + 1] === '/') || c === '#') {
      const start = i;
      const standalone = startsItsLine(i);
      while (i < n && source[i] !== '\n') i++;
      comments.push({ text: source.slice(start, i).trimEnd(), start, line, standalone });
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const openLine = line;
      const start = i;
      const standalone = startsItsLine(i);
      i += 2;
      let closed = false;
      while (i < n) {
        if (source[i] === '\n') { line++; pendingNewline = true; }
        if (source[i] === '*' && source[i + 1] === '/') { i += 2; closed = true; break; }
        i++;
      }
      if (!closed) throw smarshError('SyntaxError', 'unterminated block comment', openLine);
      comments.push({ text: source.slice(start, i), start, line: openLine, standalone });
      continue;
    }

    // numbers
    if (isDigit(c) || (c === '.' && isDigit(source[i + 1]))) {
      const start = i;
      while (i < n && isDigit(source[i])) i++;
      if (source[i] === '.' && isDigit(source[i + 1])) {
        i++;
        while (i < n && isDigit(source[i])) i++;
      }
      if (source[i] === 'e' || source[i] === 'E') {
        const save = i;
        i++;
        if (source[i] === '+' || source[i] === '-') i++;
        if (isDigit(source[i])) { while (i < n && isDigit(source[i])) i++; }
        else i = save;
      }
      // `19.99d` is a decimal literal. The digits go straight to `dec` as
      // written: they are never turned into a float first, which is the whole
      // point -- `dec(0.1)` would already have lost the value before `dec` saw
      // it, and that is why `dec` takes a string.
      //
      // Money is the language's flagship type and it had no literal at all, so
      // every amount in a program was `dec("19.99")`: more to type, more to get
      // wrong, and more tokens for a program generating it.
      // `i + 1 >= n` is not redundant: `isIdentPart(undefined)` is true,
      // because the regex stringifies it to "undefined". Without the bound
      // check, a literal at the very end of the input -- `let a = 19.99d` with
      // no trailing newline, or the inside of `"${4.20d}"` -- was not one.
      if (source[i] === 'd' && (i + 1 >= n || !isIdentPart(source[i + 1]))) {
        const digits = source.slice(start, i);
        if (/[eE]/.test(digits)) {
          throw smarshError('SyntaxError',
            `\`${digits}d\` is not a decimal literal; exponents are for \`num\``, line)
            .help('write the digits out, or use `dec("...")`');
        }
        i++;
        push('dec', digits, start);
        continue;
      }

      const text = source.slice(start, i);
      const value = Number(text);
      // An integer literal past 2^53 cannot be held exactly by a `num`, and
      // silently rounding it is how money goes missing. Refuse it instead.
      if (!/[.eE]/.test(text) && !Number.isSafeInteger(value)) {
        throw smarshError('SyntaxError',
          `\`${text}\` is too large for \`num\` to hold exactly`, line)
          .help(`use \`dec("${text}")\` for exact arithmetic`)
          .note('`num` is a 64-bit float and is exact only up to 9007199254740991');
      }
      push('num', value, start);
      continue;
    }

    // raw strings: r"\d+" is the characters between the quotes, exactly
    //
    // Added when regular expressions arrived, because without them every
    // pattern has to be written with doubled backslashes -- `"^\\d{3}-\\d{4}$"`
    // -- and a pattern you cannot read is a pattern you cannot check. Python
    // and Rust both solved this the same way and people already know the
    // notation.
    //
    // No escapes and no interpolation inside one: that is the point. The only
    // thing it cannot contain is its own quote character, which is the same
    // limitation Python has and for the same reason.
    if ((c === 'r' || c === 'R') && (source[i + 1] === '"' || source[i + 1] === "'")) {
      const quote = source[i + 1];
      const start = i;
      const openLine = line;
      i += 2;
      const from = i;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\n') line++;
        i++;
      }
      if (i >= n) {
        throw smarshError('SyntaxError', 'this raw string was never closed', openLine)
          .help('a raw string cannot contain its own quote character; use the other quote');
      }
      const text = source.slice(from, i);
      i++;                                   // closing quote
      // The token carries `raw` so the formatter can put it back the way it was
      // written. Without that, `smarsh fmt` rewrites `r"\d+"` as `"\\d+"` --
      // same meaning, and it destroys the readability the notation exists for.
      const token = { type: 'str', value: text, raw: true, line, start, end: i, nlBefore: pendingNewline };
      pendingNewline = false;
      tokens.push(token);
      continue;
    }

    // identifiers and keywords
    if (isIdentStart(c)) {
      const start = i;
      while (i < n && isIdentPart(source[i])) i++;
      const word = source.slice(start, i);
      push(KEYWORDS.has(word) ? 'kw' : 'ident', word, start);
      continue;
    }

    // strings, with interpolation
    //
    // "total: ${a + b}" lexes to a single token carrying alternating literal
    // text and embedded source. The embedded pieces are parsed as ordinary
    // expressions later, so anything that is an expression works inside one.
    if (c === '"' || c === "'") {
      const quote = c;
      const start = i;
      const openLine = line;
      i++;
      let out = '';
      const parts = [];        // { text } | { source, line }
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') {
          const esc = source[i + 1];
          const map = { n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', '"': '"', "'": "'", $: '$' };
          if (esc in map) { out += map[esc]; i += 2; continue; }
          throw smarshError('SyntaxError', `unknown escape \\${esc}`, line)
            .help(`for a regular expression or a path, a raw string takes it literally: r"...${esc}..."`);
        }
        if (source[i] === '$' && source[i + 1] === '{') {
          parts.push({ text: out });
          out = '';
          i += 2;
          const exprStart = i;
          const exprLine = line;
          let depth = 1;
          while (i < n && depth > 0) {
            const ch = source[i];
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            else if (ch === '\n') line++;
            else if (ch === '"' || ch === "'") {
              // Skip a nested string so its braces do not count.
              const inner = ch;
              i++;
              while (i < n && source[i] !== inner) {
                if (source[i] === '\\') i++;
                i++;
              }
            }
            if (depth > 0) i++;
          }
          if (depth !== 0) throw smarshError('SyntaxError', 'unterminated `${` in a string', exprLine);
          const embedded = source.slice(exprStart, i);
          if (embedded.trim() === '') {
            throw smarshError('SyntaxError', 'empty `${}` in a string', exprLine);
          }
          parts.push({ source: embedded, line: exprLine });
          i++;                 // closing brace
          continue;
        }
        if (source[i] === '\n') line++;
        out += source[i];
        i++;
      }
      if (i >= n) throw smarshError('SyntaxError', 'unterminated string', openLine);
      i++; // closing quote

      if (parts.length === 0) {
        push('str', out, start);
      } else {
        parts.push({ text: out });
        const token = { type: 'template', value: parts, line, start, end: i, nlBefore: pendingNewline };
        pendingNewline = false;
        tokens.push(token);
      }
      continue;
    }

    // punctuation / operators
    const start = i;
    const op = PUNCT.find((p) => source.startsWith(p, i));
    if (op) {
      i += op.length;
      push('op', op, start);
      continue;
    }

    throw smarshError('SyntaxError', `unexpected character '${c}'`, line);
  }

  tokens.push({ type: 'eof', value: null, line, start: n, end: n, nlBefore: pendingNewline });
  tokens.comments = comments;
  return tokens;
}
