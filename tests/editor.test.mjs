import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { builtinSurface } from '../src/diagnose.js';

// The VS Code extension.
//
// A broken TextMate grammar does not raise anything: VS Code loads what it can
// and silently gives up on the rest, so a file ends up half-coloured and the
// only symptom is that it looks wrong. The same is true of the manifest -- a
// mistyped `extensions` entry means the extension simply never activates.
//
// So the parts that can be checked without an editor are checked here: that it
// is valid JSON, that it points at files that exist, that the patterns compile
// as regular expressions, and that the lists of names inside it still match the
// runtime they claim to describe.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'editors', 'vscode');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const manifest = readJson(path.join(EXT, 'package.json'));
const grammar = readJson(path.join(EXT, 'syntaxes', 'smarsh.tmLanguage.json'));

test('the manifest points at files that exist', () => {
  for (const rel of [manifest.main, ...manifest.contributes.grammars.map((g) => g.path),
    ...manifest.contributes.languages.map((l) => l.configuration)]) {
    assert.ok(fs.existsSync(path.join(EXT, rel)), `the manifest names ${rel}, which does not exist`);
  }
});

test('the language configuration is valid JSON', () => {
  assert.doesNotThrow(() => readJson(path.join(EXT, 'language-configuration.json')));
});

test('it claims the right file extension, and the repository uses it', () => {
  const lang = manifest.contributes.languages[0];
  assert.deepEqual(lang.extensions, ['.smarsh']);
  assert.equal(lang.id, 'smarsh');
  // If the repository's own files stopped matching, the extension would never
  // activate on them and nobody would notice from inside this test file.
  const examples = fs.readdirSync(path.join(ROOT, 'examples')).filter((f) => f.endsWith('.smarsh'));
  assert.ok(examples.length > 0, 'no .smarsh examples for the extension to activate on');
});

test('the grammar scope matches what the manifest declares', () => {
  assert.equal(grammar.scopeName, manifest.contributes.grammars[0].scopeName);
});

test('every pattern in the grammar is a valid regular expression', () => {
  // A bad pattern is skipped silently by VS Code, so the failure looks like
  // "that keyword just is not coloured" rather than an error anyone can act on.
  const seen = [];
  const walk = (node, where) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((n, i) => walk(n, `${where}[${i}]`)); return; }
    for (const key of ['match', 'begin', 'end']) {
      if (typeof node[key] === 'string') {
        seen.push(`${where}.${key}`);
        assert.doesNotThrow(
          // Oniguruma is not JavaScript's engine, but everything used here is
          // in the shared subset, so this catches real mistakes.
          () => new RegExp(node[key]),
          `${where}.${key} is not a valid regular expression: ${node[key]}`,
        );
      }
    }
    for (const [k, v] of Object.entries(node)) if (typeof v === 'object') walk(v, `${where}.${k}`);
  };
  walk(grammar, 'grammar');
  assert.ok(seen.length > 15, `only ${seen.length} patterns found; the grammar looks truncated`);
});

test('every capture index a pattern names actually exists in it', () => {
  // A capture pointing at a group the pattern does not have colours nothing,
  // and is the second most common way one of these files quietly rots.
  const walk = (node, where) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((n, i) => walk(n, `${where}[${i}]`)); return; }
    for (const [key, pattern] of [['captures', node.match], ['beginCaptures', node.begin],
      ['endCaptures', node.end]]) {
      if (!node[key] || typeof pattern !== 'string') continue;
      const groups = new RegExp(`${pattern}|`).exec('').length - 1;
      for (const index of Object.keys(node[key])) {
        assert.ok(Number(index) <= groups,
          `${where}.${key} names group ${index}, but the pattern has only ${groups}`);
      }
    }
    for (const [k, v] of Object.entries(node)) if (typeof v === 'object') walk(v, `${where}.${k}`);
  };
  walk(grammar, 'grammar');
});

test('the grammar colours the security surface apart from ordinary control flow', () => {
  // The point of this language is which authority a program holds. If
  // `authority` and `release_to` look like `if`, the thing worth seeing is
  // invisible.
  const text = JSON.stringify(grammar);
  for (const kw of ['authority', 'release_to', 'vouched_by', 'grounded', 'region', 'needs']) {
    assert.ok(text.includes(kw), `the grammar does not mention \`${kw}\``);
  }
  assert.match(text, /keyword\.control\.authority\.smarsh/);
  // And `let` versus `var` -- the most common mistake in the language.
  assert.match(text, /storage\.modifier\.immutable\.smarsh/);
});

test('the capabilities the grammar highlights are the ones that exist', () => {
  const needs = builtinSurface().needs;
  const authorityCalls = /\\\\b\(([a-z_|]+)\)\\\\s\*\(\?=\\\\\(\)/.exec(JSON.stringify(grammar));
  assert.ok(authorityCalls, 'the grammar no longer highlights authority-costing calls');
  for (const name of authorityCalls[1].split('|')) {
    assert.ok(needs.has(name),
      `the grammar highlights \`${name}\` as costing authority, but the runtime says it does not`);
  }
});

test('the exact-decimal literal is matched, and only where it is real', () => {
  const decimal = JSON.stringify(grammar).match(/"([^"]*d\\\\b[^"]*)"/);
  assert.ok(decimal, 'the grammar stopped matching decimal literals');
  const re = new RegExp(JSON.parse(`"${decimal[1]}"`));
  assert.ok(re.test('19.99d'), 'a decimal literal is not matched');
  assert.ok(re.test('5d'), 'a whole decimal is not matched');
  assert.ok(!re.test('5dx'), '`5dx` was matched as a decimal');
});

test('the settings the extension offers are the ones something reads', () => {
  // `<id>.trace.server` is read by vscode-languageclient itself, not by our
  // code -- it is the convention the library looks for, and naming it here is
  // what makes the setting appear in the UI. Anything else must be read by the
  // client, or it is a switch in the settings pane that does nothing.
  const HANDLED_BY_THE_CLIENT_LIBRARY = new Set(['smarsh.trace.server']);
  const props = Object.keys(manifest.contributes.configuration.properties);
  const source = fs.readFileSync(path.join(EXT, 'extension.js'), 'utf8');
  for (const key of props) {
    if (HANDLED_BY_THE_CLIENT_LIBRARY.has(key)) continue;
    const short = key.replace(/^smarsh\./, '');
    assert.ok(source.includes(short) || source.includes(key),
      `the manifest offers a setting \`${key}\` that extension.js never reads`);
  }
  // And the library-handled one must still be spelled the way the library
  // expects, or it silently does nothing.
  for (const key of HANDLED_BY_THE_CLIENT_LIBRARY) {
    assert.ok(props.includes(key), `${key} was removed from the manifest`);
    assert.match(key, /^smarsh\.trace\.server$/);
  }
});

test('the client starts the server through the CLI that exists', () => {
  const source = fs.readFileSync(path.join(EXT, 'extension.js'), 'utf8');
  assert.match(source, /'lsp'/, 'the client does not launch the lsp subcommand');
  assert.match(source, /bin', 'smarsh\.mjs'/, 'the client does not know where the CLI is');
  assert.ok(fs.existsSync(path.join(ROOT, 'bin', 'smarsh.mjs')));
});
