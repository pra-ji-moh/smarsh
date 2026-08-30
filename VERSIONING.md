# Versioning and stability

Smarsh follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html), with
the pre-1.0 rules spelled out below, because "0.x means anything can change" is
true of the specification and useless to someone deciding whether to depend on
it.

## While Smarsh is 0.x

- **Minor** (`0.2.0` → `0.3.0`) may break things. Every break is listed under a
  `### Breaking` heading in [CHANGELOG.md](CHANGELOG.md), with what to do about
  it.
- **Patch** (`0.3.0` → `0.3.1`) never breaks anything in the stable surface
  below. Bug fixes and additions only.
- There are no backports. Fixes land on the latest version.

1.0 will not be tagged on a date. It will be tagged when the language surface
has gone two minor versions without a breaking change, there is an LSP, and the
cryptography is either audited or removed. Until then, pin an exact version.

## Stable surface

These are covered by the promise above. A break here is a breaking change and
gets a changelog entry.

- **Language syntax and semantics** - keywords, operators, precedence, scoping,
  the meaning of `let`, capability rules, taint rules, contract behaviour.
- **The capability names** - `fs`, `clock`, `crypto`, `unaudited_crypto`, `ffi`.
  Adding one is not a break; renaming one is.
- **CLI commands and flags** - `run`, `check`, `test`, `fmt`, `prove`, `build`,
  `repl`, `eval`, `explain`, and their flags. Output *text* is not covered;
  **exit codes are** (0 clean, 1 findings or failure, 2 misuse).
- **The standard library** - every function in `std/`, its name, arity and
  meaning.
- **Builtin functions** - names, arity, and what they do.
- **Error kinds** - `CapabilityError`, `TaintError` and the rest, as strings a
  program can match on via `rescue`.
- **`smarsh build` output** - a bundle produced by version *N* keeps working on
  the Node versions that version *N* supported.

## Not covered

Depend on these and a patch release may move under you:

- **Anything under `src/`.** The JavaScript API is internal. Import
  `bin/smarsh.mjs` as a program, not `src/interpreter.js` as a library.
- **Diagnostic wording and layout.** Messages get better over time. Match on
  error *codes* (`E0402`) or *kinds*, never on message text.
- **Error codes for findings that did not exist before.** New codes appear.
- **Performance.** Fast is a goal, not a contract.
- **Snapshot format.** `snapshot()` output is versioned internally and is not a
  storage format. Do not archive it.
- **The exact numbers from `energy()`.** It is a disclosed cost model, and the
  model can be recalibrated.
- **Seeded output across versions.** A given seed replays identically within a
  version. It is not guaranteed to produce the same draws in the next one -
  changing the PRNG or the order of draws is not a breaking change. If you need
  a run to be reproducible for audit, record the version alongside the seed.

That last one matters more than it looks: determinism is a within-version
guarantee, and anything relying on it for compliance evidence has to pin the
version to mean anything.

## Deprecation

Nothing in the stable surface is removed without warning:

1. It keeps working, and using it prints a deprecation warning naming the
   replacement.
2. It stays that way for at least one minor version.
3. It is removed in a minor version, listed under `### Breaking`.

The exception is a **security fix**. If a stable behaviour is the vulnerability,
it changes in the next release with an entry in the changelog and in
[SECURITY.md](SECURITY.md). The module capability change in 0.3.0 was exactly
this: it broke code that relied on a module inheriting authority, and it was
right to break it immediately.

## Node versions

Smarsh supports the Node versions in CI: currently **18, 20 and 22**. Dropping one
is a minor-version break with a changelog entry.
