import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Interpreter } from '../src/interpreter.js';
import { buildManifest, summarise } from '../src/audit.js';

// The foreign boundary, and which side of it a run may reach.
//
// `ffi` used to be a single yes: granting it opened every module on the
// machine, which made it the one capability whose name told you nothing about
// what it reached. It is now named the way every other authority is, and
// granting `ffi` without saying what for opens nothing.

function run(source, { caps = [], foreign = [] } = {}) {
  const out = [];
  const interp = new Interpreter({ out: (s) => out.push(s), caps, foreign, seed: 1 });
  try {
    interp.run(source, 't.pedag');
    return { out, error: null, interp };
  } catch (e) {
    return { out, error: e.kind ?? 'error', message: e.message ?? '', interp };
  } finally {
    interp.devices.shutdown();
  }
}

test('ffi alone opens nothing', () => {
  const r = run('let os = foreign("node:os")', { caps: ['ffi'] });
  assert.equal(r.error, 'CapabilityError');
  assert.match(r.message, /may not load `node:os`/);
});

test('a named module opens, and only that one', () => {
  assert.equal(
    run('let os = foreign("node:os")\nprint(type(os))', { caps: ['ffi'], foreign: ['node:os'] }).error,
    null,
  );
  const other = run('let p = foreign("node:path")', { caps: ['ffi'], foreign: ['node:os'] });
  assert.equal(other.error, 'CapabilityError');
  assert.match(other.message, /node:path/);
});

test('several may be named', () => {
  const r = run([
    'let os = foreign("node:os")',
    'let p = foreign("node:path")',
    'print(type(os) + " " + type(p))',
  ].join('\n'), { caps: ['ffi'], foreign: ['node:os', 'node:path'] });
  assert.equal(r.error, null);
});

test("'*' restores the old behaviour, explicitly", () => {
  assert.equal(run('let p = foreign("node:path")', { caps: ['ffi'], foreign: ['*'] }).error, null);
});

test('the capability is still required, and is checked first', () => {
  // Naming a module does not grant the authority to cross at all. And the
  // capability is refused before the allowlist is consulted, so a function that
  // forgot `needs ffi` gets the error about the thing it actually got wrong.
  const r = run('fn sneaky() { return foreign("node:os") }\nsneaky()',
    { caps: ['ffi'], foreign: ['node:os'] });
  assert.equal(r.error, 'CapabilityError');
  assert.match(r.message, /needs the 'ffi' capability/);
});

test('a refusal is recorded, not only raised', () => {
  const r = run('attempt { foreign("node:os") } rescue e { print(e["kind"]) }', { caps: ['ffi'] });
  const refused = r.interp.trace.effects.filter((e) => e.capability === 'ffi' && !e.allowed);
  assert.ok(refused.length > 0, 'the refusal never reached the trace');
  assert.equal(refused[0].by, 'node:os');
});

test('the manifest says what the boundary was, not just what crossed it', () => {
  // A run that loaded one harmless module while permitted to load anything is
  // not the same as one that could only load that module, and a reviewer
  // cannot tell the difference from the crossings alone.
  const bounded = run('let os = foreign("node:os")', { caps: ['ffi'], foreign: ['node:os'] });
  const m1 = buildManifest(bounded.interp, { file: 't.pedag', source: 'x', outcome: 'completed' });
  assert.deepEqual(m1.data.foreign_permitted, ['node:os']);
  assert.match(summarise(m1), /limited to node:os/);

  const open = run('let os = foreign("node:os")', { caps: ['ffi'], foreign: ['*'] });
  const m2 = buildManifest(open.interp, { file: 't.pedag', source: 'x', outcome: 'completed' });
  assert.deepEqual(m2.data.foreign_permitted, ['*']);
  assert.match(summarise(m2), /UNBOUNDED/);

  // Both loaded exactly the same module. Only the permission differs.
  assert.deepEqual(m1.data.foreign_modules, m2.data.foreign_modules);
});

test('a run that never crosses records an empty boundary', () => {
  const r = run('print(1)');
  const m = buildManifest(r.interp, { file: 't.pedag', source: 'x', outcome: 'completed' });
  assert.deepEqual(m.data.foreign_permitted, []);
  assert.doesNotMatch(summarise(m), /boundary/);
});
