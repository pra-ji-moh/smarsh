import { workerData } from 'node:worker_threads';

// One slice of a matrix multiply, run on its own thread.
//
// Coordination is entirely through SharedArrayBuffers and Atomics: no
// postMessage, no serialization, no async. The main thread bumps a generation
// counter and blocks; each worker wakes, computes the rows it owns, decrements
// a completion count and goes back to sleep.
//
// Every worker writes a disjoint range of output rows. Two workers can never
// touch the same cell, which is the ownership rule that makes the slicing safe
// by construction rather than by locking.

const GEN = 0;        // control[0] -- bumped to release the workers
const REMAINING = 1;  // control[1] -- counts workers still busy
const M = 2;
const K = 3;
const N = 4;
const OFF_A = 5;
const OFF_B = 6;
const OFF_C = 7;

const control = new Int32Array(workerData.control);
const data = new Float64Array(workerData.data);
const { index, workers } = workerData;

// Start from 0, not from whatever the counter reads right now. A worker that
// finishes booting after the main thread has already published a job would
// otherwise take the new value as its baseline, wait for the job after this
// one, and never do the work it was spawned for -- while the main thread waits
// forever for its slice.
let seen = 0;

for (;;) {
  let gen = Atomics.load(control, GEN);
  if (gen === seen) {
    Atomics.wait(control, GEN, seen);
    gen = Atomics.load(control, GEN);
  }
  if (gen === -1) break;            // shutdown
  seen = gen;

  const m = Atomics.load(control, M);
  const k = Atomics.load(control, K);
  const n = Atomics.load(control, N);
  const offA = Atomics.load(control, OFF_A);
  const offB = Atomics.load(control, OFF_B);
  const offC = Atomics.load(control, OFF_C);

  // This worker's rows: a contiguous, exclusive band of the output.
  const per = Math.ceil(m / workers);
  const start = Math.min(index * per, m);
  const end = Math.min(start + per, m);

  for (let i = start; i < end; i++) {
    const rowC = offC + i * n;
    for (let j = 0; j < n; j++) data[rowC + j] = 0;
    for (let p = 0; p < k; p++) {
      const av = data[offA + i * k + p];
      if (av === 0) continue;
      const rowB = offB + p * n;
      for (let j = 0; j < n; j++) data[rowC + j] += av * data[rowB + j];
    }
  }

  Atomics.sub(control, REMAINING, 1);
  Atomics.notify(control, REMAINING);
}
