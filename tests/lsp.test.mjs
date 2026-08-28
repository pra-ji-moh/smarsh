import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LanguageServer, MessageReader, encode, offsetOf, spanToRange, uriToPath } from '../src/lsp.js';

// The language server, driven over the real protocol.
//
// Every test below goes through `handle`, which is what an editor calls, rather
// than reaching past it into the helpers. A server that works when poked
// directly and fails on the wire is the normal way this goes wrong: the framing
// and the zero-vs-one-based positions are where the bugs live, not the logic.

function connect() {
  const sent = [];
  const reader = new MessageReader();
  const server = new LanguageServer({
    write: (buf) => { for (const m of reader.push(buf)) sent.push(m); },
    log: () => {},
  });
  return {
    server,
    sent,
    // Drive it the way a client does, and hand back what came out.
    call(method, params, id) {
      const before = sent.length;
      server.handle({ jsonrpc: '2.0', id, method, params });
      return sent.slice(before);
    },
    replyTo(id) { return sent.find((m) => m.id === id); },
    diagnosticsFor(uri) {
      const notes = sent.filter((m) => m.method === 'textDocument/publishDiagnostics'
        && m.params.uri === uri);
      return notes.length ? notes[notes.length - 1].params.diagnostics : null;
    },
  };
}

const URI = 'file:///tmp/t.smarsh';

function open(c, text, uri = URI) {
  c.call('textDocument/didOpen', { textDocument: { uri, languageId: 'smarsh', version: 1, text } });
  return c.diagnosticsFor(uri);
}

// ---------------------------------------------------------------------------
// the wire
// ---------------------------------------------------------------------------

test('a framed message round-trips', () => {
  const reader = new MessageReader();
  const got = reader.push(encode({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
  assert.equal(got.length, 1);
  assert.equal(got[0].method, 'initialize');
});

test('a message split across chunks is reassembled', () => {
  // Which is the normal case on a pipe, and the normal way naive framing breaks.
  const reader = new MessageReader();
  const whole = encode({ jsonrpc: '2.0', id: 7, method: 'shutdown' });
  for (let cut = 1; cut < whole.length; cut += 7) {
    const r = new MessageReader();
    assert.deepEqual(r.push(whole.subarray(0, cut)), [], `a partial frame at ${cut} produced a message`);
    const rest = r.push(whole.subarray(cut));
    assert.equal(rest.length, 1, `the frame never completed when split at ${cut}`);
    assert.equal(rest[0].id, 7);
  }
  assert.equal(reader.push(whole).length, 1);
});

test('several messages in one chunk all arrive', () => {
  const reader = new MessageReader();
  const chunk = Buffer.concat([
    encode({ jsonrpc: '2.0', id: 1, method: 'a' }),
    encode({ jsonrpc: '2.0', id: 2, method: 'b' }),
    encode({ jsonrpc: '2.0', id: 3, method: 'c' }),
  ]);
  assert.deepEqual(reader.push(chunk).map((m) => m.id), [1, 2, 3]);
});

test('the length is in bytes, not characters', () => {
  // The one that breaks on this language's own documentation: a multi-byte
  // character makes byte length and string length disagree, and counting the
  // wrong one desynchronises every message after it.
  const text = 'let s = "\u00e9\u00e8\u00ea \u2014 \ud83d\ude00"';
  const reader = new MessageReader();
  const frame = encode({ jsonrpc: '2.0', id: 1, method: 'x', params: { text } });
  const header = frame.subarray(0, frame.indexOf('\r\n\r\n')).toString('ascii');
  const declared = Number(/Content-Length:\s*(\d+)/.exec(header)[1]);
  assert.equal(declared, frame.length - frame.indexOf('\r\n\r\n') - 4);

  const got = reader.push(Buffer.concat([frame, encode({ jsonrpc: '2.0', id: 2, method: 'y' })]));
  assert.deepEqual(got.map((m) => m.id), [1, 2], 'the stream desynchronised after a multi-byte body');
  assert.equal(got[0].params.text, text);
});

test('a malformed body does not stop the stream', () => {
  const reader = new MessageReader();
  const bad = Buffer.from('Content-Length: 5\r\n\r\n{not}', 'utf8');
  reader.push(bad);
  const good = reader.push(encode({ jsonrpc: '2.0', id: 9, method: 'ok' }));
  assert.equal(good.length, 1);
  assert.equal(good[0].id, 9);
});

// ---------------------------------------------------------------------------
// handshake
// ---------------------------------------------------------------------------

test('initialize advertises what it actually implements', () => {
  const c = connect();
  c.call('initialize', {}, 1);
  const caps = c.replyTo(1).result.capabilities;
  assert.equal(caps.textDocumentSync, 1);
  assert.ok(caps.completionProvider);
  assert.equal(caps.hoverProvider, true);
  assert.equal(caps.definitionProvider, true);
  assert.equal(caps.documentSymbolProvider, true);
});

test('an unsupported request is answered rather than left hanging', () => {
  // A client that never gets a reply waits forever, which looks like a hang
  // rather than a missing feature.
  const c = connect();
  c.call('textDocument/formatting', {}, 42);
  const reply = c.replyTo(42);
  assert.ok(reply.error, 'no error reply was sent');
  assert.equal(reply.error.code, -32601);
});

test('an unsupported notification is answered with nothing at all', () => {
  const c = connect();
  const out = c.call('$/setTrace', { value: 'off' });
  assert.deepEqual(out, [], 'a notification must not be replied to');
});

test('shutdown is recorded, and replies null', () => {
  const c = connect();
  c.call('shutdown', {}, 3);
  assert.equal(c.replyTo(3).result, null);
  assert.equal(c.server.shutdownRequested, true);
});

// ---------------------------------------------------------------------------
// diagnostics
// ---------------------------------------------------------------------------

test('opening a clean file publishes an empty list, not nothing', () => {
  // Publishing nothing leaves stale squiggles on screen forever.
  const c = connect();
  const d = open(c, 'let x = 1\nprint(x)\n');
  assert.deepEqual(d, []);
});

test('a real error arrives with a range an editor can underline', () => {
  const c = connect();
  const text = 'fn f() {\n  return nope\n}\nf()\n';
  const d = open(c, text);
  assert.equal(d.length, 1);
  const [first] = d;
  assert.equal(first.code, 'E0201');
  assert.equal(first.severity, 1);
  assert.equal(first.source, 'smarsh');
  // Zero-based: `nope` is on the second line, at column 9.
  assert.equal(first.range.start.line, 1);
  assert.equal(first.range.start.character, 9);
  assert.equal(first.range.end.line, 1);
  assert.ok(first.range.end.character > first.range.start.character);
  // The advice is worth as much as the message, so it comes along.
  assert.match(first.message, /not defined/);
});

test('a syntax error is reported rather than swallowed', () => {
  const c = connect();
  const d = open(c, 'fn f( {\n');
  assert.ok(d.length > 0, 'a file that does not parse produced no diagnostics');
  assert.equal(d[0].code, 'E0101');
});

test('editing republishes, and fixing clears', () => {
  const c = connect();
  open(c, 'let x = nope\n');
  assert.equal(c.diagnosticsFor(URI).length, 1);

  c.call('textDocument/didChange', {
    textDocument: { uri: URI, version: 2 },
    contentChanges: [{ text: 'let x = 1\n' }],
  });
  assert.deepEqual(c.diagnosticsFor(URI), [], 'the error survived the fix');
});

test('closing clears the squiggles', () => {
  const c = connect();
  open(c, 'let x = nope\n');
  c.call('textDocument/didClose', { textDocument: { uri: URI } });
  assert.deepEqual(c.diagnosticsFor(URI), []);
  assert.equal(c.server.documents.has(URI), false);
});

test('the editor agrees with the command line', () => {
  // The reason the checker moved into src/: two implementations drift, and the
  // one people trust is whichever disagreed with them last.
  const source = 'fn f() {\n  let xs = []\n  xs.push(1)\n  return nope\n}\nf()\n';
  const c = connect();
  const fromServer = open(c, source).map((d) => d.code).sort();

  // eslint-disable-next-line no-restricted-syntax
  return import('../src/diagnose.js').then(({ diagnose }) => {
    const fromCli = diagnose(source, '/tmp/t.smarsh').map((d) => d.code).sort();
    assert.deepEqual(fromServer, fromCli);
  });
});

test('a suppression pragma is honoured in the editor too', () => {
  const c = connect();
  const d = open(c, '// smarsh-allow: all\nlet x = nope\n');
  assert.deepEqual(d, [], 'the editor ignored a suppression the CLI respects');
});

// ---------------------------------------------------------------------------
// completion
// ---------------------------------------------------------------------------

const labels = (items) => items.map((i) => i.label);

test('completion offers builtins, keywords and the blocks', () => {
  const c = connect();
  open(c, 'let x = 1\n');
  c.call('textDocument/completion', {
    textDocument: { uri: URI }, position: { line: 1, character: 0 },
  }, 5);
  const items = c.replyTo(5).result.items;
  const names = labels(items);
  for (const expected of ['print', 'len', 'authority', 'release_to', 'vouched_by', 'fn', 'let']) {
    assert.ok(names.includes(expected), `completion never offered \`${expected}\``);
  }
});

test('a block completes as a block, with its body open', () => {
  const c = connect();
  open(c, '');
  c.call('textDocument/completion', {
    textDocument: { uri: URI }, position: { line: 0, character: 0 },
  }, 6);
  const item = c.replyTo(6).result.items.find((i) => i.label === 'vouched_by');
  assert.equal(item.insertTextFormat, 2, 'not offered as a snippet');
  assert.match(item.insertText, /vouched_by "\$\{1:principal\}" \{/);
});

test('a builtin that costs authority says so, and sorts after one that does not', () => {
  const c = connect();
  open(c, '');
  c.call('textDocument/completion', {
    textDocument: { uri: URI }, position: { line: 0, character: 0 },
  }, 7);
  const items = c.replyTo(7).result.items;
  const read = items.find((i) => i.label === 'read');
  const len = items.find((i) => i.label === 'len');
  assert.match(read.detail, /needs fs/);
  assert.equal(len.detail, 'builtin');
  assert.ok(read.sortText > len.sortText, 'the one costing authority did not sort later');
});

test('names the file declares are offered first', () => {
  const c = connect();
  open(c, 'fn my_helper(a, b) { return a }\nrecord Point(x, y)\nlet total = 1\n');
  c.call('textDocument/completion', {
    textDocument: { uri: URI }, position: { line: 3, character: 0 },
  }, 8);
  const items = c.replyTo(8).result.items;
  const helper = items.find((i) => i.label === 'my_helper');
  assert.ok(helper, 'a function defined above was not offered');
  assert.match(helper.detail, /fn my_helper\(a, b\)/);
  assert.ok(items.find((i) => i.label === 'Point'), 'a record was not offered');
  assert.ok(items.find((i) => i.label === 'total'), 'a binding was not offered');
  // Ahead of the builtins, which is the whole point of sorting them.
  assert.ok(helper.sortText < items.find((i) => i.label === 'print').sortText);
});

test('after a dot, methods rather than the whole prelude', () => {
  const c = connect();
  open(c, 'let xs = [1]\nxs.\n');
  c.call('textDocument/completion', {
    textDocument: { uri: URI }, position: { line: 1, character: 3 },
  }, 9);
  const names = labels(c.replyTo(9).result.items);
  assert.ok(names.includes('push'));
  assert.ok(names.includes('filter'));
  assert.ok(!names.includes('authority'), 'offered a block after a dot');
  assert.ok(!names.includes('print'), 'offered a bare builtin after a dot');
});

test('inside a needs clause, only capabilities', () => {
  const c = connect();
  open(c, 'fn f() needs \n');
  c.call('textDocument/completion', {
    textDocument: { uri: URI }, position: { line: 0, character: 13 },
  }, 10);
  const names = labels(c.replyTo(10).result.items);
  assert.deepEqual(names.sort(), ['clock', 'crypto', 'ffi', 'fs', 'net', 'unaudited_crypto']);
});

test('completion on an unopened document does not throw', () => {
  const c = connect();
  c.call('textDocument/completion', {
    textDocument: { uri: 'file:///nope.smarsh' }, position: { line: 0, character: 0 },
  }, 11);
  assert.deepEqual(c.replyTo(11).result.items, []);
});

// ---------------------------------------------------------------------------
// hover
// ---------------------------------------------------------------------------

test('hovering a builtin says what it costs', () => {
  const c = connect();
  open(c, 'read("x")\n');
  c.call('textDocument/hover', {
    textDocument: { uri: URI }, position: { line: 0, character: 1 },
  }, 12);
  const hover = c.replyTo(12).result;
  assert.match(hover.contents.value, /Needs `fs`/);
  assert.equal(hover.range.start.character, 0);
  assert.equal(hover.range.end.character, 4);
});

test('hovering a builtin that costs nothing says that too', () => {
  const c = connect();
  open(c, 'len([1])\n');
  c.call('textDocument/hover', {
    textDocument: { uri: URI }, position: { line: 0, character: 1 },
  }, 13);
  assert.match(c.replyTo(13).result.contents.value, /Costs no authority/);
});

test('hovering a function shows its signature and its authority', () => {
  const c = connect();
  open(c, 'fn save(a, b) needs fs { return a }\nsave(1, 2)\n');
  c.call('textDocument/hover', {
    textDocument: { uri: URI }, position: { line: 1, character: 1 },
  }, 14);
  assert.match(c.replyTo(14).result.contents.value, /fn save\(a, b\) needs fs/);
});

test('hovering the end of a word still finds it', () => {
  // The cursor sits between characters, so hovering after the last one is the
  // ordinary case, not an edge case.
  const c = connect();
  open(c, 'len([1])\n');
  c.call('textDocument/hover', {
    textDocument: { uri: URI }, position: { line: 0, character: 3 },
  }, 15);
  assert.ok(c.replyTo(15).result, 'hovering the end of `len` found nothing');
});

test('hovering nothing returns null rather than an empty box', () => {
  const c = connect();
  open(c, 'let x = 1\n');
  c.call('textDocument/hover', {
    textDocument: { uri: URI }, position: { line: 0, character: 7 },
  }, 16);
  assert.equal(c.replyTo(16).result, null);
});

// ---------------------------------------------------------------------------
// definition and outline
// ---------------------------------------------------------------------------

test('go to definition finds a function defined above', () => {
  const c = connect();
  open(c, 'fn helper(a) { return a }\nhelper(1)\n');
  c.call('textDocument/definition', {
    textDocument: { uri: URI }, position: { line: 1, character: 2 },
  }, 17);
  const loc = c.replyTo(17).result;
  assert.equal(loc.uri, URI);
  assert.equal(loc.range.start.line, 0);
});

test('go to definition on a binding lands on the binding itself', () => {
  const c = connect();
  open(c, 'let total = 1\nprint(total)\n');
  c.call('textDocument/definition', {
    textDocument: { uri: URI }, position: { line: 1, character: 8 },
  }, 18);
  assert.equal(c.replyTo(18).result.range.start.line, 0);
});

test('go to definition on a builtin returns null, not a wrong jump', () => {
  // `print` is real, but it is not declared in this file. Jumping somewhere
  // arbitrary would be worse than not jumping at all.
  const c = connect();
  open(c, 'print(1)\n');
  c.call('textDocument/definition', {
    textDocument: { uri: URI }, position: { line: 0, character: 2 },
  }, 20);
  assert.equal(c.replyTo(20).result, null);
});

test('the outline lists what the file declares', () => {
  const c = connect();
  open(c, 'fn a() { return 1 }\nrecord R(x)\nchoice C { P  Q }\nlet v = 1\n');
  c.call('textDocument/documentSymbol', { textDocument: { uri: URI } }, 19);
  const names = c.replyTo(19).result.map((s) => s.name);
  assert.deepEqual(names.sort(), ['C', 'R', 'a', 'v']);
});

// ---------------------------------------------------------------------------
// positions and paths
// ---------------------------------------------------------------------------

test('offsets and positions are inverses', () => {
  const source = 'let a = 1\nlet b = 2\n\nfn f() { return a }\n';
  for (let offset = 0; offset <= source.length; offset++) {
    const range = spanToRange(source, [offset, offset]);
    assert.equal(offsetOf(source, range.start), offset, `round trip failed at ${offset}`);
  }
});

test('a position past the end of a line clamps rather than throwing', () => {
  const source = 'ab\ncd\n';
  assert.equal(offsetOf(source, { line: 0, character: 999 }), source.length);
  assert.equal(offsetOf(source, { line: 99, character: 0 }), source.length);
});

test('a file uri becomes a path on both kinds of platform', () => {
  assert.equal(uriToPath('file:///home/u/a.smarsh'), '/home/u/a.smarsh');
  assert.equal(uriToPath('file:///C:/Users/u/a.smarsh'), 'C:/Users/u/a.smarsh');
  assert.equal(uriToPath('file:///tmp/with%20space.smarsh'), '/tmp/with space.smarsh');
  assert.equal(uriToPath('untitled:Untitled-1'), 'untitled:Untitled-1');
});

test('a document containing multi-byte text is checked at the right columns', () => {
  // Positions come back as UTF-16 code units, which is what LSP specifies and
  // what an editor will underline.
  const c = connect();
  const d = open(c, 'let s = "caf\u00e9"\nlet y = nope\n');
  assert.equal(d.length, 1);
  assert.equal(d[0].range.start.line, 1);
  assert.equal(d[0].range.start.character, 8);
});
