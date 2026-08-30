# Capabilities, and where their names flatter them

Smarsh covers a wide surface: agent runtime, information flow, contracts,
cryptography, exact decimals, quantum simulation, device backends. Breadth
invites the reasonable suspicion that some of it is thin.

So this is the accounting. Each subsystem, what it actually does, and - where
the name promises more than the implementation delivers - exactly what the gap
is. Nothing here is hidden in the code, and several entries exist to stop a
name being read as more than it is.

The numbers are internal identifiers for each area, kept so that issues and
commits can refer to them unambiguously.

See also [LIMITATIONS.md](../LIMITATIONS.md), which covers defects and missing
capabilities rather than overstated ones.

## Shipped and working

| # | Feature | How it landed |
|---|---|---|
| 2 | Non-deterministic control flow | `maybe p {}`, `choose {}`, seeded and replayable |
| 7 | Semantic error trapping | `requires` / `ensures` - executable intent, checked at the boundary |
| 8 | Asynchronous mind-forking | `fork n {}`, isolated scope + independent random stream per path |
| 9 | Vector math first-class | `tensor`, `@`, broadcasting, `softmax`/`relu`/`dot`/`cosine` |
| 11 | Hallucination sandboxing | `ungrounded()` + `grounded {}` blocks |
| 12 | Token-based memory accounting | `tokens()`, per-entry accounting on every context |
| 14 | Cross-border regulatory type-checking | `restrict()` + `region "xx" {}` |
| 15 | Immutable ledger primitives | `ledger()`, hash-chained, `verify()` detects tampering |
| 1 | Native context-window memory | `context(budget)` with eviction and pinning |
| 4 | Real-time state distillation | `distill()` - deterministic structural digest |
| 35 | Data-sovereignty tainting | same label engine as #14, per-variable, propagating |
| 37 | Adversarial input isolation | `untrusted()` + taint reaching a sink |
| 40 | Capability-based access control | `needs`, deny-by-default, real attenuation |
| 43 | Compiler-driven synthetic test generation | `smarsh prove` |
| 34 | Homomorphic encryption runtime | Paillier; `+`, `-`, `*`-by-plaintext on ciphertexts as ordinary operators |
| 21 | Zero-knowledge math integration | Schnorr proofs and Pedersen commitments over a verified 2048-bit group |
| 38 | Cryptographic provenance | Ed25519 `sign` / `verify_signature`, no third-party package |
| 17 | Data lineage | `lineage()` - hash-chained *and* per-step signed; see the caveat below |
| 39 | Ephemeral secret shredding | `secret { }` scopes, zeroed buffers, secrets never print |
| 18 | Atomic cross-ledger execution | `atomic { }`, all-or-nothing, correctly nested |
| 31 | Quantum-classical hybrid | State-vector simulator, seeded and replayable |
| 42 | Deterministic distributed timestamps | Logical clocks - a total order with no wall clock to drift |
| 20 | Dynamic liquidity typings | `liquid(value, halflife)`, decay on logical time |
| 5 | Agent-to-agent primitives | `agent` / `spawn` / `send`, private state, enforced isolation |
| 33 | Autonomous kill-switch | `budget steps N { }` - not raisable or catchable from inside |
| 44 | Deep observability | `--profile`: calls, steps and inclusive time per function, no instrumentation |
| 19 | Predictive race blocking | `smarsh check` finds shared writes across forked paths before running |
| 25 | Dynamic kernel slicing | matmul split across OS threads over SharedArrayBuffers |
| 26 | Race safety at the slicing level | each thread owns a disjoint band of output rows, so collisions are impossible by construction |
| 27 | Memory eviction instead of crashing | `arena(bytes, dir)` spills least-recently-used tensors to disk and reads them back |
| 3 | Large immutable weights | `weights(file, shape, dtype)` pages rows from disk; the file never becomes resident |
| 6 | Safe self-modifying code | `redefine`, validated against shape, capabilities and inherited contracts |
| 10 | Execution graph recompilation | the call graph is rederived on every redefinition; `dependents()` says what is affected |
| 41 | Zero-downtime hot swap | `redefine on Agent.msg` reaches live agents with their state intact |
| 47 | Stateful migration | `snapshot()` / `restore()` move values, agents, mail and the RNG position |
| 36 | Leak detection | `watch()` / `leaks()` report structures that grew at every sample |
| 48 | Self-documenting API evolution | `schema` / `negotiate` / `adapt` - structural, no version strings |
| 22 | Live re-typing | `migrate()` reshapes records in memory through the same path as the wire |
| 46 | Binary-level de-duplication | modules are cached by content hash, so identical files are one instance |
| 16 | Macro and micro in one block | `schedule` / `simulate` - one event queue, any mix of timescales |
| 49 | Cost-aware compilation | `energy()` with a disclosed weight table |

Caveats that matter, and none of them are hidden in the code:

- **#1** is a bounded token-accounted buffer, not an LLM context addressed as
  RAM - no model is attached.
- **#4** is structural, not semantic. It never calls a model, so it never
  invents anything.
- **#12** uses a deterministic token estimate (within roughly 10-15% of BPE
  counts on prose), not a real vocabulary.
- **#7** checks stated intent. It does not read minds.
- **#37** is now checked statically as well as at runtime - `smarsh check` reports
  a labelled value reaching a sink on any path.
- **Lineage** is the achievable half. The chain proves *who
  asserted each step* and that the sequence has not been edited, reordered or
  truncated. It cannot prove anything about hardware, or about a byte that
  crossed a machine you do not control. "Cryptographic lineage", not
  "hardware-enforced".
- **#31** is a simulator. Superposition, entanglement, interference and
  measurement statistics are all real; the speedup is not, and cannot be.
- **#42** achieves drift-free ordering by not using wall clocks at all. If you
  need to correlate with human time you need `now()` and the `clock`
  capability, and those readings do drift.
- **#34** is additively homomorphic only. Fully homomorphic encryption exists
  but is thousands of times slower and is not what this ships.
- Paillier, Schnorr and Pedersen are **unaudited and not constant time**. They
  sit behind their own capability for that reason, and a modulus under 2048 bits
  is recorded in the run trace. Do not put them in front of an adversary who can
  measure you.
- Taint analysis is a may-analysis. It reports what *can* happen, so it can
  report a path that is unreachable for a reason it cannot see. It will not stay
  quiet about a path that is reachable.
- **#5** is in-process. Agents are isolated, message-passing and deterministic,
  which is the semantic content of the feature - but they share one thread, and
  there is no cross-machine transport yet. "Socket protocols between machines"
  is not done.
- **#19** is a single static check (shared writes from forked paths) plus arity.
  It is not a general race detector, and it says nothing about market
  front-running, which is not a property a compiler can see.
- **#44** reports inclusive time, so a caller's number contains its callees'.

## Shipped, but narrower than the name suggests

These work. The gap between what they do and what their name implies is named
here rather than blurred.

| Area | The ambition | What ships | The gap |
|---|---|---|---|
| 23 | CPU/GPU unified memory | `device "x" { }` blocks; one syntax, backend chosen at the block | Backends are `cpu` and `workers`. No GPU, so no host/device transfer to elide. |
| 24 | NVIDIA / AMD / ASIC from one source | a backend registry a new backend plugs into | Nothing implements a GPU backend. A registry with no GPU in it is a seam, not silicon agnosticism. |
| 28 | Silicon topology awareness | real core count, model, clock, memory, load | No NUMA distances, no cache hierarchy, no interconnect map. Node cannot see them. |
| 29 | Asymmetric compute pipelining | small jobs stay on the calling thread, large ones go wide | Routing by size, not by matrix-core vs general-core. There is no second core type to route to. |
| 50 | one universal native binary | `smarsh build` → one `.mjs`, no dependencies, no install | It needs Node. Universal binaries are per-target builds in a wrapper; this is the honest version of the idea. |
| 13 | deterministic nanosecond GC | `arena.reclaim()` - you choose the moment, and it reports the pause it caused in nanoseconds | Not a collector, and not pause-free. It measures the pause instead of promising there isn't one. |

## Not achievable on this runtime

- **#30 Thermal-aware clock throttling.** No portable way to read die
  temperature from a runtime. `pressure()` reports CPU load and free memory,
  which is what is actually observable - it is not a thermal reading, and it is
  not named as one.
- **#32 On-chip interconnect primitives.** Addressing a chip-to-chip bridge
  needs a driver, not a language.
- **Infinite horizontal elasticity.** A
  language cannot conjure servers. `snapshot`/`restore` is the migration half;
  the provisioning half is somebody's infrastructure either way.
- **#17's "hardware-enforced" half.** The signed, hash-chained lineage above is
  the achievable part; see the caveats.

The honest summary of what stays out of reach on Node: anything that must
address a GPU, an ASIC, or a thermal sensor directly. Everything else on the
list either works or works smaller, and the difference is written down.

---

