// The numbers the README states about itself, checked against the repository.
//
//     node tools/readme-stats.mjs           # report, and fail if the README is wrong
//     node tools/readme-stats.mjs --write   # bring the README up to date
//
// Three numbers had drifted, one of them by a factor of four: the README said
// "151 tests across 4 files" long after there were hundreds across thirty. A
// prose number nobody can check is a number that will be wrong, and a README
// that is wrong about something this easy to verify is not trusted about
// anything harder.
//
// The coverage figure needs one piece of care. Running the suite generates
// bundles -- `pedag build` writes a self-contained .mjs into a temp directory --
// and Node's coverage counts those as source. They are ten thousand lines each
// at 40% covered, and including them reports 63% for a tree that is at 95%.
// Excluding them is not massaging the number; a generated artifact is not
// source, and the claim is about `src/`.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const README = path.join(ROOT, 'README.md');
const WRITE = process.argv.includes('--write');

const EXCLUDE = [
  '**/tests/**', '**/bin/**', '**/tools/**',
  '**/app.mjs', '**/bad.mjs',        // bundles the suite generates as it runs
];

function measure() {
  const files = fs.readdirSync(path.join(ROOT, 'tests'))
    .filter((f) => f.endsWith('.test.mjs'))
    .map((f) => `tests/${f}`);

  let output;
  try {
    output = execFileSync(process.execPath, [
      '--test', '--experimental-test-coverage',
      ...EXCLUDE.flatMap((p) => [`--test-coverage-exclude=${p}`]),
      ...files,
    ], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    // A failing suite still prints its summary, and the counts are what we want.
    output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }

  const pass = Number(/^\D*pass (\d+)$/m.exec(output)?.[1] ?? NaN);
  const fail = Number(/^\D*fail (\d+)$/m.exec(output)?.[1] ?? NaN);
  const lines = Number(/^\D*all files\s*\|\s*([\d.]+)/m.exec(output)?.[1] ?? NaN);

  if (!Number.isFinite(pass) || !Number.isFinite(lines)) {
    throw new Error('could not read the suite summary; the reporter format may have changed');
  }
  if (fail > 0) {
    // Name them. This tool runs the suite under coverage, which is slower than
    // a plain run and has surfaced a failure once that did not reproduce -- a
    // bare count made that undiagnosable after the fact.
    const named = [...output.matchAll(/^\s*✖ (.+?) \(/gm)].map((m) => m[1]);
    const detail = named.length ? `:\n  ${named.join('\n  ')}` : '';
    throw new Error(
      `${fail} test(s) failing under coverage -- fix those before quoting a number${detail}`);
  }

  return { tests: pass, files: files.length, coverage: Math.floor(lines) };
}

// The row in the layout table, whose padding has to survive the rewrite.
function layoutLine(source, m) {
  const row = /^(tests\/\s+)\d+ tests across \d+ files$/m.exec(source);
  if (!row) return null;
  return { from: row[0], to: `${row[1]}${m.tests} tests across ${m.files} files` };
}

// The same drift, one level up. The layout table had fallen a third of `src/`
// behind -- and a missing file is worse than a stale count, because a reader
// concludes the module does not exist. This cannot be auto-fixed: a new file
// needs a line of prose saying what it is for, and only the person who added it
// knows that.
function layoutGaps(source) {
  const table = /## Layout\n+```\n([\s\S]*?)```/.exec(source);
  if (!table) return ['the README no longer has a layout table'];

  const listed = new Set();
  for (const m of table[1].matchAll(/src\/([\w.]+\.m?js)/g)) listed.add(m[1]);

  const actual = fs.readdirSync(path.join(ROOT, 'src'))
    .filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));

  const problems = [];
  const missing = actual.filter((f) => !listed.has(f));
  if (missing.length) {
    problems.push(`the layout table does not mention src/${missing.join(', src/')}`);
  }
  const gone = [...listed].filter((f) => !actual.includes(f));
  if (gone.length) {
    problems.push(`the layout table mentions src/${gone.join(', src/')}, which no longer exists`);
  }
  return problems;
}

function main() {
  const m = measure();
  let source = fs.readFileSync(README, 'utf8');
  const problems = layoutGaps(source);
  const fixes = [];

  const headline = /(\d+) passing tests over (\d+)% of the lines/.exec(source);
  if (!headline) {
    problems.push('the README no longer states a passing-test count at all');
  } else {
    const want = `${m.tests} passing tests over ${m.coverage}% of the lines`;
    if (headline[0] !== want) {
      problems.push(`README says "${headline[0]}", repository says "${want}"`);
      fixes.push({ from: headline[0], to: want });
    }
  }

  const layout = layoutLine(source, m);
  if (!layout) {
    problems.push('the layout table no longer states a test count');
  } else if (layout.from !== layout.to) {
    problems.push(`README layout says "${layout.from.trim()}", repository says "${layout.to.trim()}"`);
    fixes.push(layout);
  }

  console.log(`${m.tests} tests across ${m.files} files, ${m.coverage}% of lines in src/`);

  if (problems.length === 0) {
    console.log('the README agrees');
    return 0;
  }

  if (!WRITE || fixes.length !== problems.length) {
    for (const p of problems) console.error(`  ${p}`);
    if (fixes.length) console.error('\nrun `node tools/readme-stats.mjs --write` to fix the counts');
    if (fixes.length !== problems.length) {
      console.error('the layout table has to be edited by hand -- a new module needs a line'
        + ' saying what it is for, and only its author knows that');
    }
    return 1;
  }

  for (const f of fixes) source = source.replace(f.from, f.to);
  fs.writeFileSync(README, source);
  console.log(`updated ${fixes.length} claim(s) in README.md`);
  return 0;
}

process.exit(main());
