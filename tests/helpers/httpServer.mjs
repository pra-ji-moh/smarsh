import http from 'node:http';

// A throwaway HTTP server, run as its own process.
//
// It cannot be in-process with the tests, and the reason is worth knowing: the
// synchronous HTTP client blocks the calling thread in `Atomics.wait` while a
// worker does the fetch. A server sharing that thread's event loop can never
// answer, because the thread is not running the event loop -- it is parked. The
// request times out and the deadlock looks exactly like a slow network.
//
// This is a real property of a synchronous client in a single-threaded runtime,
// not a quirk of the tests, and it is written down in LIMITATIONS.md.

const behaviour = process.argv[2] ?? 'echo';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    switch (behaviour) {
      case 'redirect':
        res.writeHead(302, { Location: 'https://somewhere.else.test/' });
        res.end();
        return;
      case 'notfound':
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('nope');
        return;
      case 'slow':
        setTimeout(() => res.end('late'), 5000);
        return;
      case 'plain':
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('hello');
        return;
      default:
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          method: req.method,
          path: req.url,
          got: body || null,
          contentType: req.headers['content-type'] ?? null,
        }));
    }
  });
});

server.listen(0, '127.0.0.1', () => {
  // The parent reads this line to learn the port.
  process.stdout.write(`PORT ${server.address().port}\n`);
});
