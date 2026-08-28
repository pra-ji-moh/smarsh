// A/B a performance change against the committed baseline, honestly.
//
// This exists because several measurements in one session were wrong, and one
// of them reached the README.
//
//   Timings inside one long-lived process climbed run over run -- 644 ms to
//   1029 ms across seven iterations of identical code -- because each run left
//   heap state the next one paid for.
//
//   Timings in fresh processes were stable within a minute and useless across
//   ten: the same unchanged code measured 531 ms and later 1202 ms, purely
//   because the machine got busy. Read that way, a 19% improvement looked like
//   a 63% regression.
//
//   Normalising against CPython in the same session helped, but CPython's own
//   samples moved 212 to 247 ms, so at four samples the ratio was still noise.
//
// What survives all of it: run both versions in one session, alternating, with
// enough samples to take a median. And run every shape, not one -- reusing a
// scope across loop passes made a declaring loop twice as fast and did nothing
// for recursion, so a fib-only harness would have missed it, and a loop-only
// harness would have let a regression into the call path go unnoticed.
//
//     node tools/ab.mjs [samples] [scale] [only-this-workload]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES = Number(process.argv[2] ?? 7);
const SCALE = Number(process.argv[3] ?? 1);
const ONLY = process.argv[4];

const WORKLOADS = [
  'recursion', 'calls', 'loop-plain', 'loop-declare', 'while-loop',
  'closures', 'contracts', 'records', 'strings', 'maps', 'lists',
];

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

const dirty = git('status', '--porcelain').trim().length > 0;
if (!dirty) {
  console.log('the working copy matches HEAD, so there is nothing to compare');
  process.exit(0);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'smarsh-ab-'));
const baseDir = path.join(work, 'base');
const candDir = path.join(work, 'cand');
const copy = (into) => {
  fs.cpSync(path.join(ROOT, 'src'), path.join(into, 'src'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'bench'), path.join(into, 'bench'), { recursive: true });
};

// The working copy is the candidate; HEAD is the baseline. Both are copied out
// first, so neither is being edited while the other is measured.
copy(candDir);
git('stash', '-q');
try {
  copy(baseDir);
} finally {
  git('stash', 'pop', '-q');
}

function sample(dir, workload) {
  try {
    const n = Number(execFileSync(process.execPath,
      [path.join(dir, 'bench', 'workload.mjs'), workload, String(SCALE)],
      { encoding: 'utf8' }).trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

const list = ONLY ? WORKLOADS.filter((w) => w === ONLY) : WORKLOADS;
const results = [];
for (const w of list) {
  const base = [];
  const cand = [];
  // Alternating, so a machine that gets busy partway through hits both sides.
  for (let i = 0; i < SAMPLES; i++) {
    const b = sample(baseDir, w);
    if (b !== null) base.push(b);
    const c = sample(candDir, w);
    if (c !== null) cand.push(c);
  }
  results.push({ w, base, cand });
}
fs.rmSync(work, { recursive: true, force: true });

const median = (xs) => {
  const t = [...xs].sort((a, b) => a - b);
  return t.length % 2 ? t[(t.length - 1) / 2] : (t[t.length / 2 - 1] + t[t.length / 2]) / 2;
};
const pct = (a, b) => (b / a * 100 - 100);
const show = (n) => (n < 0 ? '' : '+') + n.toFixed(1) + '%';

console.log(`${SAMPLES} interleaved samples per side, scale ${SCALE}`);
console.log('');
console.log('  workload         base med   cand med    median      min');
console.log(`  ${'-'.repeat(56)}`);

let sumBase = 0;
let sumCand = 0;
for (const { w, base, cand } of results) {
  if (base.length < 3 || cand.length < 3) {
    console.log(`  ${w.padEnd(16)}not enough samples completed`);
    continue;
  }
  const mb = median(base);
  const mc = median(cand);
  sumBase += mb;
  sumCand += mc;
  console.log(`  ${w.padEnd(16)}${`${mb.toFixed(0)}ms`.padStart(8)}`
    + `${`${mc.toFixed(0)}ms`.padStart(11)}`
    + `${show(pct(mb, mc)).padStart(10)}`
    + `${show(pct(Math.min(...base), Math.min(...cand))).padStart(9)}`);
}
console.log(`  ${'-'.repeat(56)}`);
console.log(`  ${'total'.padEnd(16)}${`${sumBase.toFixed(0)}ms`.padStart(8)}`
  + `${`${sumCand.toFixed(0)}ms`.padStart(11)}`
  + `${show(pct(sumBase, sumCand)).padStart(10)}`);
console.log('');
console.log('  Negative is faster. Trust this over any single-process timing,');
console.log('  and do not compare numbers taken minutes apart.');
