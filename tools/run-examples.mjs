// Run every example the way its own header says to run it.
//
// CI used to carry a hand-written list of examples and their flags. It drifted:
// `crypto` was split into `crypto` and `unaudited_crypto`, the list kept saying
// `--grant crypto`, and the example had been failing for some time without
// anyone noticing, because the list was the only thing that ran it.
//
// So the invocation is read out of the example instead. Every example documents
// its own command line in a comment at the top; this runs exactly that. A new
// example is covered the moment it exists, and a header that has gone stale is
// a CI failure rather than a misleading comment.
//
//     node tools/run-examples.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'examples');
const cli = path.join(root, 'bin', 'smarsh.mjs');

// `smarsh run examples/x.smarsh --grant fs` and
// `node bin/smarsh.mjs run examples/x.smarsh --grant fs` are the same command.
const INVOCATION = /^\/\/\s*(?:node\s+bin\/smarsh\.mjs|smarsh)\s+run\s+(\S+)(.*)$/;

// Read the leading comment block and pull out the documented `run` line,
// following backslash continuations.
function documentedFlags(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    if (!line.startsWith('//')) break;      // past the header
    const m = INVOCATION.exec(line);
    if (!m) continue;

    let rest = m[2];
    // A wrapped command line: `... --principal compliance \` then `//   --audit ...`
    while (rest.trimEnd().endsWith('\\')) {
      rest = rest.trimEnd().slice(0, -1);
      const next = (lines[++i] ?? '').trim();
      if (!next.startsWith('//')) break;
      rest += ' ' + next.replace(/^\/\/\s*/, '');
    }
    return { target: m[1], flags: rest.trim().split(/\s+/).filter(Boolean) };
  }
  return null;
}

// `--audit run.json` would write into the repo; send it outside instead.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smarsh-examples-'));

function sanitise(flags, name) {
  const out = [];
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--audit') {
      out.push('--audit', path.join(scratch, `${name}.audit.json`));
      if (flags[i + 1] && !flags[i + 1].startsWith('-')) i++;
      continue;
    }
    out.push(flags[i]);
  }
  return out;
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.smarsh')).sort();
let failed = 0;
let undocumented = 0;

for (const name of files) {
  const file = path.join(dir, name);
  const doc = documentedFlags(file);

  if (!doc) {
    // Not an error -- some examples need nothing -- but it is worth saying,
    // because an example with no documented invocation is one nobody can run
    // without reading the source.
    undocumented += 1;
  }

  const flags = sanitise(doc?.flags ?? [], name);
  const shown = ['run', `examples/${name}`, ...flags].join(' ');
  const r = spawnSync(process.execPath, [cli, 'run', file, ...flags], { encoding: 'utf8' });

  if (r.status === 0) {
    console.log(`  ok    smarsh ${shown}`);
  } else {
    failed += 1;
    console.log(`  FAIL  smarsh ${shown}   (exit ${r.status})`);
    const detail = (r.stderr || r.stdout || '').trimEnd().split('\n').slice(-12);
    for (const line of detail) console.log(`        ${line}`);
  }
}

fs.rmSync(scratch, { recursive: true, force: true });

console.log(`\n${files.length} examples, ${files.length - failed} passing, `
  + `${undocumented} with no documented invocation`);
process.exitCode = failed === 0 ? 0 : 1;
