// A/B a performance change against the committed baseline, honestly.
//
// This exists because three separate measurements in one session were wrong,
// and one of them reached the README.
//
//   Timings inside one long-lived process climbed run over run -- 644 ms to
//   1029 ms across seven iterations of the same code -- because each run left
//   heap state the next one paid for.
//
//   Timings in fresh processes were stable within a minute and useless across
//   ten: the same unchanged code measured 531 ms and later 1202 ms, purely
//   because the machine got busy.
//
//   Normalising against CPython in the same session helped, but CPython's own
//   samples moved 212 to 247 ms, so at four samples the ratio was still noise.
//
// What survives all three problems is running both versions in one session,
// alternating, with enough samples to take a median. That is what this does: it
// builds a tree from HEAD and a tree from the working copy, then interleaves.
//
//     node tools/ab.mjs [samples] [n]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES = Number(process.argv[2] ?? 15);
const N = Number(process.argv[3] ?? 27);

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pedag-ab-'));
const baseDir = path.join(work, 'base');
const candDir = path.join(work, 'cand');

// The working copy is the candidate; HEAD is the baseline. Both are copied out
// so that neither is edited while the other is being measured.
fs.cpSync(path.join(ROOT, 'src'), path.join(candDir, 'src'), { recursive: true });
fs.cpSync(path.join(ROOT, 'bench'), path.join(candDir, 'bench'), { recursive: true });

const dirty = git('status', '--porcelain').trim().length > 0;
if (dirty) git('stash', '-q');
try {
  fs.cpSync(path.join(ROOT, 'src'), path.join(baseDir, 'src'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'bench'), path.join(baseDir, 'bench'), { recursive: true });
} finally {
  if (dirty) git('stash', 'pop', '-q');
}

if (!dirty) {
  console.log('the working copy matches HEAD, so there is nothing to compare');
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(0);
}

function sample(dir) {
  try {
    const n = Number(execFileSync(process.execPath,
      [path.join(dir, 'bench', 'fib.mjs'), String(N)], { encoding: 'utf8' }).trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

const base = [];
const cand = [];
for (let i = 0; i < SAMPLES; i++) {
  const b = sample(baseDir);
  if (b !== null) base.push(b);
  const c = sample(candDir);
  if (c !== null) cand.push(c);
}
fs.rmSync(work, { recursive: true, force: true });

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

if (base.length < 3 || cand.length < 3) {
  console.log('not enough samples completed to say anything');
  process.exit(1);
}

const mb = median(base);
const mc = median(cand);
const lb = Math.min(...base);
const lc = Math.min(...cand);

const line = (name, xs) => '  ' + name.padEnd(11) + 'n=' + String(xs.length).padStart(2)
  + '  min=' + Math.min(...xs).toFixed(0).padStart(5)
  + '  median=' + median(xs).toFixed(0).padStart(5) + ' ms';

console.log('fib(' + N + '), ' + SAMPLES + ' interleaved samples per side');
console.log('');
console.log(line('baseline', base));
console.log(line('candidate', cand));
console.log('');
const pct = (a, b) => (b / a * 100 - 100).toFixed(1);
console.log('  median   ' + (mc < mb ? '' : '+') + pct(mb, mc) + '%');
console.log('  min      ' + (lc < lb ? '' : '+') + pct(lb, lc) + '%');
console.log('');
console.log('  Negative is faster. Trust this over any single-process timing,');
console.log('  and do not compare numbers taken minutes apart.');
