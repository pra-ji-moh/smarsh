// Smarsh against CPython and V8, interleaved, reported as a ratio.
//
// Absolute timings on a shared machine are not comparable across minutes: the
// same unchanged code measured 531 ms one hour and 892 ms the next, purely
// because something else was running. Conclusions drawn from those numbers were
// not reliable, and one of them reached the README.
//
// So the reference implementations are measured in the same session, alternating
// with the subject, and the numbers that matter are ratios. If the machine gets
// busy, all three slow together and the ratio holds. It is also the number worth
// quoting: "6.7x CPython" survives being run on someone else's laptop in a way
// that "531 ms" does not.
//
//     node bench/compare.mjs [n] [samples]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const N = Number(process.argv[2] ?? 27);
const SAMPLES = Number(process.argv[3] ?? 5);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smarsh-bench-'));
const pyFile = path.join(dir, 'fib.py');
const jsFile = path.join(dir, 'fib.js');
fs.writeFileSync(pyFile, `import time
def fib(n): return n if n < 2 else fib(n-1) + fib(n-2)
t=time.perf_counter(); fib(${N}); print(round((time.perf_counter()-t)*1000,2))
`);
fs.writeFileSync(jsFile, `function fib(n){return n<2?n:fib(n-1)+fib(n-2)}
const t=process.hrtime.bigint();fib(${N});console.log(Number(process.hrtime.bigint()-t)/1e6);
`);

function sample(cmd, args) {
  try {
    const n = Number(execFileSync(cmd, args, { encoding: 'utf8' }).trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// One process per sample, and the three alternate, so a machine that gets busy
// partway through affects all of them rather than whichever ran last.
const runs = { smarsh: [], cpython: [], node: [] };
for (let i = 0; i < SAMPLES; i++) {
  runs.smarsh.push(sample(process.execPath, [path.join(here, 'workload.mjs'), 'recursion', '5']));
  runs.cpython.push(sample('python', [pyFile]));
  runs.node.push(sample(process.execPath, [jsFile]));
}
fs.rmSync(dir, { recursive: true, force: true });

const best = (xs) => {
  const ok = xs.filter((x) => typeof x === 'number');
  return ok.length ? Math.min(...ok) : null;
};

const p = best(runs.smarsh);
const c = best(runs.cpython);
const n = best(runs.node);
const row = (name, ms) => '  ' + name.padEnd(18)
  + (ms === null ? '   not available' : ms.toFixed(0).padStart(7) + ' ms');

console.log('fib(' + N + '), best of ' + SAMPLES + ', one process per sample');
console.log('');
console.log(row('Smarsh', p));
console.log(row('CPython', c));
console.log(row('Node (V8 JIT)', n));
console.log('');
if (p && c) console.log('  Smarsh / CPython   ' + (p / c).toFixed(2) + 'x');
if (p && n) console.log('  Smarsh / Node      ' + (p / n).toFixed(0) + 'x');
console.log('');
console.log('  The ratios are the durable numbers. Absolute milliseconds move by');
console.log('  a factor of two on this machine depending on what else is running.');
