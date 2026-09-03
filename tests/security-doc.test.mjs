import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// SECURITY.md names, for every claim it makes, the exact test that proves it.
//
// A citation that no longer resolves is worse than no citation at all: it has
// the shape of evidence without being any. Tests get renamed and files get
// split, and prose does not follow. So the citations are checked here, and the
// build fails when one stops landing.
//
// This is the same reason `tools/readme-stats.mjs` exists. A claim nobody
// re-checks drifts into a false one.

// A row of the claims table: `tests/thing.test.mjs` | `the test name`
const CITATION = /`(tests\/[\w.-]+\.mjs)`\s*\|\s*`([^`]+)`/g;

test('every test SECURITY.md cites exists and still carries that name', () => {
  const doc = readFileSync(join(root, 'SECURITY.md'), 'utf8');
  const cites = [...doc.matchAll(CITATION)].map(([, file, name]) => ({ file, name }));

  // If the table format changes, the regex silently matches nothing and this
  // file starts passing without checking anything. That is the failure mode
  // worth guarding, so the count is asserted rather than assumed.
  assert.ok(cites.length >= 15,
    `only ${cites.length} citations parsed out of SECURITY.md; the table format changed`);

  const sources = new Map();
  const broken = [];

  for (const { file, name } of cites) {
    const path = join(root, file);
    if (!existsSync(path)) {
      broken.push(`${file} does not exist (cited for "${name}")`);
      continue;
    }
    if (!sources.has(file)) sources.set(file, readFileSync(path, 'utf8'));
    if (!sources.get(file).includes(`test('${name}'`)) {
      broken.push(`${file} has no test named "${name}"`);
    }
  }

  assert.deepEqual(broken, [],
    `SECURITY.md cites tests that are not there:\n  ${broken.join('\n  ')}`);
});

test('the claims table covers the subsystems the threat model puts in scope', () => {
  // The in-scope table and the evidence table are written by hand and can drift
  // apart. Every area the threat model claims should appear in a citation.
  const doc = readFileSync(join(root, 'SECURITY.md'), 'utf8');
  const cited = [...doc.matchAll(CITATION)].map(([, file]) => file);
  const files = new Set(cited);

  for (const required of [
    'tests/capability.test.mjs',   // attenuation
    'tests/guarantees.test.mjs',   // module isolation, immutability
    'tests/adversarial.test.mjs',  // the record, and attacks on it
    'tests/integrity.test.mjs',    // the integrity half of the label model
    'tests/ffi.test.mjs',          // the documented escape
    'tests/agents.test.mjs',       // agent isolation
  ]) {
    assert.ok(files.has(required), `SECURITY.md no longer cites ${required}`);
  }
});
