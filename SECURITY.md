# Security

Pēdāg makes security claims that are load-bearing — capability attenuation, taint
tracking, execution budgets — so it needs a threat model that says what those
claims actually cover, and an honest list of where they do not.

> **Before you read further:** Pēdāg has had **no third-party security audit**,
> has **no production users**, and is **pre-1.0**. Do not put it on a boundary
> where a compromise matters. The mechanisms below are real and tested; that is
> not the same as being proven against a motivated attacker.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting on this repository
(Security → Report a vulnerability). It requires no email address and the
report stays private until a fix is out.

<!--
  MAINTAINER: if you want an email route as well, put an address here. It is
  deliberately left blank rather than filled in with a personal address —
  publishing one is a decision for the person who owns it, not a default.
-->

What to include: a `.pedag` file that reproduces it, the `--grant` flags used,
your Node version, and what you expected the runtime to refuse.

**Response commitment.** This is currently maintained by one person, so the
honest commitment is: acknowledgement within 7 days, an assessment within 30.
If that is not fast enough for your situation, Pēdāg is not ready for your
situation.

## Threat model

Pēdāg's guarantees are about **a program's own code and its dependencies**, not
about the host. It is a language runtime, not a sandbox, and the distinction
matters.

### In scope — these are vulnerabilities

Report anything that lets code do one of these:

| Claim | A break looks like |
|---|---|
| **Capability attenuation** | Reaching an effect (`fs`, `clock`, `crypto`, `ffi`) from a frame that did not declare it, or that the run was never granted |
| **Module isolation** | A module obtaining authority from its importer, reading the importer's scope, or performing effects at import time |
| **Provenance** | Clearing a taint label without `trust()`, or a labelled value entering a `grounded` block or the wrong `region` undetected |
| **Budgets** | Code inside a `budget` block surviving exhaustion, raising its own ceiling, or catching its own stop |
| **Agent isolation** | An agent writing anything outside its own state |
| **Immutability** | Mutating a value bound with `let` |
| **Contracts** | A function returning a value its `ensures` clause forbids |
| **Ledgers and lineage** | Editing, reordering or truncating entries with `verify()` still returning true |
| **Determinism** | Two runs with the same seed and no effect capabilities diverging |
| **FFI** | Crossing the boundary without `ffi`, or a foreign result arriving unlabelled |

### Out of scope — known and documented

These are limitations already written down, not discoveries:

- **`paillier_keygen` refuses a modulus below 2048 bits.** A smaller one is
  reachable only through `paillier_keygen_insecure`, which warns on stderr and
  records the fact in the audit manifest. Examples use it deliberately.
- **`unaudited_crypto` is unaudited and not constant time.** Paillier, Schnorr
  and Pedersen are implemented in BigInt, which is not constant-time by design.
  They leak timing information. Do not put them in front of an adversary who can
  measure you. Timing side channels in these functions are documented behaviour,
  not a report.
- **`ffi` is a deliberate escape hatch.** Granting it hands control to
  JavaScript, where none of Pēdāg's guarantees apply. That is the whole reason it
  is a separate capability.
- **Pēdāg does not sandbox the host.** A program granted `fs` can read and write
  anywhere under the program's directory. Capabilities bound what *Pēdāg code*
  reaches, not what the process can do. Use OS-level isolation if you need that.
- **Resource exhaustion beyond steps and tokens.** `budget` bounds execution
  steps and context tokens. It does not bound heap. A program can still allocate
  until Node dies.
- **Static taint analysis is a may-analysis.** It reports what *can* happen, so
  it can flag an unreachable path. It will not stay quiet about a reachable one.
- **Denial of service by crashing the interpreter.** A malformed program that
  makes the runtime throw is an ordinary bug — file it publicly.

## What is actually tested

The claims above are not aspirational. Each has tests that try to break it,
including regression tests for defects that were real:

- `tests/guarantees.test.mjs` — the module capability escape (with the original
  exploit, asserting no file is written), deep immutability, exact arithmetic,
  the crypto capability split.
- `tests/agents.test.mjs` — budget stops that an inner `attempt` cannot swallow;
  agent isolation.
- `tests/ffi.test.mjs` — the boundary refusing an undeclared caller; foreign
  results arriving `untrusted`.
- `tests/crypto.test.mjs` — group parameters re-derived rather than trusted;
  lineage detecting edits, reordering, truncation and re-signing.
- `tests/recovery.test.mjs` — taint reaching a sink on paths a run does not take.

If you are reviewing Pēdāg, those files are the fastest way to see what is
claimed and how it is checked.

## Cryptographic inventory

Know exactly what you are trusting.

| Primitive | Implementation | Status |
|---|---|---|
| SHA-256 | `node:crypto` | Platform |
| Ed25519 sign/verify | `node:crypto` | Platform |
| Random bytes | `node:crypto` | Platform |
| Paillier | this repository, BigInt | **Unaudited, not constant time** |
| Schnorr (Fiat-Shamir) | this repository, BigInt | **Unaudited, not constant time** |
| Pedersen commitments | this repository, BigInt | **Unaudited, not constant time** |
| RFC 3526 group 14 | constant, re-derived in tests | Parameters verified, arithmetic unaudited |

Replacing the bottom three with audited libraries through the FFI is the
recommended path for anything real, and is the project's own next priority.

## Supported versions

Pre-1.0: only the latest version receives fixes. There are no backports.
