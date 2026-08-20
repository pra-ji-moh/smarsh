// One workload, one process, one number in milliseconds.
//
//     node bench/workload.mjs <name> [scale]
//
// Separate shapes, because an optimisation that helps one can cost another and
// a single benchmark hides that. Reusing a scope across loop passes made a
// declaring loop twice as fast and did nothing for recursion; measuring only
// fib would have missed it entirely, and measuring only the loop would have let
// a regression into the call path unnoticed.
import { Interpreter } from '../src/interpreter.js';

export const WORKLOADS = {
  recursion: (s) => `fn fib(n) { if n < 2 { return n } return fib(n-1) + fib(n-2) }
fib(${22 + s})`,
  calls: (s) => `fn add(a, b) { return a + b }
var t = 0
for i in range(${200000 * s}) { t = add(t, i) }
t`,
  'loop-plain': (s) => `var t = 0
var g = 5
for i in range(${300000 * s}) { t = t + g + i }
t`,
  'loop-declare': (s) => `var t = 0
var g = 5
for i in range(${300000 * s}) { let d = g + i
 t = t + d }
t`,
  'while-loop': (s) => `var i = 0
var t = 0
while i < ${300000 * s} { t = t + i
 i = i + 1 }
t`,
  closures: (s) => `let f = fn(x) { return x + 1 }
var t = 0
for i in range(${150000 * s}) { t = f(t) }
t`,
  contracts: (s) => `fn g(x) requires x >= 0 ensures result >= x { return x + 1 }
var t = 0
for i in range(${100000 * s}) { t = g(t) }
t`,
  records: (s) => `record P(x, y)
var t = 0
for i in range(${150000 * s}) { let p = P(i, 2)
 t = t + p.x }
t`,
  strings: (s) => `var out = []
for i in range(${40000 * s}) { out.push("row " + str(i)) }
out.len()`,
  maps: (s) => `var m = { }
for i in range(${100000 * s}) { m.set(str(i % 997), i) }
m.len()`,
  lists: (s) => `var xs = []
for i in range(${200000 * s}) { xs.push(i) }
xs.len()`,
};

const name = process.argv[2];
if (!name) {
  console.error('usage: node bench/workload.mjs <' + Object.keys(WORKLOADS).join('|') + '> [scale]');
  process.exit(2);
}
const make = WORKLOADS[name];
if (!make) {
  console.error(`no workload called ${name}`);
  process.exit(2);
}

const scale = Number(process.argv[3] ?? 1);
const interp = new Interpreter({ out: () => {}, seed: 1 });
interp.stepLimit = Infinity;
const source = make(scale);
const t = process.hrtime.bigint();
interp.run(source, 'bench.pedag');
console.log(Number(process.hrtime.bigint() - t) / 1e6);
interp.devices.shutdown();
