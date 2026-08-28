import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { smarshError } from './errors.js';
import { Tainted } from './values.js';

// HTTP, behind the `net` capability.
//
// `net` was listed in the capability table, in `--help`, and in the page written
// for models to read. It was not implemented. A project whose entire claim is
// that its claims are enforced cannot advertise an authority that does not
// exist, so this is the implementation of a promise already made.
//
// Three decisions, each of which follows a mistake this project already made
// once with `ffi`:
//
//   Granting `net` opens nothing on its own. `--allow-host api.example.com`
//   names where a run may reach. `ffi` used to be a single yes that opened every
//   module on the machine, and fixing that is what made the capability mean
//   something; there is no reason to repeat it for the network, where the blast
//   radius is larger.
//
//   Redirects are not followed. A 302 can move a request to a host the run was
//   never permitted to reach, which would make the allowlist decorative. The
//   program sees the 3xx and its `Location` and decides for itself -- and that
//   decision goes through the allowlist like any other request.
//
//   Every response is untrusted. It came from a machine you do not control.
//   Marking it at the boundary is the only place the taint model can be sure of
//   it, and `grounded` then refuses it without anything having to remember.
//
// It is synchronous, because the interpreter is. A worker does the fetch and the
// calling thread blocks in `Atomics.wait`. The alternative is an async
// interpreter, which would change every evaluator in the language to serve one
// builtin.

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 8 MB. Larger than any API response worth putting in a string, and small
// enough that a hostile server cannot make the runtime allocate its way out of
// memory before the limit is noticed.
const MAX_RESPONSE = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

// Headers a program must not be able to set. `Host` and the `sec-` family are
// the browser's business; setting them here would let a program lie about where
// a request is going in a way the allowlist below cannot see.
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);

export class NetClient {
  constructor() {
    this.worker = null;
    this.control = null;
    this.data = null;
  }

  start() {
    if (this.worker) return;
    // SharedArrayBuffer is what makes the blocking possible: `Atomics.wait`
    // needs memory both threads can see.
    this.control = new SharedArrayBuffer(8);
    this.data = new SharedArrayBuffer(MAX_RESPONSE);
    this.worker = new Worker(path.join(HERE, 'netWorker.mjs'), {
      workerData: { control: this.control, data: this.data },
    });
    // Without this the process will not exit while the worker is idle.
    this.worker.unref();
  }

  shutdown() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  // Blocks until the worker answers, or the timeout passes.
  request({ method, url, headers, body, timeoutMs }) {
    this.start();
    const signal = new Int32Array(this.control);
    Atomics.store(signal, 0, 0);
    Atomics.store(signal, 1, 0);

    this.worker.postMessage({ method, url, headers, body, timeoutMs });

    // A slightly longer ceiling than the request's own, so the worker's timeout
    // is what fires and the error says `timeout` rather than something vaguer.
    const waited = Atomics.wait(signal, 0, 0, timeoutMs + 5000);
    if (waited === 'timed-out') {
      // The worker is wedged rather than slow. Replace it: reusing it would
      // mean the next request receives this one's answer.
      this.shutdown();
      return { ok: false, error: 'timeout', message: 'the request did not finish', ms: timeoutMs };
    }

    const length = Atomics.load(signal, 1);
    if (length === -1) {
      return {
        ok: false,
        error: 'too_large',
        message: `the response is larger than ${MAX_RESPONSE} bytes`,
        ms: 0,
      };
    }
    const bytes = new Uint8Array(this.data).subarray(0, length);
    return JSON.parse(new TextDecoder().decode(bytes));
  }
}

// ---------------------------------------------------------------------------
// what a run is permitted to reach
// ---------------------------------------------------------------------------

// A host matches if it is named exactly, or if a `*.example.com` entry covers
// it. `*` on its own means anywhere, which a run has to ask for in as many
// words -- the same shape as `--foreign '*'`.
export function hostAllowed(hostname, allowed) {
  if (allowed.has('*')) return true;
  if (allowed.has(hostname)) return true;
  for (const entry of allowed) {
    if (!entry.startsWith('*.')) continue;
    const suffix = entry.slice(1);            // ".example.com"
    // `*.example.com` covers `a.example.com`, and must not cover
    // `notexample.com` or `example.com.evil.test`.
    if (hostname.endsWith(suffix) && hostname.length > suffix.length) return true;
  }
  return false;
}

export function checkUrl(raw, interp, line) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw smarshError('NetError', `\`${raw}\` is not a URL`, line)
      .help('it needs a scheme: https://example.com/path');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw smarshError('NetError', `\`${url.protocol}\` is not a protocol this can speak`, line)
      .note('http and https only');
  }

  // Credentials in a URL end up in the audit manifest, in logs, and in error
  // messages. Refusing them is easier to explain than redacting them everywhere.
  if (url.username || url.password) {
    throw smarshError('NetError', 'a URL with a username or password in it is refused', line)
      .help('send the credential in a header instead, where it can be kept out of the record');
  }

  const allowed = interp.allowedHosts ?? new Set();
  if (!hostAllowed(url.hostname, allowed)) {
    interp.trace.effects.push({
      capability: 'net', by: url.hostname, line, allowed: false,
    });
    const named = [...allowed].sort();
    throw smarshError('CapabilityError',
      `this run may not reach \`${url.hostname}\``, line)
      .withLabel('not a permitted host')
      .note(named.length ? `it may reach: ${named.join(', ')}` : 'no host has been permitted')
      .help(`start it with \`--allow-host ${url.hostname}\`, or \`--allow-host '*'\` for anywhere`);
  }

  return url;
}

export function normaliseHeaders(raw, line) {
  const out = {};
  if (raw === null || raw === undefined) return out;
  const entries = raw instanceof Map ? [...raw.entries()] : Object.entries(raw);
  for (const [k, v] of entries) {
    const name = String(k).toLowerCase();
    if (FORBIDDEN_HEADERS.has(name)) {
      throw smarshError('NetError', `\`${k}\` is not a header a program may set`, line)
        .note('the runtime sets it, and letting a program override it would make the record wrong');
    }
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
      throw smarshError('NetError', `\`${k}\` is not a valid header name`, line);
    }
    const value = String(v);
    // A newline in a header value is request splitting: it lets a program
    // append headers, or a whole second request, to what the runtime sends.
    if (/[\r\n]/.test(value)) {
      throw smarshError('NetError', `the value of \`${k}\` contains a line break`, line)
        .note('that would let a program append headers the runtime did not send');
    }
    out[name] = value;
  }
  return out;
}

export function normaliseMethod(raw, line) {
  const method = String(raw ?? 'GET').toUpperCase();
  if (!METHODS.has(method)) {
    throw smarshError('NetError', `\`${raw}\` is not an HTTP method this speaks`, line)
      .note(`it knows: ${[...METHODS].join(', ')}`);
  }
  return method;
}

// The result, as the language sees it.
//
// Tainted, always. It came from a machine the program does not control, and
// marking it here is the only place that can be relied on. `grounded { ... }`
// then refuses to read it without anything having to remember to check.
export function toSmarshResponse(result, url, method, interp, line) {
  // Recorded on its own channel rather than in `effects`. The capability check
  // has already pushed an effect saying `net` was exercised; adding another
  // would show every request twice in the manifest at two different
  // granularities. A request is its own kind of event and deserves its own.
  if (!result.ok) {
    interp.trace.requests.push({
      method, url: `${url.origin}${url.pathname}`, line, ok: false,
      outcome: result.error, ms: result.ms,
    });
    throw smarshError('NetError', `${method} ${url.href} failed: ${result.message}`, line)
      .note(`after ${result.ms} ms`)
      .help(result.error === 'timeout' ? 'pass a longer timeout as the last argument' : undefined);
  }

  interp.trace.requests.push({
    method, url: `${url.origin}${url.pathname}`, line, ok: true,
    status: result.status, bytes: result.bytes, ms: result.ms,
  });

  const headers = new Map(Object.entries(result.headers));
  const response = new Map([
    ['status', result.status],
    ['ok', result.status >= 200 && result.status < 300],
    ['headers', headers],
    ['body', result.body],
    ['bytes', result.bytes],
    ['ms', result.ms],
  ]);
  return new Tainted(response, ['untrusted']);
}

export { MAX_RESPONSE, DEFAULT_TIMEOUT_MS, METHODS, FORBIDDEN_HEADERS };
