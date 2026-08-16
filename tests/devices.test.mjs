import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Interpreter } from '../src/interpreter.js';
import { PedagError } from '../src/errors.js';
import { Tensor } from '../src/tensor.js';
import { Arena, Weights, topology, pressure, cpuMatmul, DeviceRegistry } from '../src/devices.js';

function run(src, opts = {}) {
  const out = [];
  const interp = new Interpreter({ ...opts, out: (s) => out.push(s) });
  try {
    const value = interp.run(src, '<test>');
    return { value, out, interp };
  } finally {
    interp.devices.shutdown();
  }
}

function fails(src, opts = {}) {
  try {
    run(src, opts);
  } catch (e) {
    if (e instanceof PedagError) return e;
    throw e;
  }
  throw new Error('expected the program to fail, but it ran cleanly');
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'Pēdāg-test-'));

// ---------------------------------------------------------------------------
// backends
// ---------------------------------------------------------------------------

test('the cpu backend is the default and is always present', () => {
  const { value } = run('[devices().contains("cpu"), device_stats()["active"]]');
  assert.deepEqual(value, [true, 'cpu']);
});

test('an unknown device is refused by name', () => {
  const e = fails('device "cuda" { tensor [1] @ tensor [1] }');
  assert.equal(e.kind, 'DeviceError');
  assert.match(e.message, /no device named 'cuda'/);
});

// The property that matters: switching substrate must not change answers.
test('the worker backend computes exactly what the cpu backend does', { timeout: 60000 }, () => {
  const registry = new DeviceRegistry();
  try {
    const m = 96;
    const k = 80;
    const n = 72;
    const a = new Float64Array(m * k);
    const b = new Float64Array(k * n);
    for (let i = 0; i < a.length; i++) a[i] = Math.sin(i) * 3;
    for (let i = 0; i < b.length; i++) b[i] = Math.cos(i) * 2;

    const expected = cpuMatmul(a, b, m, k, n);
    const workers = registry.ensureWorkers(4);
    const got = workers.matmul(a, b, m, k, n);

    assert.equal(got.length, expected.length);
    for (let i = 0; i < expected.length; i++) {
      assert.ok(Math.abs(got[i] - expected[i]) < 1e-9,
        `cell ${i}: workers gave ${got[i]}, cpu gave ${expected[i]}`);
    }
    assert.ok(workers.dispatched > 0, 'the job should have gone to the threads');
  } finally {
    registry.shutdown();
  }
});

test('a job too large for the shared scratch falls back rather than failing', { timeout: 60000 }, () => {
  const registry = new DeviceRegistry();
  try {
    const workers = registry.ensureWorkers(2);
    const m = 4;
    const k = 4;
    const n = 4;
    workers.data = new Float64Array(4);            // pretend the scratch is tiny
    const a = Float64Array.from({ length: m * k }, (_, i) => i);
    const b = Float64Array.from({ length: k * n }, (_, i) => i);
    const got = workers.matmul(a, b, m, k, n);
    assert.deepEqual([...got], [...cpuMatmul(a, b, m, k, n)]);
    assert.ok(workers.fellBack > 0);
  } finally {
    registry.shutdown();
  }
});

test('a device block routes matmul and restores the previous device', { timeout: 60000 }, () => {
  const { value } = run(`
    let a = tensor [[1, 2], [3, 4]]
    var inside = nil
    device "workers" 2 {
      inside = device_stats()["active"]
      a @ a
    }
    [inside, device_stats()["active"], (a @ a).tolist()]
  `);
  assert.equal(value[0], 'workers');
  assert.equal(value[1], 'cpu');
  assert.deepEqual(value[2], [[7, 10], [15, 22]]);
});

test('small jobs stay on this thread even under the worker device', { timeout: 60000 }, () => {
  const { value } = run(`
    device "workers" 2 {
      let a = tensor [[1, 2], [3, 4]]
      a @ a
    }
    device_stats()["workers"]["ran_here_instead"] > 0
  `);
  assert.equal(value, true, 'a 2x2 multiply is not worth a thread round trip');
});

test('results are identical whichever device ran them', { timeout: 60000 }, () => {
  const src = (dev) => `
    let a = zeros([70, 70]).map(fn(x) { return 1 })
    var out = nil
    ${dev === 'cpu' ? '' : `device "workers" 3 {`}
    out = a @ a
    ${dev === 'cpu' ? '' : '}'}
    [out.sum(), out.shape]
  `;
  assert.deepEqual(run(src('cpu')).value, run(src('workers')).value);
});

// ---------------------------------------------------------------------------
// the machine underneath
// ---------------------------------------------------------------------------

test('topology reports the real machine', () => {
  const t = topology();
  assert.ok(t.get('cores') >= 1);
  assert.equal(t.get('platform'), os.platform());
  assert.equal(t.get('arch'), os.arch());
  assert.ok(t.get('memory_mb') > 0);
});

test('pressure reports observable load, in range', () => {
  const p = pressure();
  assert.ok(p.get('busy') >= 0 && p.get('busy') <= 1);
  assert.ok(p.get('free_ratio') >= 0 && p.get('free_ratio') <= 1);
});

test('the machine is visible from the language', () => {
  const { value } = run('[topology()["cores"] >= 1, pressure()["busy"] >= 0]');
  assert.deepEqual(value, [true, true]);
});

// ---------------------------------------------------------------------------
// arena
// ---------------------------------------------------------------------------

test('an arena holds and returns tensors', () => {
  const a = new Arena(10000);
  const t = Tensor.fromNested([1, 2, 3]);
  a.hold('x', t);
  assert.equal(a.get('x'), t);
  assert.equal(a.resident, 24);
});

test('an arena refuses a tensor larger than itself', () => {
  const a = new Arena(8);
  assert.throws(() => a.hold('big', Tensor.fromNested([1, 2, 3])), /the whole arena is 8/);
});

test('without a spill directory, going over budget is an error not a silent drop', () => {
  const a = new Arena(48);
  a.hold('one', Tensor.fromNested([1, 2, 3]));
  assert.throws(() => a.hold('two', Tensor.fromNested([4, 5, 6, 7])), /nowhere to spill/);
});

test('with a spill directory, the oldest entries go to disk and come back intact', () => {
  const dir = tmp();
  const a = new Arena(48, dir);
  a.hold('one', Tensor.fromNested([1, 2, 3]));
  a.hold('two', Tensor.fromNested([4, 5, 6]));
  a.hold('three', Tensor.fromNested([7, 8, 9]));
  assert.ok(a.spilled > 0, 'something should have been written out');
  assert.ok(a.resident <= 48);

  // The spilled entry is not lost: it is read back on demand, unchanged.
  assert.deepEqual(a.get('one').toNested(), [1, 2, 3]);
  assert.ok(a.restored > 0);
  assert.deepEqual(a.get('three').toNested(), [7, 8, 9]);
});

test('reclaim releases what it is not told to keep, and reports the pause it caused', () => {
  const a = new Arena(100000);
  a.hold('keep', Tensor.fromNested([1, 2, 3]));
  a.hold('drop', Tensor.fromNested([4, 5, 6]));
  const r = a.reclaim(new Set(['keep']));
  assert.equal(r.count, 1);
  assert.equal(r.bytes, 24);
  assert.ok(r.nanos > 0, 'the pause is measured, not assumed');
  assert.deepEqual(a.get('keep').toNested(), [1, 2, 3]);
  assert.throws(() => a.get('drop'), /not holding/);
});

test('the arena reaches the language', () => {
  const { value } = run(`
    let a = arena(100000)
    a.hold("w", tensor [[1, 2], [3, 4]])
    let back = a.get("w")
    let r = a.reclaim()
    [back.tolist(), r["released"], r["nanos"] >= 0, a.held]
  `);
  assert.deepEqual(value[0], [[1, 2], [3, 4]]);
  assert.equal(value[1], 1);
  assert.equal(value[2], true);
  assert.equal(value[3], 0);
});

test('spilling to disk needs the fs capability', () => {
  assert.equal(fails('arena(100, "scratch")').kind, 'CapabilityError');
});

// ---------------------------------------------------------------------------
// weights
// ---------------------------------------------------------------------------

function writeWeights(dir, rows, cols) {
  const file = path.join(dir, 'w.f32');
  const buf = Buffer.allocUnsafe(rows * cols * 4);
  for (let i = 0; i < rows * cols; i++) buf.writeFloatLE(i, i * 4);
  fs.writeFileSync(file, buf);
  return file;
}

test('weights are paged from disk a row at a time', () => {
  const dir = tmp();
  const file = writeWeights(dir, 100, 8);
  const w = new Weights(file, [100, 8], 'f32');
  try {
    assert.deepEqual([...w.row(0).data], [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual([...w.row(3).data], [24, 25, 26, 27, 28, 29, 30, 31]);
    assert.equal(w.reads, 2, 'only the rows asked for were read');
    w.row(0);
    assert.equal(w.hits, 1, 'a repeat read comes from the cache');
    assert.ok(w.bytes === 100 * 8 * 4);
  } finally {
    w.close();
  }
});

test('the row cache is bounded, so a huge file never becomes resident', () => {
  const dir = tmp();
  const file = writeWeights(dir, 500, 4);
  const w = new Weights(file, [500, 4], 'f32', 8);
  try {
    for (let i = 0; i < 200; i++) w.row(i);
    assert.equal(w.cache.size, 8, 'the cache must not grow with the file');
  } finally {
    w.close();
  }
});

test('a weights file smaller than its declared shape is refused', () => {
  const dir = tmp();
  const file = writeWeights(dir, 4, 4);
  assert.throws(() => new Weights(file, [1000, 4], 'f32'), /needs/);
});

test('weights are immutable and reach the language', () => {
  const dir = tmp();
  writeWeights(dir, 16, 4);
  const { value } = run(`
    let w = weights("w.f32", [16, 4], "f32")
    let r = w.row(2)
    [w.shape, r.tolist(), w.dtype]
  `, { caps: ['fs'], cwd: dir });
  assert.deepEqual(value[0], [16, 4]);
  assert.deepEqual(value[1], [8, 9, 10, 11]);
  assert.equal(value[2], 'f32');
});

test('opening weights needs the fs capability', () => {
  assert.equal(fails('weights("w.f32", [1, 1], "f32")').kind, 'CapabilityError');
});
