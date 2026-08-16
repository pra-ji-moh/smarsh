// Run every program twice -- once on the tree-walker, once compiled -- and
// require the two to be indistinguishable.
//
// The tree-walker is the specification. Closure compilation is only allowed to
// change how fast a program runs, never what it prints, what it fails with, or
// what its audit trail says. That is not a nice-to-have: `pedag audit` signs a
// manifest that claims a run is reproducible from its seed, and an engine that
// quietly diverges would make that claim false.
//
// So the comparison is deliberately strict. Same stdout, byte for byte. Same
// error kind, message and line. Same step count, same call count, same branch
// decisions, same trace of capabilities used and refused.
//
//     node tools/differential.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Interpreter } from '../src/interpreter.js';
import { PedagError, BudgetExceeded } from '../src/errors.js';
import { Rng } from '../src/rng.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Everything observable about a run, so a divergence anywhere is caught rather
// than only a divergence in what got printed.
function observe(source, file, { caps = [], principals = [], seed = 7 }, compiled) {
  const out = [];
  const interp = new Interpreter({
    out: (s) => out.push(s),
    caps,
    principals,
    seed,
    cwd: path.dirname(file),
  });
  interp.compiled = compiled;
  interp.entryPath = file;
  interp.stepLimit = 2_000_000;

  let failure = null;
  let result;
  try {
    result = interp.run(source, path.basename(file));
  } catch (e) {
    failure = e instanceof PedagError
      ? `${e.kind}: ${e.message} @${e.line}`
      : e instanceof BudgetExceeded
        ? `BudgetExceeded: ${e.budget.kind}`
        : `LEAK ${e && e.constructor && e.constructor.name}: ${e && e.message}`;
  }

  const t = interp.trace;
  const snapshot = {
    stdout: out.join('\n'),
    failure,
    result: safe(result),
    steps: interp.steps,
    calls: t.calls,
    contracts: t.contracts,
    forks: t.forks,
    branches: t.branches.length,
    effects: t.effects.map((e) => `${e.capability}/${e.by}/${e.allowed}`).join(','),
    crossings: t.crossings.map((c) => `${c.kind}/${c.to}/${c.allowed}`).join(','),
    declassifications: t.declassifications.length,
    laundered: t.laundered.length,
    allocated: interp.allocated,
    logicalTime: interp.logicalTime,
  };
  try { interp.devices.shutdown(); } catch { /* already down */ }
  return snapshot;
}

function safe(v) {
  try {
    if (v === null || v === undefined) return String(v);
    if (typeof v === 'object') return JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? String(x) : x));
    return String(v);
  } catch {
    return '(unserialisable)';
  }
}

// Some programs are not reproducible against *themselves* -- they read the
// machine's free memory, or consume real entropy. Comparing two engines on such
// a program says nothing about the engines. So the tree-walker is run twice
// first: any field that already differs from itself is environmental, and is
// reported separately rather than blamed on the compiler.
//
// That separation is worth having on its own. A language that signs a manifest
// claiming a run replays from its seed should know exactly which of its own
// examples do not.
function compare(name, source, file, opts) {
  let tree;
  let treeAgain;
  let comp;
  try {
    tree = observe(source, file, opts, false);
    treeAgain = observe(source, file, opts, false);
  } catch (e) {
    return { diffs: [`${name}: the tree-walker itself threw outside the harness: ${e.message}`], env: [] };
  }
  try {
    comp = observe(source, file, opts, true);
  } catch (e) {
    return { diffs: [`${name}: the compiled engine threw outside the harness: ${e.message}`], env: [] };
  }

  const diffs = [];
  const env = [];
  for (const key of Object.keys(tree)) {
    if (tree[key] !== treeAgain[key]) {
      env.push(`${name}  ${key}  (differs from itself, so not an engine difference)`);
      continue;
    }
    if (tree[key] === comp[key]) continue;
    diffs.push(`${name}  ${key}\n      tree:     ${trim(String(tree[key]))}\n      compiled: ${trim(String(comp[key]))}`);
  }
  return { diffs, env };
}

const trim = (s) => (s.length > 300 ? `${s.slice(0, 300)}...` : s).split('\n').join('\\n');

// --- the corpus --------------------------------------------------------------

const cases = [];

// Every example, with the capabilities its own header documents.
const exDir = path.join(root, 'examples');
const INVOCATION = /^\/\/\s*(?:node\s+bin\/pedag\.mjs|pedag)\s+run\s+\S+(.*)$/;
for (const name of fs.readdirSync(exDir).filter((f) => f.endsWith('.pedag')).sort()) {
  const file = path.join(exDir, name);
  const source = fs.readFileSync(file, 'utf8');
  const caps = [];
  const principals = [];
  for (const raw of source.split(/\r?\n/).slice(0, 12)) {
    const line = raw.trim();
    if (!line.startsWith('//')) continue;
    const m = INVOCATION.exec(line);
    if (!m) continue;
    const flags = m[1].split(/\s+/);
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === '--grant') caps.push(...(flags[++i] ?? '').split(','));
      if (flags[i] === '--principal') principals.push(...(flags[++i] ?? '').split(','));
    }
  }
  cases.push({ name: `examples/${name}`, source, file, opts: { caps, principals, seed: 7 } });
}

// The standard library's own tests, which exercise paths the examples do not.
const stdDir = path.join(root, 'std');
for (const name of fs.readdirSync(stdDir).filter((f) => f.endsWith('.pedag')).sort()) {
  const file = path.join(stdDir, name);
  cases.push({
    name: `std/${name}`,
    source: fs.readFileSync(file, 'utf8'),
    file,
    opts: { caps: [], principals: [], seed: 7 },
  });
}

// Hand-written cases aimed squarely at the places the two engines could differ:
// the completion protocol, scoping, and control flow that does not reach a loop.
const TARGETED = [
  ['return value', 'fn f() { return 41 + 1 }\nprint(f())'],
  ['bare return', 'fn f() { return }\nprint(f())'],
  ['implicit nil', 'fn f() { 1 + 1 }\nprint(f())'],
  ['return from a loop', 'fn f() { for i in range(9) { if i == 3 { return i } } return -1 }\nprint(f())'],
  ['return from a while', 'fn f() { var n = 0\n while true { n = n + 1\n if n > 4 { return n } } }\nprint(f())'],
  ['return through nesting', 'fn f() { for i in range(3) { for j in range(3) { if j == 1 { return i * 10 + j } } } }\nprint(f())'],
  ['break', 'var n = 0\nfor i in range(9) { if i == 4 { break }\n n = n + 1 }\nprint(n)'],
  ['continue', 'var n = 0\nfor i in range(9) { if i % 2 == 0 { continue }\n n = n + i }\nprint(n)'],
  ['break in while', 'var n = 0\nwhile true { n = n + 1\n if n > 3 { break } }\nprint(n)'],
  ['continue in while', 'var i = 0\nvar n = 0\nwhile i < 9 { i = i + 1\n if i % 2 == 0 { continue }\n n = n + i }\nprint(n)'],
  ['break with no loop', 'break'],
  ['return at top level', 'return 1'],
  ['break inside a function', 'fn f() { break }\nf()'],
  ['break out of atomic', 'var n = 0\nfor i in range(5) { atomic { n = n + 1 }\n if i == 2 { break } }\nprint(n)'],
  ['closures capture per iteration', 'var fs = []\nfor i in range(3) { fs.push(fn() { return i }) }\nprint(fs[0]())\nprint(fs[2]())'],
  ['closures in while', 'var fs = []\nvar i = 0\nwhile i < 3 { let j = i\n fs.push(fn() { return j })\n i = i + 1 }\nprint(fs[0]())'],
  ['block scoping', 'let x = 1\n{ let x = 2\n print(x) }\nprint(x)'],
  ['shadowing in a loop', 'for i in range(3) { let x = i * 2\n print(x) }'],
  ['recursion', 'fn fib(n) { if n < 2 { return n } return fib(n-1) + fib(n-2) }\nprint(fib(15))'],
  ['mutual recursion', 'fn even(n) { if n == 0 { return true } return odd(n-1) }\nfn odd(n) { if n == 0 { return false } return even(n-1) }\nprint(even(10))'],
  ['deep recursion fails the same way', 'fn f(n) { return f(n+1) }\nf(0)'],
  ['contracts hold', 'fn g(x) requires x >= 0 ensures result > x { return x + 1 }\nprint(g(3))'],
  ['contracts fail', 'fn g(x) requires x >= 0 { return x }\nprint(g(0 - 1))'],
  ['loop invariants', 'var n = 0\nwhile n < 5 invariant n >= 0 variant 5 - n { n = n + 1 }\nprint(n)'],
  ['step budget', 'budget steps 200 { var n = 0\n while true { n = n + 1 } }'],
  ['memory budget', 'budget memory 4000 { var xs = []\n while true { xs.push(1) } }'],
  ['taint propagates', 'let u = untrusted("x")\nprint(labels(u))\ngrounded { print(u) }'],
  ['arithmetic errors', 'print(1 / 0)'],
  ['index errors', 'let a = [1]\nprint(a[9])'],
  ['name errors', 'print(nope)'],
  ['type errors', 'print(1 + "a")'],
  ['decimals stay exact', 'let a = dec("0.1")\nlet b = dec("0.2")\nprint(a + b)'],
  ['string interpolation', 'let a = 2\nprint("v=${a} w=${a * 3}")'],
  ['match', 'record P(x, y)\nlet p = P(1, 2)\nprint(match p { P(a, b) => a + b, _ => 0 })'],
  ['attempt rescue', 'attempt { 1 / 0 } rescue e { print(e["kind"]) }'],
  ['attempt with return', 'fn f() { attempt { return 5 } rescue e { return -1 } }\nprint(f())'],
  ['nested functions', 'fn outer() { fn inner() { return 7 }\n return inner() + 1 }\nprint(outer())'],
  ['higher order', 'let a = [1,2,3]\nprint(a.map(fn(x) { return x * 2 }))'],
  ['fold with early return', 'fn f(a) { for x in a { if x > 2 { return x } } return 0 }\nprint(f([1,2,3,4]))'],
  ['agents', 'agent A(k) { on go(n) { return k + n } }\nlet a = spawn A(10)\nsend(a, "go", 5)\nprint(run_agents())'],
  ['fork', 'let r = fork 3 { _ * 2 }\nprint(r)'],
  ['maybe is seeded', 'maybe 0.5 { print("a") } else { print("b") }'],
  ['tensors', 'let t = tensor [[1,2],[3,4]]\nprint(t @ t)'],
  ['records with invariants', 'record C(v) invariant v >= 0\nprint(C(3))'],
  ['record invariant fails', 'record C(v) invariant v >= 0\nprint(C(0 - 1))'],
];
for (const [name, source] of TARGETED) {
  cases.push({
    name: `case: ${name}`,
    source,
    file: path.join(root, 'diff.pedag'),
    opts: { caps: [], principals: [], seed: 7 },
  });
}

// Generated programs, so the corpus is not limited to what was thought of.
// Reuses the fuzzer's fragments: anything it can build, both engines must agree
// on -- including the programs that fail.
const FRAGMENTS = [
  'let a = [1, 2, 3]', 'var b = { "k": 1 }', 'fn f(x) { return x }',
  'record P(u, v)', 'var n = 0', 'print(a)', 'a.push(9)', 'b.set("j", 2)',
  'print(a.map(fn(x) { return x * 2 }))', 'print(a.fold(0, fn(s, x) { return s + x }))',
  'for i in range(3) { print(i) }', 'while n < 3 { n = n + 1 }',
  'if true { print(1) } else { print(2) }', 'match 1 { 1 => "a", _ => "b" }',
  'attempt { 1 / 0 } rescue e { print(e["kind"]) }', 'break', 'continue', 'return 1',
  'atomic { n = n + 1 }', 'grounded { print(1) }', 'region "eu" { print(1) }',
  'budget steps 500 { print(1) }', 'print(f(2))', 'let p = P(1, 2)',
  'fn g(x) requires x >= 0 { return x + 1 }', 'print(g(1))', 'print(1 / 0)',
  'print(a[9])', 'fork 2 { _ }', 'print("${a}")',
];
for (let seed = 0; seed < 3000; seed++) {
  const rng = new Rng(seed ^ 0xd1ff);
  const n = 2 + Math.floor(rng.next() * 8);
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(FRAGMENTS[Math.floor(rng.next() * FRAGMENTS.length)]);
  cases.push({
    name: `generated seed ${seed}`,
    source: lines.join('\n'),
    file: path.join(root, 'diff.pedag'),
    opts: { caps: [], principals: [], seed: 7 },
  });
}

// --- run ---------------------------------------------------------------------

const failures = [];
const environmental = [];
for (const c of cases) {
  const { diffs, env } = compare(c.name, c.source, c.file, c.opts);
  if (diffs.length) failures.push(...diffs.map((d) => `${d}\n      source: ${JSON.stringify(c.source.slice(0, 200))}`));
  environmental.push(...env);
}

console.log(`${cases.length} programs run on both engines`);

if (environmental.length) {
  console.log(`\n${environmental.length} field(s) not reproducible against the same engine — environmental, not the compiler:`);
  for (const e of [...new Set(environmental)]) console.log(`  ${e}`);
}

if (failures.length === 0) {
  console.log('\nthe compiled engine is indistinguishable from the tree-walker');
} else {
  console.log(`\n${failures.length} engine divergences:\n`);
  for (const f of failures.slice(0, 25)) console.log(`  ${f}\n`);
  if (failures.length > 25) console.log(`  ...and ${failures.length - 25} more`);
}
process.exitCode = failures.length === 0 ? 0 : 1;
