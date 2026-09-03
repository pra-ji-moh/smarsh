# Security

Smarsh makes security claims that are load-bearing - capability attenuation, taint
tracking, execution budgets - so it needs a threat model that says what those
claims actually cover, and an honest list of where they do not.

> **Before you read further:** Smarsh has had **no third-party security audit**,
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
  deliberately left blank rather than filled in with a personal address -
  publishing one is a decision for the person who owns it, not a default.
-->

What to include: a `.smarsh` file that reproduces it, the `--grant` flags used,
your Node version, and what you expected the runtime to refuse.

**Response commitment.** This is currently maintained by one person, so the
honest commitment is: acknowledgement within 7 days, an assessment within 30.
If that is not fast enough for your situation, Smarsh is not ready for your
situation.

## Threat model

Smarsh's guarantees are about **a program's own code and its dependencies**, not
about the host. It is a language runtime, not a sandbox, and the distinction
matters.

### In scope - these are vulnerabilities

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

### Out of scope - known and documented

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
  JavaScript, where none of Smarsh's guarantees apply. That is the whole reason it
  is a separate capability.
- **Smarsh does not sandbox the host.** A program granted `fs` can read and write
  anywhere under the program's directory. Capabilities bound what *Smarsh code*
  reaches, not what the process can do. Use OS-level isolation if you need that.
- **Resource exhaustion beyond steps and tokens.** `budget` bounds execution
  steps and context tokens. It does not bound heap. A program can still allocate
  until Node dies.
- **Static taint analysis is a may-analysis.** It reports what *can* happen, so
  it can flag an unreachable path. It will not stay quiet about a reachable one.
- **Denial of service by crashing the interpreter.** A malformed program that
  makes the runtime throw is an ordinary bug - file it publicly.

## What is actually tested

The claims above are not aspirational, and "we have tests" is not an answer to
someone deciding whether to trust this. So each claim names the test that tries
to break it. Go straight from the row to the code.

`tests/security-doc.test.mjs` fails the build if any citation below stops
resolving, because a claim carrying a stale citation is worse than one carrying
none: it has the shape of evidence without being any.

| Claim | File | Test |
|---|---|---|
| Capability attenuation | `tests/adversarial.test.mjs` | `a callback cannot borrow authority from the builtin that calls it` |
| Authority is declared, not inherited | `tests/capability.test.mjs` | `the requirement travels to the caller` |
| Module isolation | `tests/guarantees.test.mjs` | `a module cannot perform effects at import time` |
| Confidentiality: a classified value cannot leave its policy | `tests/adversarial.test.mjs` | `a classified value cannot be carried out of its policy` |
| Integrity: a vouch dies on contact with unvouched data | `tests/integrity.test.mjs` | `a vouch does not survive being combined with a literal` |
| Declassification needs the owner and a stated reason | `tests/adversarial.test.mjs` | `declassifying needs the owner, a reason, and cannot be faked` |
| Provenance survives every route out of a value | `tests/adversarial.test.mjs` | `taint cannot be laundered by moving a value through anything` |
| Provenance is found on paths the run does not take | `tests/recovery.test.mjs` | `a label reaching a grounded block is found even on an untaken path` |
| Immutability goes all the way down | `tests/guarantees.test.mjs` | `the freeze goes all the way down` |
| Agent isolation | `tests/agents.test.mjs` | `an agent cannot write anything outside its own state` |
| The record cannot be edited anywhere outside its chain | `tests/adversarial.test.mjs` | `no field outside the chain can be edited without detection` |
| The specific forgery that once verified is caught | `tests/adversarial.test.mjs` | `the specific lie that used to work is caught` |
| A refusal cannot be erased from the summary | `tests/adversarial.test.mjs` | `a refusal cannot be removed from the summary` |
| Events cannot be grafted between records under one key | `tests/adversarial.test.mjs` | `events cannot be swapped between records signed by the same key` |
| Events cannot be reordered or dropped | `tests/adversarial.test.mjs` | `reordering or dropping an event breaks the chain` |
| A program cannot forge an entry by printing one | `tests/adversarial.test.mjs` | `a program cannot forge an event by printing one` |
| Refusals are recorded in full, never sampled | `tests/adversarial.test.mjs` | `every refusal is recorded, not sampled` |
| A failed run still yields a verifiable record | `tests/adversarial.test.mjs` | `a failed run still produces a verifiable record with its refusals` |
| Replay is exact | `tests/adversarial.test.mjs` | `the same program and seed produce the same record` |
| Budgets cannot be escaped or outlived | `tests/adversarial.test.mjs` | `nothing a program can write takes the host down` |
| Matching is linear, so patterns cannot hang the host | `tests/adversarial.test.mjs` | `a catastrophic pattern stays linear from inside the language` |
| Hostile input is refused rather than overflowing the host | `tests/adversarial.test.mjs` | `deeply nested input is refused rather than overflowing the host` |
| The FFI boundary refuses an undeclared caller | `tests/ffi.test.mjs` | `a function that did not declare ffi cannot open the boundary` |
| Crossing the FFI boundary is recorded | `tests/audit.test.mjs` | `crossing the FFI boundary is recorded` |

One of those rows exists because the attack worked. `the specific lie that used
to work is caught` is a regression test: a signed record could have
`authority.granted` edited from `["fs","net"]` to `[]` and still verify as
intact, because the hash anchor covered five named header fields while the
summary sections had been added underneath it later. The summary could lie with
the signature holding, which is the only failure that matters for a record whose
whole purpose is to be checked by someone who does not trust its producer. The
anchor now names what it *excludes*, so a section added tomorrow is covered by
default rather than by somebody remembering.

If you are reviewing Smarsh, `tests/adversarial.test.mjs` is the fastest way in.
Every test in it was written by picking a claim this file makes and trying to
make the runtime say something false.

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
