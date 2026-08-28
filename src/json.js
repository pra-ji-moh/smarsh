import { smarshError } from './errors.js';
import { RecordValue } from './records.js';
import { Decimal } from './decimal.js';
import { Tainted, unwrap, stringify } from './values.js';
import { positionOf } from './diagnostics.js';

// JSON, which almost every program that talks to anything else needs.
//
// Not `JSON.parse`. Three reasons, and they are the reasons this module is 200
// lines instead of one:
//
//   Errors. `JSON.parse` says "Unexpected token } in JSON at position 47",
//   which is the worst error message in wide circulation. Every message here
//   carries a line and column into the *JSON text*, so a program handling a
//   malformed payload can say where.
//
//   Numbers. JSON has no number type, it has a syntax; `JSON.parse` maps all of
//   it onto a float, which silently loses money. `1.10` in a payload becomes
//   1.1, and `9007199254740993` becomes 9007199254740992. Here a fractional
//   literal becomes an exact Decimal, which is the type this language already
//   has for exactly this problem.
//
//   Provenance. A parsed payload came from outside. Taint has to survive the
//   parse or it is a hole in the whole model: `untrusted(body)` followed by
//   `json_parse` would launder the taint by accident, which is precisely what
//   the taint system exists to prevent.
//
// Depth is bounded rather than trusted. A pathological payload -- ten thousand
// open brackets -- is a stack overflow in a recursive-descent parser, and
// "attacker sends a string, host process dies" is not an acceptable answer for
// a runtime whose whole claim is bounded authority.

const MAX_DEPTH = 200;

class JsonReader {
  constructor(text) {
    this.text = text;
    this.i = 0;
    this.depth = 0;
  }

  fail(message, at = this.i) {
    const { line, column } = positionOf(this.text, Math.min(at, this.text.length));
    const e = smarshError('JsonError', `${message} (line ${line}, column ${column} of the JSON)`, null);
    e.jsonLine = line;
    e.jsonColumn = column;
    e.jsonOffset = at;
    throw e;
  }

  ws() {
    while (this.i < this.text.length) {
      const c = this.text.charCodeAt(this.i);
      // Space, tab, newline, carriage return -- JSON permits no others, and
      // accepting more would make this parser disagree with every other one.
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.i += 1;
      else break;
    }
  }

  parse() {
    this.ws();
    const value = this.value();
    this.ws();
    if (this.i < this.text.length) {
      this.fail(`unexpected \`${this.text[this.i]}\` after the value ended`);
    }
    return value;
  }

  value() {
    if (this.i >= this.text.length) this.fail('the JSON ended early');
    const c = this.text[this.i];
    switch (c) {
      case '{': return this.object();
      case '[': return this.array();
      case '"': return this.string();
      case 't': return this.literal('true', true);
      case 'f': return this.literal('false', false);
      case 'n': return this.literal('null', null);
      default:
        if (c === '-' || (c >= '0' && c <= '9')) return this.number();
        return this.fail(`\`${c}\` cannot start a value`);
    }
  }

  literal(word, value) {
    if (this.text.startsWith(word, this.i)) { this.i += word.length; return value; }
    return this.fail(`expected \`${word}\``);
  }

  enter() {
    if (++this.depth > MAX_DEPTH) {
      this.fail(`this JSON nests deeper than ${MAX_DEPTH}, which is further than anything real goes`);
    }
  }

  object() {
    this.enter();
    this.i += 1;                       // {
    const out = new Map();
    this.ws();
    if (this.text[this.i] === '}') { this.i += 1; this.depth -= 1; return out; }
    for (;;) {
      this.ws();
      if (this.text[this.i] !== '"') this.fail('an object key must be a string');
      const key = this.string();
      this.ws();
      if (this.text[this.i] !== ':') this.fail('expected `:` after the key');
      this.i += 1;
      this.ws();
      // A duplicate key is not an error in the JSON grammar and every parser
      // resolves it differently. Last-one-wins matches JavaScript, Python and
      // Go, which is the least surprising answer available.
      out.set(key, this.value());
      this.ws();
      const c = this.text[this.i];
      if (c === ',') { this.i += 1; continue; }
      if (c === '}') { this.i += 1; this.depth -= 1; return out; }
      this.fail(c === undefined ? 'the object was never closed' : `expected \`,\` or \`}\`, found \`${c}\``);
    }
  }

  array() {
    this.enter();
    this.i += 1;                       // [
    const out = [];
    this.ws();
    if (this.text[this.i] === ']') { this.i += 1; this.depth -= 1; return out; }
    for (;;) {
      this.ws();
      out.push(this.value());
      this.ws();
      const c = this.text[this.i];
      if (c === ',') { this.i += 1; continue; }
      if (c === ']') { this.i += 1; this.depth -= 1; return out; }
      this.fail(c === undefined ? 'the array was never closed' : `expected \`,\` or \`]\`, found \`${c}\``);
    }
  }

  string() {
    const start = this.i;
    this.i += 1;                       // opening quote
    let out = '';
    for (;;) {
      if (this.i >= this.text.length) this.fail('the string was never closed', start);
      const c = this.text[this.i];
      if (c === '"') { this.i += 1; return out; }
      if (c === '\\') { out += this.escape(); continue; }
      const code = this.text.charCodeAt(this.i);
      if (code < 0x20) this.fail('a control character must be escaped inside a string');
      out += c;
      this.i += 1;
    }
  }

  escape() {
    this.i += 1;                       // backslash
    const c = this.text[this.i];
    this.i += 1;
    switch (c) {
      case '"': return '"';
      case '\\': return '\\';
      case '/': return '/';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'u': {
        const hex = this.text.slice(this.i, this.i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('\\u must be followed by four hex digits');
        this.i += 4;
        return String.fromCharCode(parseInt(hex, 16));
      }
      default:
        return this.fail(c === undefined ? 'the string ended after a backslash' : `\`\\${c}\` is not an escape`);
    }
  }

  number() {
    const start = this.i;
    if (this.text[this.i] === '-') this.i += 1;
    if (this.text[this.i] === '0') this.i += 1;
    else {
      if (!/[1-9]/.test(this.text[this.i] ?? '')) this.fail('expected a digit');
      while (/[0-9]/.test(this.text[this.i] ?? '')) this.i += 1;
    }
    let fractional = false;
    if (this.text[this.i] === '.') {
      fractional = true;
      this.i += 1;
      if (!/[0-9]/.test(this.text[this.i] ?? '')) this.fail('expected a digit after the decimal point');
      while (/[0-9]/.test(this.text[this.i] ?? '')) this.i += 1;
    }
    let exponent = false;
    if (this.text[this.i] === 'e' || this.text[this.i] === 'E') {
      exponent = true;
      this.i += 1;
      if (this.text[this.i] === '+' || this.text[this.i] === '-') this.i += 1;
      if (!/[0-9]/.test(this.text[this.i] ?? '')) this.fail('expected a digit in the exponent');
      while (/[0-9]/.test(this.text[this.i] ?? '')) this.i += 1;
    }
    const literal = this.text.slice(start, this.i);

    // A fractional literal is money more often than it is a measurement, and a
    // float is the wrong container for money. `19.99` arrives as an exact
    // decimal, so it still equals `19.99d` after a round trip -- which is not
    // true of any parser that goes through a double.
    //
    // An exponent means someone wrote it as a float on purpose, so it stays one.
    if (fractional && !exponent) return Decimal.parse(literal);
    return Number(literal);
  }
}

export function parseJson(text) {
  if (typeof text !== 'string') {
    throw smarshError('TypeError', 'json_parse needs a string', null);
  }
  return new JsonReader(text).parse();
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

const ESCAPES = {
  '"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t',
};

function quote(s) {
  let out = '"';
  for (const ch of s) {
    const esc = ESCAPES[ch];
    if (esc) { out += esc; continue; }
    const code = ch.codePointAt(0);
    out += code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : ch;
  }
  return `${out}"`;
}

// Writing is where taint does *not* propagate, and that is deliberate: the
// result is a string of characters, and whether it is safe to send somewhere is
// the caller's question, answered by `release_to` or by the taint on the values
// that went in. `to_json` keeps the taint of its input via `retaint` at the
// builtin boundary, which is the same rule every other builtin follows.
export function writeJson(value, { indent = 0, depth = 0, seen = new Set() } = {}) {
  const v = unwrap(value);

  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return quote(v);

  if (typeof v === 'number') {
    // JSON has no way to write these, and every encoder that emits them
    // produces a document no parser will read back.
    if (!Number.isFinite(v)) {
      throw smarshError('JsonError',
        `${v} cannot be written as JSON; the format has no way to spell it`, null);
    }
    return String(v);
  }

  if (v instanceof Decimal) {
    // Written as a number, not a string: it round-trips through this parser
    // back to the same exact decimal, which is the point of having the type.
    return v.toString();
  }

  if (typeof v === 'bigint') return String(v);

  if (depth > MAX_DEPTH) {
    throw smarshError('JsonError', `this value nests deeper than ${MAX_DEPTH}`, null);
  }

  // A structure that contains itself would otherwise recurse until the host
  // stack gives out, which is a crash rather than an error anyone can act on.
  if (typeof v === 'object') {
    if (seen.has(v)) {
      throw smarshError('JsonError', 'this value contains itself, and JSON has no way to write that', null);
    }
    seen.add(v);
  }

  const pad = indent ? '\n' + ' '.repeat(indent * (depth + 1)) : '';
  const close = indent ? '\n' + ' '.repeat(indent * depth) : '';
  const sep = indent ? ',' : ',';
  const colon = indent ? ': ' : ':';
  const inner = { indent, depth: depth + 1, seen };

  try {
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      const parts = v.map((x) => writeJson(x, inner));
      return `[${pad}${parts.join(sep + pad)}${close}]`;
    }

    if (v instanceof Map) {
      const entries = [...v.entries()];
      if (entries.length === 0) return '{}';
      const parts = entries.map(([k, x]) => `${quote(String(k))}${colon}${writeJson(x, inner)}`);
      return `{${pad}${parts.join(sep + pad)}${close}}`;
    }

    if (v instanceof RecordValue) {
      // A record becomes an object of its fields, in declaration order. The
      // type name is dropped: a consumer of JSON does not know what a Smarsh
      // record is, and inventing a `__type` key would make the output
      // surprising in both directions.
      const names = v.type.fields;
      if (names.length === 0) return '{}';
      const parts = names.map((k, idx) => `${quote(String(k))}${colon}${writeJson(v.values[idx], inner)}`);
      return `{${pad}${parts.join(sep + pad)}${close}}`;
    }

    throw smarshError('JsonError',
      `a ${typeNameOf(v)} has no JSON form`, null);
  } finally {
    if (typeof v === 'object') seen.delete(v);
  }
}

function typeNameOf(v) {
  if (v && typeof v.smarshType === 'string') return v.smarshType;
  if (typeof v === 'function') return 'function';
  return typeof v;
}

// Whether a value can be written at all, without writing it. Cheaper than
// catching the error, and it is the question a program asks before deciding
// what to send.
export function isJsonable(value, seen = new Set()) {
  const v = unwrap(value);
  if (v === null || v === undefined) return true;
  if (typeof v === 'boolean' || typeof v === 'string' || typeof v === 'bigint') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (v instanceof Decimal) return true;
  if (typeof v !== 'object') return false;
  if (seen.has(v)) return false;
  seen.add(v);
  try {
    if (Array.isArray(v)) return v.every((x) => isJsonable(x, seen));
    if (v instanceof Map) return [...v.values()].every((x) => isJsonable(x, seen));
    if (v instanceof RecordValue) return v.values.every((x) => isJsonable(x, seen));
    return false;
  } finally {
    seen.delete(v);
  }
}

export { Tainted, stringify };
