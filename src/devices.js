import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { Tensor } from './tensor.js';
import { NativeFunction, stringify } from './values.js';
import { smarshError } from './errors.js';

const nf = (name, arity, fn) => new NativeFunction(name, arity, fn);
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Compute backends
// ---------------------------------------------------------------------------
//
// One tensor operation, several places it can run. `device "workers" { ... }`
// changes where, not what: the same source, the same results, a different
// execution substrate.
//
// Two backends ship: `cpu` (this thread) and `workers` (real OS threads over
// SharedArrayBuffers). A GPU backend would implement the same three methods and
// register itself here. None ships, because Node cannot address a GPU without
// a native addon, and a backend named "cuda" that quietly ran on the CPU would
// be a lie told in a place where it is very hard to notice.

const CONTROL_SLOTS = 8;
const GEN = 0;
const REMAINING = 1;
const M = 2;
const K = 3;
const N = 4;
const OFF_A = 5;
const OFF_B = 6;
const OFF_C = 7;

export class WorkerBackend {
  constructor(workers, scratchDoubles) {
    this.name = 'workers';
    this.workerCount = workers;
    this.control = new Int32Array(new SharedArrayBuffer(CONTROL_SLOTS * 4));
    this.dataBuffer = new SharedArrayBuffer(scratchDoubles * 8);
    this.data = new Float64Array(this.dataBuffer);
    this.pool = null;
    this.dispatched = 0;
    this.fellBack = 0;
    this.lastError = null;
    this.unavailable = null;
  }

  get capacity() { return this.data.length; }

  // Threads are expensive to start, so the pool appears the first time a job
  // is actually big enough to want it.
  ensurePool() {
    if (this.pool || this.unavailable) return;
    try {
      this.spawnPool();
    } catch (e) {
      // No worker file next to us -- a bundled build, most likely. Say so once
      // and run everything here instead of failing.
      this.unavailable = e;
      this.pool = null;
    }
  }

  spawnPool() {
    this.pool = [];
    for (let i = 0; i < this.workerCount; i++) {
      const worker = new Worker(path.join(HERE, 'kernelWorker.mjs'), {
        workerData: {
          control: this.control.buffer,
          data: this.dataBuffer,
          index: i,
          workers: this.workerCount,
        },
      });
      worker.unref();                 // never hold the process open
      // Keep the failure instead of swallowing it: a dead worker degrades to a
      // fallback, but the reason should still be reportable.
      worker.on('error', (e) => { this.lastError = e; });
      this.pool.push(worker);
    }
  }

  fits(m, k, n) { return m * k + k * n + m * n <= this.capacity; }

  matmul(a, b, m, k, n, line) {
    if (!this.fits(m, k, n)) {
      this.fellBack += 1;
      return cpuMatmul(a, b, m, k, n);
    }
    this.ensurePool();
    if (!this.pool) {
      this.fellBack += 1;
      return cpuMatmul(a, b, m, k, n);
    }

    const offA = 0;
    const offB = m * k;
    const offC = offB + k * n;
    this.data.set(a, offA);
    this.data.set(b, offB);

    Atomics.store(this.control, M, m);
    Atomics.store(this.control, K, k);
    Atomics.store(this.control, N, n);
    Atomics.store(this.control, OFF_A, offA);
    Atomics.store(this.control, OFF_B, offB);
    Atomics.store(this.control, OFF_C, offC);
    Atomics.store(this.control, REMAINING, this.workerCount);

    Atomics.add(this.control, GEN, 1);
    Atomics.notify(this.control, GEN, this.workerCount);

    // Block until every slice is in. A worker that dies leaves the count
    // stuck, so this gives up rather than hanging the program forever.
    const deadline = Date.now() + 10000;
    for (;;) {
      const left = Atomics.load(this.control, REMAINING);
      if (left === 0) break;
      if (Date.now() > deadline) {
        this.fellBack += 1;
        return cpuMatmul(a, b, m, k, n);
      }
      Atomics.wait(this.control, REMAINING, left, 50);
    }

    this.dispatched += 1;
    return this.data.slice(offC, offC + m * n);
  }

  shutdown() {
    if (!this.pool) return;
    Atomics.store(this.control, GEN, -1);
    Atomics.notify(this.control, GEN, this.workerCount);
    for (const w of this.pool) w.terminate();
    this.pool = null;
  }
}

export function cpuMatmul(a, b, m, k, n) {
  const out = new Float64Array(m * n);
  for (let i = 0; i < m; i++) {
    for (let p = 0; p < k; p++) {
      const av = a[i * k + p];
      if (av === 0) continue;
      const rowB = p * n;
      const rowC = i * n;
      for (let j = 0; j < n; j++) out[rowC + j] += av * b[rowB + j];
    }
  }
  return out;
}

export class CpuBackend {
  constructor() {
    this.name = 'cpu';
    this.dispatched = 0;
  }
  matmul(a, b, m, k, n) {
    this.dispatched += 1;
    return cpuMatmul(a, b, m, k, n);
  }
  shutdown() {}
}

// A job has to be worth the round trip. Below this, threads cost more than
// they save, so `workers` runs it here and says so in its counters.
export const PARALLEL_THRESHOLD = 64 * 64 * 32;

export class DeviceRegistry {
  constructor() {
    this.backends = new Map();
    this.backends.set('cpu', new CpuBackend());
    this.active = this.backends.get('cpu');
  }

  register(name, backend) { this.backends.set(name, backend); }

  // Names a program may ask for. `workers` is listed before its threads exist,
  // because it is available -- it just has not been paid for yet.
  get available() {
    return [...new Set([...this.backends.keys(), 'workers'])].sort();
  }

  get(name, line) {
    if (!this.backends.has(name)) {
      throw smarshError('DeviceError',
        `no device named '${name}'; this build has ${[...this.backends.keys()].join(', ')}`, line);
    }
    return this.backends.get(name);
  }

  // The parallel backend is created on demand, sized to the real machine.
  ensureWorkers(requested, line) {
    const existing = this.backends.get('workers');
    if (existing && (!requested || existing.workerCount === requested)) return existing;
    if (existing) existing.shutdown();
    const cores = Math.max(1, os.cpus().length - 1);
    const count = Math.max(1, Math.min(requested || cores, 32));
    const backend = new WorkerBackend(count, 4 * 1024 * 1024);   // 32 MB scratch
    this.backends.set('workers', backend);
    return backend;
  }

  matmul(a, b, m, k, n, line) {
    const work = m * k * n;
    if (this.active.name === 'workers' && work < PARALLEL_THRESHOLD) {
      this.active.fellBack += 1;
      return cpuMatmul(a, b, m, k, n);
    }
    return this.active.matmul(a, b, m, k, n, line);
  }

  shutdown() {
    for (const b of this.backends.values()) b.shutdown();
  }
}

// ---------------------------------------------------------------------------
// The machine underneath
// ---------------------------------------------------------------------------
//
// Real numbers from the real host: core count, model, clock, memory. What is
// NOT here: NUMA distances, cache hierarchy, interconnect topology or die
// temperature. Node cannot see any of those, and inventing them would be worse
// than admitting it. `pressure` reports load, which is what is actually
// observable -- it is not a thermal reading.

export function topology() {
  const cpus = os.cpus();
  const map = new Map();
  map.set('cores', cpus.length);
  map.set('model', cpus.length ? cpus[0].model.trim() : 'unknown');
  map.set('speed_mhz', cpus.length ? cpus[0].speed : 0);
  map.set('platform', os.platform());
  map.set('arch', os.arch());
  map.set('memory_mb', Math.round(os.totalmem() / (1024 * 1024)));
  map.set('free_mb', Math.round(os.freemem() / (1024 * 1024)));
  return map;
}

export function pressure() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    for (const [kind, ms] of Object.entries(c.times)) {
      total += ms;
      if (kind === 'idle') idle += ms;
    }
  }
  const map = new Map();
  map.set('busy', total === 0 ? 0 : 1 - idle / total);
  map.set('load_1m', os.loadavg()[0]);
  map.set('free_ratio', os.totalmem() === 0 ? 0 : os.freemem() / os.totalmem());
  return map;
}

// ---------------------------------------------------------------------------
// Arena: a memory budget with spill and explicit reclamation
// ---------------------------------------------------------------------------
//
// Tensors held here count against a byte budget. Going over does not crash and
// does not silently lose data: the least recently used entries are written to
// disk and read back on demand.
//
// reclaim() is the honest answer to "deterministic garbage collection". You do
// not get a collector that never pauses -- nobody does. You get to choose the
// moment reclamation happens, and you get told exactly how long it took, in
// nanoseconds, measured rather than promised.

export class Arena {
  constructor(budgetBytes, spillDir = null) {
    this.budget = budgetBytes;
    this.spillDir = spillDir;
    this.entries = new Map();      // name -> { tensor|null, shape, bytes, file, clock }
    this.clock = 0;
    this.spilled = 0;
    this.restored = 0;
    this.lastReclaim = null;
  }
  get smarshType() { return 'arena'; }

  get resident() {
    let n = 0;
    for (const e of this.entries.values()) if (e.tensor) n += e.bytes;
    return n;
  }

  hold(name, tensor, line) {
    const bytes = tensor.data.length * 8;
    if (bytes > this.budget) {
      throw smarshError('MemoryError',
        `'${name}' needs ${bytes} bytes but the whole arena is ${this.budget}`, line);
    }
    this.entries.set(name, { tensor, shape: tensor.shape.slice(), bytes, file: null, clock: this.clock++ });
    this.evict(line);
    return tensor;
  }

  evict(line) {
    while (this.resident > this.budget) {
      let oldest = null;
      let oldestName = null;
      for (const [name, e] of this.entries) {
        if (!e.tensor) continue;
        if (!oldest || e.clock < oldest.clock) { oldest = e; oldestName = name; }
      }
      if (!oldest) return;
      if (!this.spillDir) {
        throw smarshError('MemoryError',
          `the arena is over its ${this.budget}-byte budget and has nowhere to spill; give it a spill directory or raise the budget`, line);
      }
      const file = path.join(this.spillDir, `${encodeURIComponent(oldestName)}.f64`);
      fs.writeFileSync(file, Buffer.from(oldest.tensor.data.buffer, oldest.tensor.data.byteOffset, oldest.bytes));
      oldest.file = file;
      oldest.tensor = null;
      this.spilled += 1;
    }
  }

  get(name, line) {
    const e = this.entries.get(name);
    if (!e) throw smarshError('NameError', `the arena is not holding '${name}'`, line);
    e.clock = this.clock++;
    if (e.tensor) return e.tensor;
    const buf = fs.readFileSync(e.file);
    const data = new Float64Array(buf.buffer, buf.byteOffset, e.bytes / 8);
    e.tensor = new Tensor(Float64Array.from(data), e.shape);
    this.restored += 1;
    this.evict(line);
    return e.tensor;
  }

  release(name) {
    const e = this.entries.get(name);
    if (!e) return false;
    if (e.file) { try { fs.unlinkSync(e.file); } catch { /* already gone */ } }
    this.entries.delete(name);
    return true;
  }

  // Explicit, measured reclamation.
  reclaim(keep) {
    const started = process.hrtime.bigint();
    let freedBytes = 0;
    let freedCount = 0;
    for (const [name, e] of [...this.entries]) {
      if (keep && keep.has(name)) continue;
      freedBytes += e.tensor ? e.bytes : 0;
      freedCount += 1;
      this.release(name);
    }
    const nanos = Number(process.hrtime.bigint() - started);
    this.lastReclaim = { count: freedCount, bytes: freedBytes, nanos };
    return this.lastReclaim;
  }

  toString() {
    return `<arena ${this.resident}/${this.budget} bytes, ${this.entries.size} held, ${this.spilled} spilled>`;
  }

  smarshMembers(interp) {
    return {
      budget: this.budget,
      resident: this.resident,
      held: this.entries.size,
      spilled: this.spilled,
      restored: this.restored,
      hold: nf('hold', 2, (a, line) =>
        this.hold(stringify(a[0], 0), interp.toTensor(a[1], line), line)),
      get: nf('get', 1, (a, line) => this.get(stringify(a[0], 0), line)),
      release: nf('release', 1, (a) => this.release(stringify(a[0], 0))),
      reclaim: nf('reclaim', -1, (a) => {
        const keep = a.length ? new Set((a[0] ?? []).map((x) => stringify(x, 0))) : null;
        const r = this.reclaim(keep);
        const m = new Map();
        m.set('released', r.count);
        m.set('bytes', r.bytes);
        m.set('nanos', r.nanos);
        return m;
      }),
    };
  }
}

// ---------------------------------------------------------------------------
// Weights: large immutable tensors that never fully load
// ---------------------------------------------------------------------------
//
// A weights file is opened, not read. Rows are pulled from disk on demand and
// kept in a small cache, so a file far larger than memory is usable as long as
// the working set is not. The tensor it hands back is an ordinary immutable
// Smarsh tensor.
//
// This is lazy paging, not mmap -- Node has no mmap without a native addon --
// and it is per-row, so it suits weight matrices and embedding tables rather
// than random scalar access.

const DTYPES = { f32: { size: 4, read: (b, o) => b.readFloatLE(o) }, f64: { size: 8, read: (b, o) => b.readDoubleLE(o) } };

export class Weights {
  constructor(file, shape, dtype, cacheRows = 64) {
    if (!DTYPES[dtype]) throw new Error(`unknown dtype '${dtype}'; known: ${Object.keys(DTYPES).join(', ')}`);
    if (shape.length !== 2) throw new Error('weights are a rank-2 table: [rows, columns]');
    this.file = file;
    this.shape = shape;
    this.dtype = dtype;
    this.itemSize = DTYPES[dtype].size;
    this.rowBytes = shape[1] * this.itemSize;
    this.cacheRows = cacheRows;
    this.cache = new Map();
    this.reads = 0;
    this.hits = 0;

    const stat = fs.statSync(file);
    const need = shape[0] * this.rowBytes;
    if (stat.size < need) {
      throw new Error(`${file} holds ${stat.size} bytes but [${shape.join(', ')}] of ${dtype} needs ${need}`);
    }
    this.fd = fs.openSync(file, 'r');
    this.bytes = need;
  }
  get smarshType() { return 'weights'; }

  row(i) {
    if (!Number.isInteger(i) || i < 0 || i >= this.shape[0]) {
      throw new Error(`row ${i} is outside [${this.shape.join(', ')}]`);
    }
    if (this.cache.has(i)) {
      this.hits += 1;
      const hit = this.cache.get(i);
      this.cache.delete(i);
      this.cache.set(i, hit);              // refresh recency
      return hit;
    }
    const buf = Buffer.allocUnsafe(this.rowBytes);
    fs.readSync(this.fd, buf, 0, this.rowBytes, i * this.rowBytes);
    const out = new Float64Array(this.shape[1]);
    const { read } = DTYPES[this.dtype];
    for (let j = 0; j < this.shape[1]; j++) out[j] = read(buf, j * this.itemSize);
    const tensor = new Tensor(out, [this.shape[1]]);
    this.cache.set(i, tensor);
    if (this.cache.size > this.cacheRows) this.cache.delete(this.cache.keys().next().value);
    this.reads += 1;
    return tensor;
  }

  close() {
    if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null; }
  }

  toString() {
    return `<weights ${path.basename(this.file)} [${this.shape.join(', ')}] ${this.dtype}, ${this.cache.size} rows resident>`;
  }

  smarshMembers() {
    return {
      shape: this.shape.slice(),
      dtype: this.dtype,
      bytes: this.bytes,
      resident: this.cache.size * this.rowBytes,
      reads: this.reads,
      hits: this.hits,
      row: nf('row', 1, (a, line) => {
        try {
          return this.row(Math.trunc(Number(a[0])));
        } catch (e) {
          throw smarshError('IndexError', e.message, line);
        }
      }),
      close: nf('close', 0, () => { this.close(); return true; }),
    };
  }
}
