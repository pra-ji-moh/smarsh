# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [VERSIONING.md](VERSIONING.md).

> **Nothing here has been published yet.** These versions are development
> milestones in a single unreleased line of work, not releases anyone has
> installed. The first public release will be **0.3.0**, and this file exists so
> that the history is written down before it is forgotten rather than
> reconstructed afterwards.

## [Unreleased]

### Changed

- **The language is now called Smarsh.** It was Pedag, and briefly Sarvm before
  that. Nothing has been published under any of those names, so this renames a
  thing no one has installed -- but it renames all of it, and the parts that are
  interfaces rather than prose are listed here because a reader coming from a
  local checkout will hit them.

  | was | is |
  |---|---|
  | `pedag` on the command line | `smarsh` |
  | `pedag-verify` | `smarsh-verify` |
  | `.pedag` source files | `.smarsh` |
  | the `pedag` npm package | `smarsh` |
  | `PEDAG_DEBUG_ENV` | `SMARSH_DEBUG_ENV` |
  | `pedagError`, `pedagType`, `pedagMembers`, `PedagError` | `smarsh*`, `SmarshError` |

- **Pedersen commitments computed before this change no longer open.** The
  second generator is derived from a nothing-up-my-sleeve string that contained
  the project's name:

  ```
  H = (sha256("Smarsh/pedersen/generator/v1"))^2 mod p     // was "Pedag/..."
  ```

  Renaming the project changed the string, which changed `H`, which changes
  every commitment. The construction is exactly as sound as before -- `H` is
  still in the order-q subgroup and its discrete log with respect to `G` is
  still unknown -- but a commitment stored under the old name will not verify
  against a value opened under the new one. This is the only behavioural change
  in the rename, and it is called out because nothing about "we renamed the
  project" suggests it.

### Added

- **`choice` — sum types with static exhaustiveness checking.**

  ```
  choice Payment {
    Card(last4, amount)
    Transfer(iban, amount)
    Cash(amount)
    Refused(reason)
  }
  ```

  Each variant is an ordinary record, so construction, fields, structural
  equality, printing, `.with()`, invariants and pattern matching all worked
  already and none of it needed a second implementation. What a choice adds is
  that the set is *closed*, and a closed set is what lets `smarsh check` prove a
  `match` is total:

  ```
  error[E0605]: this match on `Payment` does not handle `Refused`
  ```

  Without it the four records above run identically — right up until a payment
  is refused in production and nothing has a case for it. `smarsh explain E0605`.

  The checker is deliberately quiet where it cannot be certain: a wildcard or
  bare binding, arms spanning two choices, a variant name declared by more than
  one choice, or a `when` guard (a guarded arm may decline to fire, so it does
  not close its variant). Exhaustiveness is static; a program run without
  `check` still raises `MatchError` rather than returning nil.

  A variant carrying nothing is a value, not a constructor: `Pending`, not
  `Pending()`. That required an exception in the matcher — a bare name in a
  pattern normally binds anything, so an arm reading `Pending =>` was silently
  swallowing every other case that reached it. `match s { Empty => 0, Circle(r)
  => r * r }` returned 0 for a `Circle`. A name already bound to a nullary
  variant now tests for that variant; ordinary variables still bind.

- **`std/result` is built from choices.** `Result` is `Ok | Err`, `Option` is
  `Some | None`. The file always claimed to be about "outcomes that cannot be
  ignored"; now that is enforced rather than asserted, because a match that
  forgets the failing case is a build failure. `None()` is written `None`.

- **`examples/choices.smarsh`**, and `choice` in `docs/reference.md`.

### Fixed

- **The type checker no longer invents a type for `+`.** It is the one
  overloaded operator — numbers, text, lists — and with both operands `dyn` the
  checker returned `num` anyway. That produced a false error on correct code in
  the shipped standard library (`std/str.smarsh`), which nobody had seen because
  CI only ran `check` over `examples/`. `std/` is now checked too.

### Security

- **`budget memory N { }`** — a third budget kind. Allocation is charged at list
  literals, `.push` and `map.set`, and the block is stopped once the total passes
  the ceiling. Previously a program could allocate until the host process died
  and no budget could stop it. The figure is a deterministic estimate, not a
  reading of the host heap: sampling real memory would make a run depend on what
  else the machine was doing, and every replay guarantee rests on a run being
  reproducible from its seed. Its limits are written down in
  [LIMITATIONS.md](LIMITATIONS.md) §5.

### Fixed

- **Control-flow signals no longer escape as raw JavaScript objects.** `return`
  outside a function, and `break` or `continue` outside a loop, threw the
  interpreter's internal signal all the way out to the user — an object with no
  kind, no line and no message. They are now `ControlFlowError` (`E0604`), and
  `smarsh check` reports them statically, before the program runs.

  The serious case was a `break` inside a function called from a loop: the signal
  travelled out of the call and was caught by the **caller's** loop, silently
  ending an iteration the callee had no business ending. That is now an error.

  Found by fuzzing, on 5% of 20,000 generated programs.
- **Error messages pick the right article** — `an agent has no 'ping'`, not
  `a agent has no 'ping'`.
- **Repeated `--grant` and `--principal` flags accumulate.** `--grant fs --grant
  net` previously kept only `net` and discarded the earlier flag without a word.
- **CI had never run.** Every step invoked `bin/Smarsh.mjs`, a path that does not
  exist — the file is `bin/smarsh.mjs`, and a rename script had rewritten the
  workflow's command lines along with the prose. Nothing in the workflow could
  have passed. Fixing it exposed three assertions that had quietly gone stale
  behind it:
  - the examples were run from a hand-written list that still passed
    `--grant crypto` after `crypto` was split into `crypto` and
    `unaudited_crypto`, so `examples/crypto.smarsh` had been failing;
  - the type-check step listed eight examples by hand and had fallen five
    behind the directory;
  - the verifier step asserted a non-zero exit on `examples/contracts.smarsh`,
    which the verifier does not produce there: the planted false contracts are
    nonlinear, so the solver correctly answers `undecided` rather than
    `refuted`, and `prove` is what catches them.

  Both hand-written lists are gone. Examples are now run by
  `tools/run-examples.mjs`, which reads each example's own documented command
  line out of its header, so a new example is covered as soon as it exists and a
  stale header is a build failure rather than a misleading comment.
- **`examples/agents.smarsh` demonstrates its race again.** The file said "run
  `smarsh check` on this file: the fork below is reported", and then suppressed
  that exact finding with `smarsh-allow`, so a reader saw `no problems found`.
  The suppression is gone.

### Added

- **`npm run fuzz`** (`tools/fuzz.mjs`) — generates programs from a grammar of
  fragments and asserts the runtime never surfaces a raw JavaScript error, across
  the interpreter, the error-recovery parser and the formatter alike. It reports
  an outcome histogram, so a campaign quietly testing nothing but `NameError` is
  visible rather than being reported as a clean run — which is how the generator
  was found to be sending 45% of its cases into the same missing-name path. Last
  campaign: 150,000 cases, 33,224 running to completion, zero leaks.
- **20 fuzz regression tests** (`tests/fuzz.test.mjs`), pinning the control-flow
  fix and the memory budget alongside the existing token-soup, deep-nesting,
  wrong-type, recursion and cyclic-value cases.
- **`tools/run-examples.mjs`** — runs every example the way its own header says
  to run it, and reports how many examples document no invocation at all.
- **`E0604`** joins the explainable error codes: `smarsh explain E0604`.

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
  took. `smarsh check` reports a labelled value reaching a `grounded` or `region`
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
- **`smarsh-allow` suppressions.** A source comment scoped to the statement it
  introduces, counted in the summary so a silenced finding stays visible.
- Parser error recovery: `smarsh check` reports every syntax error in a file
  rather than stopping at the first.

### Fixed

- `std/` was missing from the published package's file list, so an installed
  copy would have had no standard library at all.

## [0.2.0] — unreleased development milestone

### Added

- Gradual type system with optional annotations, local bidirectional inference
  and a consistency relation, so unannotated programs check clean.
- Rendered diagnostics: source spans with carets, error codes, `smarsh explain`,
  Damerau-Levenshtein suggestions, and runtime stack traces.
- Records, pattern matching with guards and destructuring, string interpolation.
- Standard library — `std/list`, `std/str`, `std/math`, `std/result` — written
  in Smarsh.
- `smarsh test` (unit tests, contracts, types and races in one command),
  `smarsh fmt` (one canonical layout, no options), `smarsh build` (one
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
- Contracts (`requires` / `ensures`) and `smarsh prove`, which generates inputs
  from them.
- Token-accounted context windows, hash-chained ledgers.
