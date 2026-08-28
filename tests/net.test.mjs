import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Interpreter } from '../src/interpreter.js';
import { hostAllowed, normaliseHeaders, normaliseMethod, FORBIDDEN_HEADERS } from '../src/net.js';
import { buildManifest, summarise } from '../src/audit.js';

// The network, behind `net`.
//
// `net` was in the capability table, in `--help` and in the page written for
// models to read, and was implemented nowhere. Most of what is tested here is
// the boundary rather than the fetching: which hosts a run may reach, what a
// program may put in a header, and what the record says afterwards.

function run(source, { caps = [], hosts = [] } = {}) {
  const out = [];
  const interp = new Interpreter({ out: (s) => out.push(s), caps, hosts, seed: 1 });
  try {
    interp.run(source, 't.smarsh');
    return { out, error: null, message: '', interp };
  } catch (e) {
    return { out, error: e.kind ?? 'error', message: e.message ?? '', interp };
  } finally {
    interp.net?.shutdown();
    interp.devices.shutdown();
  }
}

// ---------------------------------------------------------------------------
// the allowlist, which is the whole security boundary
// ---------------------------------------------------------------------------

test('an exact host matches, and nothing else does', () => {
  const allowed = new Set(['api.example.com']);
  assert.equal(hostAllowed('api.example.com', allowed), true);
  assert.equal(hostAllowed('other.example.com', allowed), false);
  assert.equal(hostAllowed('example.com', allowed), false);
});

test('a wildcard covers subdomains and only subdomains', () => {
  const allowed = new Set(['*.example.com']);
  assert.equal(hostAllowed('api.example.com', allowed), true);
  assert.equal(hostAllowed('a.b.example.com', allowed), true);

  // The three ways a suffix match goes wrong, each of which is a real bypass.
  assert.equal(hostAllowed('example.com', allowed), false, 'the bare domain matched a subdomain rule');
  assert.equal(hostAllowed('notexample.com', allowed), false, '`notexample.com` matched `*.example.com`');
  assert.equal(hostAllowed('example.com.evil.test', allowed), false, 'a suffix attack matched');
});

test('a star on its own means anywhere, and has to be asked for', () => {
  assert.equal(hostAllowed('anything.at.all', new Set(['*'])), true);
  assert.equal(hostAllowed('anything.at.all', new Set()), false);
});

test('granting net without naming a host opens nothing', () => {
  // The mistake `ffi` used to make, not repeated where the blast radius is
  // larger.
  const r = run('http_get("https://example.com")', { caps: ['net'] });
  assert.equal(r.error, 'CapabilityError');
  assert.match(r.message, /may not reach `example.com`/);
});

test('naming a host without granting net opens nothing either', () => {
  const r = run('http_get("https://example.com")', { hosts: ['example.com'] });
  assert.equal(r.error, 'CapabilityError');
  assert.match(r.message, /needs the 'net' capability/);
});

test('a refused host is recorded, not only raised', () => {
  const r = run(
    'attempt { http_get("https://nope.test") } rescue e { print(e["kind"]) }',
    { caps: ['net'], hosts: ['yes.test'] },
  );
  const refused = r.interp.trace.effects.filter((e) => e.capability === 'net' && !e.allowed);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].by, 'nope.test');
});

// ---------------------------------------------------------------------------
// what a url may be
// ---------------------------------------------------------------------------

test('only http and https', () => {
  for (const url of ['file:///etc/passwd', 'ftp://x.test/', 'data:text/plain,hi']) {
    const r = run(`http_get("${url}")`, { caps: ['net'], hosts: ['*'] });
    assert.equal(r.error, 'NetError', `${url} was not refused`);
  }
});

test('credentials in a url are refused rather than redacted', () => {
  // They would otherwise reach the audit manifest, the logs and the error
  // messages, and redacting them in three places is three chances to miss one.
  const r = run('http_get("https://user:secret@example.com/")', { caps: ['net'], hosts: ['*'] });
  assert.equal(r.error, 'NetError');
  assert.match(r.message, /username or password/);
  assert.doesNotMatch(r.message, /secret/, 'the password appeared in the error');
});

test('something that is not a url says so', () => {
  const r = run('http_get("not a url")', { caps: ['net'], hosts: ['*'] });
  assert.equal(r.error, 'NetError');
  assert.match(r.message, /is not a URL/);
});

// ---------------------------------------------------------------------------
// headers, where request splitting lives
// ---------------------------------------------------------------------------

test('a header value containing a line break is refused', () => {
  // Otherwise a program can append headers -- or a whole second request -- to
  // what the runtime sends.
  assert.throws(
    () => normaliseHeaders({ 'x-a': 'ok\r\nX-Injected: yes' }, 1),
    /line break/,
  );
  assert.throws(() => normaliseHeaders({ 'x-a': 'ok\nmore' }, 1), /line break/);
});

test('the headers the runtime owns cannot be set by a program', () => {
  for (const name of FORBIDDEN_HEADERS) {
    assert.throws(() => normaliseHeaders({ [name]: 'x' }, 1), /not a header a program may set/);
    // And case does not get around it.
    assert.throws(() => normaliseHeaders({ [name.toUpperCase()]: 'x' }, 1), /may set/);
  }
});

test('a header name that is not a header name is refused', () => {
  assert.throws(() => normaliseHeaders({ 'bad name': 'x' }, 1), /not a valid header name/);
  assert.throws(() => normaliseHeaders({ 'a:b': 'x' }, 1), /not a valid header name/);
});

test('ordinary headers survive, lowercased', () => {
  assert.deepEqual(normaliseHeaders({ Authorization: 'Bearer x', 'X-Trace': '1' }, 1),
    { authorization: 'Bearer x', 'x-trace': '1' });
  assert.deepEqual(normaliseHeaders(null, 1), {});
});

test('only methods it can speak', () => {
  assert.equal(normaliseMethod('get', 1), 'GET');
  assert.equal(normaliseMethod(undefined, 1), 'GET');
  assert.throws(() => normaliseMethod('TRACE', 1), /not an HTTP method/);
  assert.throws(() => normaliseMethod('BREW', 1), /not an HTTP method/);
});

// ---------------------------------------------------------------------------
// against a real server
// ---------------------------------------------------------------------------

// The server runs as its own process, and that is not incidental.
//
// The synchronous client blocks the calling thread in `Atomics.wait` while a
// worker performs the fetch. A server sharing that thread's event loop can
// never answer -- the thread is parked, not running the loop -- so an
// in-process server deadlocks and the failure looks exactly like a slow
// network. It cost half an hour to see the first time.
async function withServer(behaviour, body) {
  const child = spawn(process.execPath, [SERVER, behaviour], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the test server never reported a port')), 15000);
      let buffered = '';
      child.stdout.on('data', (c) => {
        buffered += c.toString();
        const m = /PORT (\d+)/.exec(buffered);
        if (m) { clearTimeout(timer); resolve(Number(m[1])); }
      });
      child.on('error', reject);
    });
    return await body(port);
  } finally {
    child.kill();
  }
}

const NET = { caps: ['net'], hosts: ['127.0.0.1'] };
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'httpServer.mjs');

test('a request goes out and the response comes back', async () => {
  await withServer('echo', (port) => {
    const r = run([
      `let r = http_get("http://127.0.0.1:${port}/hello")`,
      'print(str(r["status"]))',
      'let d = json_parse(r["body"])',
      'print(d["method"] + " " + d["path"])',
    ].join('\n'), NET);
    assert.equal(r.error, null);
    // `str` of a tainted value shows the taint, which is the point: a response
    // from outside cannot be printed as though it were ordinary data.
    assert.equal(r.out[0], '200#{untrusted}');
    assert.match(r.out[1], /GET \/hello/);
  });
});

test('the response is untrusted, because it came from outside', async () => {
  await withServer('plain', (port) => {
    const r = run([
      `let r = http_get("http://127.0.0.1:${port}/")`,
      'print(str(is_tainted(r)))',
      'print(str(is_tainted(r["body"])))',
    ].join('\n'), NET);
    assert.deepEqual(r.out, ['true', 'true']);
  });
});

test('a grounded block refuses a response without anything remembering to check', async () => {
  await withServer('plain', (port) => {
    const r = run([
      `let r = http_get("http://127.0.0.1:${port}/")`,
      'grounded { print(r["body"]) }',
    ].join('\n'), NET);
    assert.equal(r.error, 'TaintError');
  });
});

test('a map body is sent as JSON, with the content type set', async () => {
  await withServer('echo', (port) => {
    const r = run([
      `let r = http_post("http://127.0.0.1:${port}/", { "body": { "a": 1, "total": 19.99d } })`,
      'let d = json_parse(r["body"])',
      'print(d["got"])',
      'print(d["contentType"])',
    ].join('\n'), NET);
    assert.equal(r.error, null);
    // The decimal is written exactly, not as a float.
    assert.match(r.out[0], /\{"a":1,"total":19\.99\}/);
    assert.match(r.out[1], /application\/json/);
  });
});

test('a redirect is handed back rather than followed', async () => {
  // Following it would let a 302 move the request to a host the run was never
  // permitted to reach, which would make the allowlist decorative.
  await withServer('redirect', (port) => {
    const r = run([
      `let r = http_get("http://127.0.0.1:${port}/")`,
      'print(str(r["status"]))',
      'print(r["headers"]["location"])',
    ].join('\n'), NET);
    assert.equal(r.out[0], '302#{untrusted}');
    assert.match(r.out[1], /somewhere\.else\.test/);
  });
});

test('a slow server hits the timeout rather than hanging', async () => {
  await withServer('slow', (port) => {
    const started = Date.now();
    const r = run(
      `http_get("http://127.0.0.1:${port}/", { "timeout_ms": 300 })`, NET,
    );
    assert.equal(r.error, 'NetError');
    assert.match(r.message, /failed/);
    assert.ok(Date.now() - started < 4000, 'the timeout did not fire');
  });
});

test('a non-2xx status is a response, not an error', async () => {
  // The program decides what a 404 means; the runtime does not.
  await withServer('notfound', (port) => {
    const r = run([
      `let r = http_get("http://127.0.0.1:${port}/")`,
      'print(str(r["status"]) + " ok=" + str(r["ok"]))',
    ].join('\n'), NET);
    assert.equal(r.error, null);
    assert.match(r.out[0], /404 ok=false/);
  });
});

// ---------------------------------------------------------------------------
// the record
// ---------------------------------------------------------------------------

test('the manifest says where the run could reach, not only that it used net', async () => {
  await withServer('plain', (port) => {
    const r = run(`http_get("http://127.0.0.1:${port}/thing")`, NET);
    const m = buildManifest(r.interp, { file: 't.smarsh', source: 'x', outcome: 'completed' });
    assert.deepEqual(m.data.hosts_permitted, ['127.0.0.1']);

    const text = summarise(m);
    assert.match(text, /network boundary\s+limited to 127\.0\.0\.1/);
    // And the replay line must actually reproduce the run.
    assert.match(text, /--allow-host 127\.0\.0\.1/);
  });
});

test('an unbounded run says so plainly', () => {
  const r = run('print(1)', { caps: ['net'], hosts: ['*'] });
  const m = buildManifest(r.interp, { file: 't.smarsh', source: 'x', outcome: 'completed' });
  assert.match(summarise(m), /network boundary\s+UNBOUNDED/);
});

test('a run that never reaches the network records no boundary', () => {
  const r = run('print(1)');
  const m = buildManifest(r.interp, { file: 't.smarsh', source: 'x', outcome: 'completed' });
  assert.deepEqual(m.data.hosts_permitted, []);
  assert.doesNotMatch(summarise(m), /network boundary/);
});

test('each request is recorded with its status and size', async () => {
  await withServer('plain', (port) => {
    const r = run(`http_get("http://127.0.0.1:${port}/thing")`, NET);
    // Requests live on their own channel, not in `effects`. The capability
    // check already records that `net` was exercised; putting the request there
    // too would show every one of them twice at two different granularities.
    const calls = r.interp.trace.requests;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.match(calls[0].url, /^http:\/\/127\.0\.0\.1:\d+\/thing$/);
    assert.equal(calls[0].ok, true);
    assert.equal(calls[0].status, 200);
    assert.equal(calls[0].bytes, 5);

    // And it reaches the manifest as an event a reviewer can read.
    const m = buildManifest(r.interp, { file: 't.smarsh', source: 'x', outcome: 'completed' });
    const event = m.events.find((e) => e.event === 'net.request');
    assert.ok(event, 'the request never reached the manifest');
    assert.match(event.to, /^GET http:\/\/127\.0\.0\.1/);
    assert.equal(event.status, 200);
    assert.equal(m.data.requests, 1);
    assert.equal(m.data.requests_failed, 0);
  });
});

// ---------------------------------------------------------------------------
// arity
// ---------------------------------------------------------------------------

test('the three entry points check their arguments', () => {
  assert.equal(run('http_get()', NET).error, 'ArityError');
  assert.equal(run('http_get("http://127.0.0.1/", {}, 3)', NET).error, 'ArityError');
  assert.equal(run('http("GET")', NET).error, 'ArityError');
  assert.equal(run('http("NOPE", "http://127.0.0.1/")', NET).error, 'NetError');
});
