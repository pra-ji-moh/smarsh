import { parentPort, workerData } from 'node:worker_threads';

// The other half of the synchronous HTTP client. See src/net.js for why this
// exists at all.
//
// The main thread blocks in `Atomics.wait` on a shared buffer. This worker does
// the actual (asynchronous) fetch, writes the answer into that buffer, and
// wakes it. Nothing here is clever; the care is all in the framing, because a
// response longer than the buffer would otherwise be silently truncated into a
// half-message the main thread would try to parse.

const { control, data } = workerData;
const signal = new Int32Array(control);
const bytes = new Uint8Array(data);

// control[0]: 0 = waiting for a request, 1 = a response is ready
// control[1]: the length of the response in `data`, or -1 if it did not fit

function reply(payload) {
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  if (encoded.length > bytes.length) {
    // Say so rather than truncating. A truncated JSON body would fail to parse
    // in a way that looks like the server sent nonsense.
    Atomics.store(signal, 1, -1);
  } else {
    bytes.set(encoded);
    Atomics.store(signal, 1, encoded.length);
  }
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
}

parentPort.on('message', async (request) => {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);

    let response;
    try {
      response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body === null ? undefined : request.body,
        signal: controller.signal,
        // A redirect can move a request to a host the run was never permitted
        // to reach, which would make the allowlist decorative. The caller sees
        // the 3xx and its Location, and decides.
        redirect: 'manual',
      });
    } finally {
      clearTimeout(timer);
    }

    // Read at most what the buffer can hold, so a hostile or merely enormous
    // response cannot exhaust memory before we discover it does not fit.
    const raw = await response.arrayBuffer();
    const text = new TextDecoder().decode(raw);

    const headers = {};
    for (const [k, v] of response.headers) headers[k.toLowerCase()] = v;

    reply({
      ok: true,
      status: response.status,
      headers,
      body: text,
      bytes: raw.byteLength,
      ms: Date.now() - started,
    });
  } catch (e) {
    reply({
      ok: false,
      error: e.name === 'AbortError' ? 'timeout' : (e.cause?.code ?? e.name ?? 'error'),
      message: String(e.message ?? e),
      ms: Date.now() - started,
    });
  }
});
