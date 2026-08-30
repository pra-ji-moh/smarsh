import { diagnoseWithProgram, builtinSurface } from './diagnose.js';
import { positionOf, CODES, EXPLANATIONS } from './diagnostics.js';

// A language server for Smarsh.
//
// This is the difference between "an interesting repository" and "a language
// someone writes code in". Without it an editor shows a wall of undifferentiated
// grey, no name is completable, and a mistake is discovered by running the
// program. Nobody stays for that, however good the runtime is.
//
// It speaks LSP over stdin/stdout, which is what every editor already knows how
// to talk to: VS Code, Neovim, Helix, Zed, Emacs, IntelliJ. One protocol, and
// the work is done once rather than once per editor.
//
// The checker is `src/diagnose.js`, the same module `smarsh check` calls. That
// is deliberate and it is the whole design: an editor that disagrees with the
// command line teaches people to distrust both.

// ---------------------------------------------------------------------------
// the wire: JSON-RPC 2.0 with Content-Length framing
// ---------------------------------------------------------------------------

// LSP frames messages the way HTTP does. Notably the header length is in BYTES
// and the body is UTF-8, so a document containing anything outside ASCII --
// which for this language includes its own name -- desynchronises the stream if
// you count characters. Everything below works in Buffers for that reason.
export class MessageReader {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  // Feed bytes in, get whole messages out. Returns however many completed.
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const out = [];
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Unrecoverable: without a length there is no way to find the next
        // frame. Drop the header and resynchronise rather than spinning.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) break;      // not all here yet

      const body = this.buffer.subarray(start, start + length).toString('utf8');
      this.buffer = this.buffer.subarray(start + length);
      try {
        out.push(JSON.parse(body));
      } catch {
        // A malformed body is the peer's bug. Skipping it keeps the stream in
        // sync, which is the only thing this layer can usefully do about it.
      }
    }
    return out;
  }
}

export function encode(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
    body,
  ]);
}

// ---------------------------------------------------------------------------
// positions
// ---------------------------------------------------------------------------

// LSP counts lines and characters from zero; this project counts from one
// everywhere, because that is what a person reading an error expects. The
// conversion lives here alone so the off-by-one has exactly one home.
const toLspPosition = (source, offset) => {
  const { line, column } = positionOf(source, offset);
  return { line: line - 1, character: column - 1 };
};

export function spanToRange(source, span, fallbackLine = 1) {
  if (!span) {
    const line = Math.max(0, fallbackLine - 1);
    return { start: { line, character: 0 }, end: { line, character: 0 } };
  }
  return { start: toLspPosition(source, span[0]), end: toLspPosition(source, span[1]) };
}

// The reverse, for hover and go-to-definition, which arrive as a cursor.
export function offsetOf(source, position) {
  let offset = 0;
  let line = 0;
  while (line < position.line && offset < source.length) {
    const next = source.indexOf('\n', offset);
    if (next === -1) return source.length;
    offset = next + 1;
    line += 1;
  }
  return Math.min(offset + position.character, source.length);
}

const SEVERITY = { error: 1, warning: 2, info: 3, hint: 4 };

// ---------------------------------------------------------------------------
// what the editor can complete
// ---------------------------------------------------------------------------

const KEYWORDS = [
  'let', 'var', 'fn', 'return', 'if', 'else', 'while', 'for', 'in', 'match',
  'record', 'choice', 'import', 'export', 'attempt', 'rescue', 'ensure',
  'needs', 'requires', 'ensures', 'invariant', 'variant', 'old', 'break',
  'continue', 'true', 'false', 'nil', 'and', 'or', 'not', 'tensor', 'agent',
  'spawn', 'send', 'receive', 'fork', 'atomic', 'test',
];

// Blocks are the shape of this language's security story, so they complete as
// whole constructs with the body already open. A model or a person typing
// `release_to` wants the block, not the word.
const BLOCKS = [
  ['authority', 'authority "${1:principal}" {\n\t$0\n}', 'act for a principal (needs --principal)'],
  ['release_to', 'release_to "${1:party}" {\n\t$0\n}', 'data leaving to a party; labels are checked here'],
  ['vouched_by', 'vouched_by "${1:principal}" {\n\t$0\n}', 'act only on what a principal stands behind'],
  ['grounded', 'grounded {\n\t$0\n}', 'refuses to read an untrusted or ungrounded value'],
  ['region', 'region "${1:eu}" {\n\t$0\n}', 'data restricted to a region'],
  ['using', 'using ${1:grant} {\n\t$0\n}', 'hold a delegated capability for this block'],
  ['secret', 'secret {\n\t$0\n}', 'shred every secret created inside on exit'],
  ['atomic', 'atomic {\n\t$0\n}', 'all of it, or none of it'],
  ['device', 'device "${1:cpu}" {\n\t$0\n}', 'choose the compute backend'],
];

const CAPABILITIES = ['fs', 'clock', 'crypto', 'unaudited_crypto', 'ffi', 'net'];

// ---------------------------------------------------------------------------
// the server
// ---------------------------------------------------------------------------

export class LanguageServer {
  constructor({ write, log = () => {} } = {}) {
    this.write = write;
    this.log = log;
    this.documents = new Map();     // uri -> { text, version, program }
    this.shutdownRequested = false;
    this.surface = builtinSurface();
  }

  send(message) { this.write(encode(message)); }

  reply(id, result) { this.send({ jsonrpc: '2.0', id, result }); }

  fail(id, code, message) { this.send({ jsonrpc: '2.0', id, error: { code, message } }); }

  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }

  handle(message) {
    const { id, method, params } = message;
    // A response to something we sent; nothing here asks the client questions.
    if (method === undefined) return;

    try {
      switch (method) {
        case 'initialize': return this.reply(id, this.initialize());
        case 'initialized': return;
        case 'shutdown':
          this.shutdownRequested = true;
          return this.reply(id, null);
        case 'exit': return;      // the driver decides when to leave

        case 'textDocument/didOpen': return this.didOpen(params);
        case 'textDocument/didChange': return this.didChange(params);
        case 'textDocument/didClose': return this.didClose(params);
        case 'textDocument/didSave': return;

        case 'textDocument/completion': return this.reply(id, this.completion(params));
        case 'textDocument/hover': return this.reply(id, this.hover(params));
        case 'textDocument/definition': return this.reply(id, this.definition(params));
        case 'textDocument/documentSymbol': return this.reply(id, this.documentSymbols(params));

        default:
          // A request must be answered even when unsupported, or the client
          // waits forever. A notification must not be.
          if (id !== undefined) this.fail(id, -32601, `unsupported: ${method}`);
          return;
      }
    } catch (e) {
      this.log(`error handling ${method}: ${e.stack ?? e.message}`);
      if (id !== undefined) this.fail(id, -32603, String(e.message ?? e));
    }
  }

  initialize() {
    return {
      capabilities: {
        // Full text on every change. Incremental sync would be faster, but this
        // checker re-parses the whole file anyway, so the saving would be in
        // the wrong place and the bookkeeping is where sync bugs live.
        textDocumentSync: 1,
        completionProvider: { triggerCharacters: ['.', '"'] },
        hoverProvider: true,
        definitionProvider: true,
        documentSymbolProvider: true,
      },
      serverInfo: { name: 'smarsh-lsp', version: '0.3.0' },
    };
  }

  // --- documents -----------------------------------------------------------

  didOpen({ textDocument }) {
    this.setDocument(textDocument.uri, textDocument.text, textDocument.version);
  }

  didChange({ textDocument, contentChanges }) {
    if (!contentChanges?.length) return;
    // With full sync the last change carries the whole document.
    const text = contentChanges[contentChanges.length - 1].text;
    this.setDocument(textDocument.uri, text, textDocument.version);
  }

  didClose({ textDocument }) {
    this.documents.delete(textDocument.uri);
    // Clear the squiggles; a closed file has no problems worth showing.
    this.notify('textDocument/publishDiagnostics', { uri: textDocument.uri, diagnostics: [] });
  }

  setDocument(uri, text, version) {
    const file = uriToPath(uri);
    let program = null;
    let diagnostics = [];
    try {
      const result = diagnoseWithProgram(text, file);
      program = result.program;
      diagnostics = result.diagnostics;
    } catch (e) {
      // The checker threw rather than reporting. That is a bug in the checker,
      // and the editor should say so rather than going quiet -- a server that
      // silently stops checking looks exactly like a clean file.
      this.log(`checker threw on ${file}: ${e.stack ?? e.message}`);
      diagnostics = [{
        span: null, line: 1, severity: 'error', code: 'E0000',
        message: `the checker failed on this file: ${e.message}`,
        helps: [], notes: [],
      }];
    }
    this.documents.set(uri, { text, version, program });
    this.publish(uri, text, diagnostics);
  }

  publish(uri, source, diagnostics) {
    this.notify('textDocument/publishDiagnostics', {
      uri,
      diagnostics: diagnostics.map((d) => {
        const related = [...(d.helps ?? []), ...(d.notes ?? [])];
        return {
          range: spanToRange(source, d.span, d.line),
          severity: SEVERITY[d.severity] ?? 1,
          code: d.code,
          source: 'smarsh',
          message: related.length ? `${d.message}\n\n${related.join('\n')}` : d.message,
        };
      }),
    });
  }

  // --- completion ----------------------------------------------------------

  completion({ textDocument, position }) {
    const doc = this.documents.get(textDocument.uri);
    if (!doc) return { isIncomplete: false, items: [] };

    const offset = offsetOf(doc.text, position);
    const before = doc.text.slice(0, offset);

    // After a dot the useful answer is methods, and which methods depends on a
    // type this language does not always know. Offering every method on every
    // type would be noise, so the ones offered are the ones shared by the
    // collection types, where a wrong guess costs least.
    if (/\.\s*[A-Za-z_]*$/.test(before)) return { isIncomplete: false, items: methodItems() };

    // Inside a `needs` clause, only capabilities make sense.
    if (/\bneeds\s+[a-z_,\s]*$/.test(before)) {
      return {
        isIncomplete: false,
        items: CAPABILITIES.map((c) => ({ label: c, kind: 14, detail: 'capability' })),
      };
    }

    const items = [];
    for (const [label, snippet, detail] of BLOCKS) {
      items.push({ label, kind: 15, detail, insertText: snippet, insertTextFormat: 2 });
    }
    for (const k of KEYWORDS) items.push({ label: k, kind: 14 });

    for (const name of this.surface.names) {
      const needs = this.surface.needs.get(name);
      items.push({
        label: name,
        kind: 3,
        detail: needs ? `builtin -- needs ${needs.join(', ')}` : 'builtin',
        // A builtin that costs authority sorts after one that does not: the
        // cheap answer should be the first one offered.
        sortText: needs ? `z${name}` : `m${name}`,
      });
    }

    for (const local of this.localNames(doc)) {
      items.push({ label: local.name, kind: local.kind, detail: local.detail, sortText: `a${local.name}` });
    }

    return { isIncomplete: false, items };
  }

  // Top-level names the file itself declares. Walking the whole AST for locals
  // in scope would be better; this is the part that pays for itself first,
  // because a function you defined above is the name you most want completed.
  localNames(doc) {
    const out = [];
    if (!doc.program) return out;
    for (const node of doc.program.body ?? []) {
      // A FnDecl is a wrapper: the name, params and contract live on `node.fn`.
      if (node.type === 'FnDecl' && node.fn?.name) {
        const fn = node.fn;
        const params = (fn.params ?? []).join(', ');
        const needs = fn.needs?.length ? ` needs ${fn.needs.join(', ')}` : '';
        out.push({ name: fn.name, kind: 3, detail: `fn ${fn.name}(${params})${needs}` });
      } else if (node.type === 'Declare' && node.name) {
        out.push({ name: node.name, kind: 6, detail: node.mutable ? 'var' : 'let' });
      } else if ((node.type === 'RecordDecl' || node.type === 'ChoiceDecl') && node.name) {
        out.push({ name: node.name, kind: 22, detail: node.type === 'ChoiceDecl' ? 'choice' : 'record' });
      }
    }
    return out;
  }

  // --- hover ---------------------------------------------------------------

  hover({ textDocument, position }) {
    const doc = this.documents.get(textDocument.uri);
    if (!doc) return null;
    const word = wordAt(doc.text, offsetOf(doc.text, position));
    if (!word) return null;

    const lines = [];

    if (this.surface.names.includes(word.text)) {
      const needs = this.surface.needs.get(word.text);
      const arity = this.surface.arities.get(word.text);
      const args = arity === undefined || arity < 0 ? '...' : Array.from({ length: arity }, (_, i) => `a${i + 1}`).join(', ');
      lines.push('```smarsh', `${word.text}(${args})`, '```');
      lines.push(needs
        ? `Builtin. **Needs \`${needs.join('`, `')}\`** -- a function calling it must declare it.`
        : 'Builtin. Costs no authority.');
    }

    for (const local of this.localNames(doc)) {
      if (local.name === word.text) lines.push('```smarsh', local.detail, '```');
    }

    // Hovering a diagnostic code in a comment or a message is worth answering
    // too: the explanations already exist for `smarsh explain`.
    if (CODES[word.text] || EXPLANATIONS[word.text]) {
      lines.push(`**${word.text}** -- ${CODES[word.text] ?? ''}`);
      if (EXPLANATIONS[word.text]) lines.push('', EXPLANATIONS[word.text]);
    }

    if (lines.length === 0) return null;
    return {
      contents: { kind: 'markdown', value: lines.join('\n') },
      range: spanToRange(doc.text, [word.start, word.end]),
    };
  }

  // --- go to definition ----------------------------------------------------

  definition({ textDocument, position }) {
    const doc = this.documents.get(textDocument.uri);
    if (!doc?.program) return null;
    const word = wordAt(doc.text, offsetOf(doc.text, position));
    if (!word) return null;

    for (const node of doc.program.body ?? []) {
      const name = node.type === 'FnDecl' ? node.fn?.name : node.name;
      const declares = ['FnDecl', 'Declare', 'RecordDecl', 'ChoiceDecl', 'AgentDecl'].includes(node.type);
      if (declares && name === word.text && node.span) {
        return { uri: textDocument.uri, range: spanToRange(doc.text, node.span) };
      }
    }
    return null;
  }

  // --- outline -------------------------------------------------------------

  documentSymbols({ textDocument }) {
    const doc = this.documents.get(textDocument.uri);
    if (!doc?.program) return [];
    const KIND = { FnDecl: 12, Declare: 13, RecordDecl: 23, ChoiceDecl: 10, AgentDecl: 5 };
    const out = [];
    for (const node of doc.program.body ?? []) {
      const name = node.type === 'FnDecl' ? node.fn?.name : node.name;
      if (!name || !KIND[node.type] || !node.span) continue;
      const range = spanToRange(doc.text, node.span);
      out.push({ name, kind: KIND[node.type], range, selectionRange: range });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function wordAt(source, offset) {
  const isWord = (c) => c !== undefined && /[A-Za-z0-9_]/.test(c);
  let start = offset;
  // The cursor sits *between* characters, so a hover at the end of a word has
  // an offset one past its last character.
  while (start > 0 && isWord(source[start - 1])) start -= 1;
  let end = offset;
  while (end < source.length && isWord(source[end])) end += 1;
  if (start === end) return null;
  return { text: source.slice(start, end), start, end };
}

function methodItems() {
  const groups = {
    'list': ['len', 'push', 'pop', 'slice', 'contains', 'join', 'map', 'filter', 'reduce', 'sort', 'reverse', 'sum'],
    'string': ['len', 'upper', 'lower', 'trim', 'split', 'replace', 'slice', 'contains', 'starts', 'ends', 'tokens'],
    'map': ['len', 'get', 'set', 'has', 'remove', 'keys', 'values'],
    'tensor': ['T', 'shape', 'rank', 'size', 'sum', 'mean', 'max', 'min', 'norm', 'reshape', 'map', 'tolist'],
  };
  const seen = new Map();
  for (const [type, methods] of Object.entries(groups)) {
    for (const m of methods) {
      if (seen.has(m)) seen.get(m).push(type);
      else seen.set(m, [type]);
    }
  }
  return [...seen].map(([name, types]) => ({
    label: name, kind: 2, detail: `method on ${types.join(', ')}`,
  }));
}

export function uriToPath(uri) {
  if (!uri.startsWith('file://')) return uri;
  let p = decodeURIComponent(uri.slice('file://'.length));
  // file:///C:/x on Windows arrives with a leading slash before the drive.
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p;
}

// The driver. Kept apart from the class so the tests can run a server on a pair
// of arrays instead of real pipes.
export function serve({ input = process.stdin, output = process.stdout, log } = {}) {
  const reader = new MessageReader();
  const server = new LanguageServer({ write: (buf) => output.write(buf), log });

  input.on('data', (chunk) => {
    for (const message of reader.push(chunk)) {
      server.handle(message);
      if (message.method === 'exit') process.exit(server.shutdownRequested ? 0 : 1);
    }
  });
  input.on('end', () => process.exit(0));
  return server;
}
