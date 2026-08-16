# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [VERSIONING.md](VERSIONING.md).

> **Nothing here has been published yet.** These versions are development
> milestones in a single unreleased line of work, not releases anyone has
> installed. The first public release will be **0.3.0**, and this file exists so
> that the history is written down before it is forgotten rather than
> reconstructed afterwards.

## [Unreleased]

Nothing yet.

## [0.3.0] — unreleased, first public release

The release that came out of a security and correctness review. Four defects
were found, three of which contradicted claims the documentation was making.

### Security

- **Modules no longer inherit the importer's capabilities.** A module's
  top-level code previously ran with whatever the importing frame held, so
  `import` was a way to perform effects with someone else's authority before the
  importing program's first statement executed. A module now loads holding
  nothing. Functions it exports are unaffected — they are still checked against
  the caller at the point they are called.
- **Unaudited cryptography moved behind its own capability.** `crypto` now
  covers only platform-backed primitives (Ed25519, SHA-256, OS entropy).
  Paillier, Schnorr and Pedersen — implemented here, in BigInt, not constant
  time, never audited — require `unaudited_crypto`. A deployment can take the
  first and refuse the second. A Paillier modulus under 2048 bits is recorded in
  the run trace.
- **Taint is now checked statically**, over every path, not only the one a run
  took. `pedag check` reports a labelled value reaching a `grounded` or `region`
  sink through call chains, collections, interpolation and branch merges.

### Breaking

- **`let` now freezes what it binds, all the way down.** `let xs = [1, 2]`
  followed by `xs.push(3)` raises `ImmutableError`; so does
  `deep["xs"].push(2)`. Previously `let` blocked rebinding only, which is the
  weaker guarantee people assume they are getting and were not. Use `var` for
  collections that have to change.
- **Integer literals beyond 2^53 are a syntax error** rather than being silently
  rounded. `9007199254740993` now points you at `dec`.
- Crypto programs need `--grant crypto,unaudited_crypto` where `--grant crypto`
  used to be enough.

### Added

- **`dec`, exact decimal arithmetic.** A BigInt coefficient and a scale, so
  `dec("0.1") + dec("0.2") == dec("0.3")` is true and a thousand additions of
  `dec("0.01")` is exactly `10.00`. Division states its scale and rounds
  half-to-even. Decimals do not mix with floats implicitly.
- **`pedag-allow` suppressions.** A source comment scoped to the statement it
  introduces, counted in the summary so a silenced finding stays visible.
- Parser error recovery: `pedag check` reports every syntax error in a file
  rather than stopping at the first.

### Fixed

- `std/` was missing from the published package's file list, so an installed
  copy would have had no standard library at all.

## [0.2.0] — unreleased development milestone

### Added

- Gradual type system with optional annotations, local bidirectional inference
  and a consistency relation, so unannotated programs check clean.
- Rendered diagnostics: source spans with carets, error codes, `pedag explain`,
  Damerau-Levenshtein suggestions, and runtime stack traces.
- Records, pattern matching with guards and destructuring, string interpolation.
- Standard library — `std/list`, `std/str`, `std/math`, `std/result` — written
  in Pēdāg.
- `pedag test` (unit tests, contracts, types and races in one command),
  `pedag fmt` (one canonical layout, no options), `pedag build` (one
  self-contained `.mjs`).
- `foreign()` FFI into JavaScript, capability-gated, values converted rather
  than shared, results labelled `untrusted`.
- Module system with content-addressed caching.
- Agents with private state and enforced isolation; un-overridable `budget`
  blocks; `--profile`; static race detection.
- Worker-backed parallel matrix multiply, memory arena with disk spill,
  disk-paged weights.
- Paillier, Schnorr, Pedersen, Ed25519 signing, signed lineage chains, secret
  scopes, `atomic` blocks, quantum simulator, logical clocks, decaying values,
  schema negotiation, validated self-modification, state migration.

### Changed

- Ledger hashing moved from FNV-1a to SHA-256.
- `record` is a contextual keyword, so it remains usable as an ordinary name.
- Interpreter optimisation pass: 1037 ms to about 700 ms on the benchmark suite.

## [0.1.0] — unreleased development milestone

### Added

- The core language: lexer, parser, tree-walking interpreter, REPL.
- First-class tensors with broadcasting and `@`.
- Probabilistic control flow (`maybe`, `choose`) with seeded reproducibility.
- `fork` for isolated reasoning paths.
- Capability security with attenuation.
- Provenance labels with `grounded` and `region` enforcement.
- Contracts (`requires` / `ensures`) and `pedag prove`, which generates inputs
  from them.
- Token-accounted context windows, hash-chained ledgers.
