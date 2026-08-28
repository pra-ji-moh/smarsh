// Both engines, several workloads, measured in-process.
//
// Timing whole CLI invocations mostly measures Node starting up, which is about
// 200ms and has nothing to do with the language. These numbers are the run
// itself, after a warm-up pass so the JIT has seen the code, and the best of
// several repeats rather than the mean -- the minimum is the least noisy
// statistic on a machine doing other things.
//
//     node tools/bench.mjs

import { Interpreter } from '../src/interpreter.js';

const WORKLOADS = [
  ['recursion  fib(27)', 'fn fib(n) { if n < 2 { return n } return fib(n-1) + fib(n-2) }\nfib(27)'],
  ['tight loop  2M adds', 'var t = 0\nfor i in range(2000000) { t = t + i }\nt'],
  ['while loop  1M', 'var i = 0\nvar t = 0\nwhile i < 1000000 { t = t + i\n i = i + 1 }\nt'],
  ['calls  500k', 'fn add(a, b) { return a + b }\nvar t = 0\nfor i in range(500000) { t = add(t, i) }\nt'],
  ['list build  200k', 'var xs = []\nfor i in range(200000) { xs.push(i) }\nxs.len()'],
  ['string concat  50k', 'var s = ""\nfor i in range(50000) { s = s + "x" }\ns.len()'],
  ['map writes  200k', 'var m = { }\nfor i in range(200000) { m.set(str(i % 1000), i) }\nm.len()'],
  ['field access  500k', 'record P(x, y)\nlet p = P(1, 2)\nvar t = 0\nfor i in range(500000) { t = t + p.x }\nt'],
  ['closures  200k', 'let f = fn(x) { return x + 1 }\nvar t = 0\nfor i in range(200000) { t = f(t) }\nt'],
  ['contracts  200k', 'fn g(x) requires x >= 0 ensures result >= x { return x + 1 }\nvar t = 0\nfor i in range(200000) { t = g(t) }\nt'],
];

const REPEATS = 3;

function time(source, compiled) {
  let best = Infinity;
  for (let r = 0; r < REPEATS + 1; r++) {
    const interp = new Interpreter({ out: () => {}, seed: 1 });
    interp.compiled = compiled;
    interp.stepLimit = Infinity;
    const t0 = process.hrtime.bigint();
    try {
      interp.run(source, 'bench.smarsh');
    } catch (e) {
      interp.devices.shutdown();
      return { failed: `${e && e.kind ? e.kind : 'error'}: ${e && e.message}` };
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    interp.devices.shutdown();
    if (r > 0 && ms < best) best = ms;   // r === 0 is the warm-up
  }
  return { ms: best };
}

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

console.log(`${pad('workload', 24)}${num('tree', 11)}${num('compiled', 11)}${num('speedup', 10)}`);
console.log('-'.repeat(56));

let totalTree = 0;
let totalComp = 0;
for (const [name, source] of WORKLOADS) {
  const tree = time(source, false);
  const comp = time(source, true);
  if (tree.failed || comp.failed) {
    console.log(`${pad(name, 24)}   ${tree.failed ?? comp.failed}`);
    continue;
  }
  totalTree += tree.ms;
  totalComp += comp.ms;
  const speedup = tree.ms / comp.ms;
  console.log(`${pad(name, 24)}${num(tree.ms.toFixed(0) + 'ms', 11)}${num(comp.ms.toFixed(0) + 'ms', 11)}${num(speedup.toFixed(2) + 'x', 10)}`);
}

console.log('-'.repeat(56));
console.log(`${pad('total', 24)}${num(totalTree.toFixed(0) + 'ms', 11)}${num(totalComp.toFixed(0) + 'ms', 11)}${num((totalTree / totalComp).toFixed(2) + 'x', 10)}`);
