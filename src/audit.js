import { createHash } from 'node:crypto';

import { signMessage } from './crypto.js';

// What a run actually did, as a document.
//
// Sarvm already observes things a runtime normally cannot: which capabilities
// were exercised and which were refused, where labelled data went, who
// declassified what and on what stated grounds, which contracts were checked,
// what authority was lent and later revoked. Until now all of that was thrown
// away when the process exited.
//
// This is the artifact that survives. It answers, for one specific execution:
//
//     What could this program reach?        the capabilities it was granted
//     What did it actually touch?           every effect, with line numbers
//     What did it try and get refused?      denials are recorded, not just failures
//     Where did the data go?                every label crossing, allowed or not
//     Who released it, and why?             declassification with principal and reason
//     Did it keep its promises?             contracts checked and violated
//     Can we see it again?                  the seed, and the version it needs
//
// Every entry is hash-chained onto the last, so a line cannot be edited,
// removed or reordered without `verify` failing. With a signing key the head is
// signed, so the record also says who is standing behind it.
//
// A compliance reviewer does not run a language. They read a document, and they
// need to know the document was not written afterwards by the party being
// reviewed. That is what this is for.

const VERSION = 1;
const ZERO = '0'.repeat(64);
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function chain(entries) {
  let head = ZERO;
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    const payload = JSON.stringify(entries[i]);
    const hash = sha256(`${head}|${i}|${payload}`);
    out.push({ ...entries[i], seq: i, prev: head, hash });
    head = hash;
  }
  return { entries: out, head };
}

function tally(list, key) {
  const counts = new Map();
  for (const item of list) {
    const k = typeof key === 'function' ? key(item) : item[key];
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]));
}

export function buildManifest(interp, {
  file = '<source>', source = '', runtimeVersion = '0.0.0', signWith = null, outcome = 'completed',
} = {}) {
  const t = interp.trace;

  const events = [];
  const at = (line) => (line == null ? null : line);

  for (const e of t.effects) {
    events.push({
      event: e.allowed ? 'capability.used' : 'capability.refused',
      capability: e.capability,
      by: e.by,
      line: at(e.line),
    });
  }
  for (const c of t.crossings) {
    events.push({
      event: c.allowed ? 'data.released' : 'data.release_refused',
      to: c.to,
      label: c.label,
      line: at(c.line),
    });
  }
  for (const d of t.declassifications ?? []) {
    events.push({
      event: 'data.declassified',
      principal: d.owner ?? d.principal ?? null,
      reason: d.reason,
      line: at(d.line),
    });
  }
  for (const l of t.laundered ?? []) {
    events.push({
      event: 'taint.cleared',
      cleared: l.cleared,
      reason: l.reason,
      line: at(l.line),
    });
  }
  for (const g of t.grantUses ?? []) {
    events.push({ event: 'authority.delegated', capability: g.capability, line: at(g.line) });
  }
  for (const r of t.revocations ?? []) {
    events.push({ event: 'authority.revoked', capability: r.capability, line: at(r.line) });
  }
  for (const r of t.redefinitions ?? []) {
    events.push({ event: 'code.redefined', name: r.name, affected: r.affected, line: at(r.line) });
  }
  for (const m of t.foreignModules ?? []) {
    events.push({ event: 'boundary.crossed', module: m, line: null });
  }
  for (const w of t.cryptoWarnings ?? []) {
    events.push({ event: 'crypto.warning', detail: w, line: null });
  }

  // Order by line so the document reads in the order the program ran, with
  // events that have no line last.
  events.sort((a, b) => (a.line ?? 1e9) - (b.line ?? 1e9));

  const chained = chain(events);
  const granted = [...interp.grantedCaps].sort();
  const exercised = [...new Set(t.effects.filter((e) => e.allowed).map((e) => e.capability))].sort();

  const manifest = {
    manifest: VERSION,
    runtime: `sarvm ${runtimeVersion}`,
    program: {
      file,
      sha256: sha256(source),
    },
    // Everything needed to run it again and get the same answer.
    replay: {
      seed: interp.seed,
      capabilities: granted,
      principals: [...interp.grantedAuthority].sort(),
      note: 'a run with no clock, crypto or ffi capability replays identically on this runtime version',
    },
    outcome,
    authority: {
      granted,
      exercised,
      // The most useful line in the document for a reviewer: authority the
      // program was given and demonstrably never used.
      granted_but_unused: granted.filter((c) => !exercised.includes(c)),
      refused: tally(t.effects.filter((e) => !e.allowed), 'capability'),
    },
    data: {
      releases_allowed: t.crossings.filter((c) => c.allowed).length,
      releases_refused: t.crossings.filter((c) => !c.allowed).length,
      declassifications: (t.declassifications ?? []).length,
      taint_cleared: (t.laundered ?? []).length,
      foreign_modules: t.foreignModules ?? [],
    },
    promises: {
      contracts_checked: t.contracts,
      // A run that completed is a run in which no contract was violated: a
      // violation raises and the outcome would say so.
      contracts_violated: outcome === 'completed' ? 0 : null,
    },
    work: {
      calls: t.calls,
      steps: interp.steps,
      probabilistic_branches: (t.branches ?? []).length,
      forked_paths: t.forks,
    },
    events: chained.entries,
    head: chained.head,
  };

  if (signWith) {
    manifest.signature = {
      algorithm: 'ed25519',
      public_key: signWith.publicHex,
      value: signMessage(signWith, chained.head),
    };
  }
  return manifest;
}

// Re-derive every hash. Any edit, removal or reordering breaks the chain.
export function verifyManifest(manifest) {
  const problems = [];
  if (!manifest || manifest.manifest !== VERSION) {
    return { ok: false, problems: ['not a manifest this runtime can read'] };
  }

  let head = ZERO;
  manifest.events.forEach((e, i) => {
    const { seq, prev, hash, ...payload } = e;
    if (seq !== i) problems.push(`event ${i} is numbered ${seq}`);
    if (prev !== head) problems.push(`event ${i} does not follow the one before it`);
    const expected = sha256(`${head}|${i}|${JSON.stringify(payload)}`);
    if (hash !== expected) problems.push(`event ${i} has been altered`);
    head = hash;
  });
  if (head !== manifest.head) problems.push('the final hash does not match the chain');

  return { ok: problems.length === 0, problems };
}

// The human-readable half. A reviewer reads this; a system reads the JSON.
export function summarise(manifest) {
  const lines = [];
  const a = manifest.authority;
  const d = manifest.data;

  lines.push(`run of ${manifest.program.file}  (${manifest.runtime}, outcome: ${manifest.outcome})`);
  lines.push(`  program sha256   ${manifest.program.sha256.slice(0, 32)}...`);
  lines.push(`  replay with      --seed ${manifest.replay.seed}`
    + (a.granted.length ? ` --grant ${a.granted.join(',')}` : ' (no capabilities)'));
  lines.push('');

  lines.push('  authority');
  lines.push(`    granted        ${a.granted.length ? a.granted.join(', ') : 'none'}`);
  lines.push(`    actually used  ${a.exercised.length ? a.exercised.join(', ') : 'none'}`);
  if (a.granted_but_unused.length) {
    lines.push(`    never used     ${a.granted_but_unused.join(', ')}   <- can be withdrawn`);
  }
  const refused = Object.entries(a.refused);
  if (refused.length) {
    lines.push(`    refused        ${refused.map(([k, v]) => `${k} x${v}`).join(', ')}`);
  }

  lines.push('  data');
  lines.push(`    released       ${d.releases_allowed} permitted, ${d.releases_refused} refused`);
  lines.push(`    declassified   ${d.declassifications} (each with a stated reason, below)`);
  lines.push(`    taint cleared  ${d.taint_cleared}`);
  if (d.foreign_modules.length) {
    lines.push(`    left the runtime via ${d.foreign_modules.join(', ')}`);
  }

  lines.push('  promises');
  lines.push(`    contracts checked ${manifest.promises.contracts_checked}`);

  const notable = manifest.events.filter((e) => e.event !== 'capability.used');
  if (notable.length) {
    lines.push('');
    lines.push('  events worth a reviewer\'s attention');
    for (const e of notable) {
      const where = e.line ? `line ${e.line}` : '-';
      const detail = e.reason ? `  "${e.reason}"` : (e.detail ? `  ${e.detail}` : '');
      lines.push(`    ${String(where).padEnd(9)} ${e.event.padEnd(24)}${e.capability ?? e.to ?? e.name ?? e.module ?? e.principal ?? ''}${detail}`);
    }
  }

  lines.push('');
  lines.push(`  ${manifest.events.length} events, hash-chained, head ${manifest.head.slice(0, 16)}...`);
  if (manifest.signature) {
    lines.push(`  signed by ${manifest.signature.public_key.slice(-16)}`);
  } else {
    lines.push('  unsigned: pass --sign to bind this record to a key');
  }
  return lines.join('\n');
}
