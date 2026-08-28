import { Interpreter } from '../src/interpreter.js';

// Benchmarks that stress the interpreter's hot paths, not the builtins:
// name lookup, call overhead, member access, arithmetic dispatch.
//
// Numbers here are printed as they come out. A benchmark that is tuned until it
// says something flattering is worth less than no benchmark at all.

const BENCHMARKS = {
  'fib(24) — call overhead': `
    fn fib(n) { if n < 2 { return n } return fib(n - 1) + fib(n - 2) }
    fib(24)
  `,

  'loop 300k — variable lookup': `
    var total = 0
    for i in range(300000) { total = total + i }
    total
  `,

  'nested scopes — chain walking': `
    fn outer(n) {
      var acc = 0
      var i = 0
      while i < n {
        if true {
          if true { acc = acc + i }
        }
        i = i + 1
      }
      return acc
    }
    outer(60000)
  `,

  'list methods — member access': `
    var xs = []
    for i in range(60000) { xs.push(i) }
    xs.len()
  `,

  'string building — member access': `
    var n = 0
    for i in range(40000) { n = n + "abcdef".upper().len() }
    n
  `,

  'field access — map reads': `
    let m = { "a": 1, "b": 2, "c": 3 }
    var total = 0
    for i in range(100000) { total = total + m["a"] + m["b"] + m["c"] }
    total
  `,
};

function time(source) {
  const interp = new Interpreter({ out: () => {} });
  try {
    const started = process.hrtime.bigint();
    interp.run(source, '<bench>');
    return Number(process.hrtime.bigint() - started) / 1e6;
  } finally {
    interp.devices.shutdown();
  }
}

const label = process.argv[2] ?? 'current';
console.log(`Smarsh benchmarks (${label}) — node ${process.version}\n`);

const results = {};
for (const [name, source] of Object.entries(BENCHMARKS)) {
  time(source);                                   // warm the JIT
  const runs = [time(source), time(source), time(source)];
  const best = Math.min(...runs);
  results[name] = best;
  console.log(`  ${name.padEnd(38)} ${best.toFixed(1).padStart(9)} ms`);
}

const total = Object.values(results).reduce((a, b) => a + b, 0);
console.log(`  ${'total'.padEnd(38)} ${total.toFixed(1).padStart(9)} ms`);

if (process.env.smarsh_BENCH_JSON) {
  console.log(`\n${JSON.stringify(results)}`);
}
