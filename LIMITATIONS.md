# Limitations

Everything known to be wrong, missing, or weaker than it sounds. Kept in the
repository rather than in someone's head, because a limitation nobody wrote down
becomes a surprise for whoever finds it first.

Ordered by how likely it is to bite you.

---

## 1. Correctness surprises

Things that behave in a way a reasonable person would not predict.

### `let` freezes shared structure, including through an alias

```smarsh
var xs = [1, 2]
let ys = xs        // freezes the list itself
xs.push(3)         // ImmutableError, even though xs is a var
```

`let` freezes the *value*, and `xs` and `ys` are the same value. Binding
something with `let` therefore reaches back and freezes it everywhere. This is
consistent, and it is not what most people expect. Rust solves this with
ownership; Smarsh does not have ownership.

`smarsh check` now reports both shapes before the program runs (E0203), naming
the `let` that did the freezing. It only speaks when the value is a list or map
written as a literal — a context window, a ledger or an agent bound with `let`
is a live handle that `freezeDeep` leaves alone, and reporting those was a real
false positive found by running the checker over the examples.

**Workaround:** copy before binding — `let ys = xs.slice(0, xs.len())`.

### A record is only as immutable as what you put in it

```smarsh
var items = [1]
let h = Holder(items)
items.push(2)          // h.items is now [1, 2]
```

Record *fields* cannot be reassigned, but a mutable list handed to a constructor
stays mutable through the original binding. Records are shallowly immutable.

### Type errors do not stop a run

`smarsh check` reports them; `smarsh run` executes anyway. A program with a proven
type error still runs until the value actually misbehaves at runtime. This is
deliberate for a gradual system but it means `run` is not a gate.

**Workaround:** run `smarsh check` in CI. It exits non-zero.

### Determinism is per-version, not forever

The same seed replays identically within a version. Changing the PRNG or the
order of draws is not a breaking change, so a seed does not reproduce across
versions. Anything using replay as audit evidence must pin the version.

### A `using` grant is spent on entry

If the block fails, the use is still consumed. Conservative on purpose, and
surprising if you expected transactional semantics.

---

## 2. The verifier

`smarsh verify` is real but narrow. What it cannot do matters as much as what it
can.

### No interprocedural reasoning — the biggest gap

A call is an opaque value. The verifier does **not** use a callee's contract at
the call site:

```smarsh
fn callee(n) requires n > 0 ensures result > n { return n + 1 }
fn caller(n) requires n > 0 ensures result > 1 { return callee(n) }
//  -> undecided, even though callee's own contract makes it obvious
```

Dafny does this and it is the single largest thing standing between Smarsh's
verifier and usefulness on real code. Anything built from function calls is
undecidable to it today.

### Only linear arithmetic over rationals

No non-linear products, no bitvectors, no arrays or sequences, no strings, no
quantifiers, no uninterpreted-function congruence. Everything else becomes an
unconstrained variable.

### No integer type, so no integrality reasoning

`i > 0` does not yield `i >= 1`, because `num` is a float and `0.5` is a
counterexample. Loops that are obviously terminating over integers are not
provable. This is *correct* — it is a consequence of the numeric tower, not a
solver bug — but it makes many natural loops undecidable.

### Float rounding is not modelled

Literals become the exact double the machine holds, which stops the verifier
proving `0.1 + 0.2 == 0.3`. But it treats *operations* as exact rational
arithmetic, so it does not model per-operation rounding. A proof about `num`
is a proof about exact arithmetic on exactly-represented inputs, not about IEEE
semantics end to end. Reasoning about `dec` is exact, because `dec` is exact.

### No counterexample values

A refutation says "there is an input for which this does not hold" and does not
say which. The solver knows the constraint system is satisfiable but does not
extract a model. `smarsh prove` gives you concrete inputs; `verify` does not.

### Hard caps, silently reached

- 64 paths per function, then the whole function is undecided
- 24 atoms per verification condition
- 4000 Fourier-Motzkin terms
- 6 disequalities per assignment

Fourier-Motzkin is doubly exponential in the worst case. These caps are why it
terminates.

### No frame conditions

There is no `modifies` clause, so the verifier cannot reason about what a
statement leaves alone.

### **A correction to the README**

The README says no other language verifies "functional contracts, information
flow, capability sufficiency and termination in one pass." That is an overclaim
and it is mine.

`smarsh verify` does contracts and termination. `smarsh check` does information flow
and races, in a *different engine*, with a different algorithm. They are one
toolchain, not one pass — the taint analysis is not part of the verification
condition system and cannot use its solver. Unifying them is real work that has
not been done.

---

## 3. Performance

- **Still an interpreter, just a much faster one.** The AST compiles to
  JavaScript closures rather than being re-walked (`src/compile.js`), and a call
  in the common shape allocates nothing: the frame is reused, arguments travel
  positionally, bound methods are remembered, contracts compile. About
  **3.2–3.4× CPython** and **~32× a JIT** on `fib`, from 6.7× and ~110×; the
  eleven-shape workload suite is 44% faster than at the start of that work. Closing more needs a typed value
  representation and escape analysis so `t = t + i` does not box — a larger
  change than any of this was. `--engine tree` still runs the original
  tree-walker, and CI proves the two agree on every example, every std module
  and 3,000 generated programs.
- **The fast call path is a second implementation of calling.** `callSimple`
  handles a named function with no capabilities and no contract; `callValue`
  handles everything else and is what the tree-walker uses. Two paths can drift,
  and the only thing stopping them is that the differential harness runs one
  against the other on every program it has.
- **The recursion limit is 300 frames**, and low on purpose. It used to be 2000,
  which no run ever reached: both engines exhausted the host JavaScript stack
  first, so the real limit was however many host frames happened to be free —
  measured at 422 on one run and 652 on another, on the same machine. A language
  that signs a manifest claiming a run replays from its seed cannot have a
  recursion limit that is a property of the machine. Raising it means using
  fewer host frames per call, not raising the number.
- **Agents are single-threaded and cooperative.** An agent runtime that cannot
  use more than one core for agent logic is architecturally limited for the
  workload it is pitched at.
- **`fork` is sequential.** Isolation and independent randomness are real; the
  parallelism is not.
- **Worker threads back matrix multiply only**, at about 1.5× on three threads.
- **Method access allocates on the first use of each method per object.**
  `xs.push` builds a function bound to `xs`; it is remembered against `xs`
  afterwards, so a loop pays once rather than once per iteration. Records skip
  the cache entirely, since their members are fields rather than methods.
- **No incremental anything** — every tool reparses the whole file.

---

## 4. Type system

- **No generics.** `list<num>` is checkable but there are no type variables, so
  you cannot write a function generic in its element type and have it checked.
- **No union or optional types.** Nullability is not tracked; `nil` is `dyn`.
- **No flow-sensitive narrowing.** Testing `if type(x) == "num"` teaches the
  checker nothing.
- **Exhaustiveness is syntactic, not type-directed.** `choice` gives closed sets
  and `smarsh check` reports a `match` that misses a variant, but it works off
  the arms rather than off an inferred type for the subject. So it says nothing
  when the arms span two choices, when a variant name belongs to more than one
  choice, or when there is a wildcard. It also cannot report an *unreachable*
  arm — matching the same variant twice is silently accepted. A type-directed
  version would catch all of those; this one catches the case that actually
  bites, which is a forgotten variant.
- **No subtyping, no interfaces, no traits.**
- **Local inference only.** No Hindley-Milner, no inference across statements.
- **Capabilities are not in the type system.** `smarsh check` now reports a
  function that uses authority it did not declare (E0406), so the common case
  is caught before the program runs — but it works off direct calls to a
  name, not off types. A call through a value, a method on an object, or a
  capability held inside a `using` block is invisible to it, and a function's
  type still does not mention its effects.

---

## 5. Security

- **The regex engine has no backreferences, lookaround, or lazy quantifiers.**
  That is the price of the linear-time guarantee, not an unfinished corner:
  backreferences make matching NP-hard, and lookaround is where a careless
  addition loses the bound. If you need them, this is the wrong engine.
- **Case-insensitive matching folds ASCII only.** Full Unicode case folding is a
  table this project will not carry, and a half-implemented version would be
  worse than an honest limit.
- **An HTTP request blocks the thread it is on.** The interpreter is
  synchronous, so `http_get` parks the calling thread in `Atomics.wait` while a
  worker performs the fetch. Nothing in Smarsh notices, but a Node application
  embedding this interpreter *on the same thread as its own HTTP server* will
  deadlock: the server cannot answer while the thread is parked, and the request
  times out looking exactly like a slow network. Embed it on a worker if the
  host process also serves.
- **Redirects are not followed, on purpose.** A 302 can move a request to a host
  the run was never permitted to reach, which would make `--allow-host`
  decorative. Programs get the 3xx and its `Location` and decide, and that
  decision goes through the allowlist like any other request.
- **`--allow-host` matches hostnames, not URLs.** A run permitted to reach
  `api.example.com` may reach any path and any port on it. Path-level or
  method-level restriction is not implemented.
- **`unaudited_crypto` stays hand-rolled, and here is why.** There is no audited
  JavaScript Paillier implementation to move to; the available packages are
  unaudited too, so adopting one would trade this code for someone else's
  unaudited code plus a supply-chain dependency, in a project that currently has
  none. `@noble/curves` is audited but implements EC Schnorr over secp256k1,
  which is a different group and a different API from the finite-field
  construction here. The honest position is that these primitives are behind
  their own capability, are documented as unreviewed, and should not be used for
  anything that matters.
- **`unaudited_crypto` is unaudited and not constant time.** BigInt arithmetic
  in JavaScript leaks timing. Quarantined behind its own capability; still not
  safe against an adversary who can measure you.
- **`ffi` is still an escape, but a named one.** Granting it opens nothing on
  its own: `--foreign node:path` says where the boundary may be crossed, and
  the run record states what was permitted rather than only what was used, so
  a run that loaded one harmless module while allowed to load anything is
  distinguishable from one that could not. `--foreign '*'` is the old
  behaviour, stated explicitly and marked UNBOUNDED in the manifest.
  Inside a permitted module every guarantee is still gone: there is no
  membrane, so a value handed across can be retained and mutated by host code
  the runtime cannot see.
- **No host sandbox.** Capabilities bound what Smarsh code reaches, not what the
  process can do. `fs` is scoped to the program directory and that is all.
- **`budget memory N` is an estimate, not a measurement.** It charges a fixed
  number of bytes per allocating operation — list literals, `.push`, `map.set` —
  and stops the block once the total passes the ceiling. It does not read the
  host heap: a run whose outcome depended on the machine's actual memory would
  not replay, and replay is what the audit manifest rests on. So it bounds
  runaway growth in the operations it knows about, and a program that grows
  memory some other way — deep recursion building closures, one very long
  string, a tensor allocated in a single step — is not covered. Outside a
  `budget` block there is no ceiling at all.
- **The integrity half only sees labelled values.** `vouched_by` refuses a value
  that lost its backing, which is the case a boolean flag cannot catch. It does
  not refuse a value that never carried a label at all — a plain literal has no
  vouch and is not meant to. For "this came from outside and has not been
  checked", the block is `grounded`, and the two are deliberately separate.
- **A vouch is lost by any arithmetic with an unlabelled operand**, `x * 2`
  included. That is the conservative direction and it is intended, but it means
  code that mixes vouched and plain data needs an explicit `endorse` or
  `retract` at each point rather than carrying backing through silently.
- **No label inference or polymorphism.** Every label is written by hand.
- **Static taint is a may-analysis** with crude interprocedural summaries. It
  errs toward reporting, which is the right direction, but it will flag
  unreachable paths.
- **Membranes are not implemented.** Caretakers and attenuation are; transitive
  wrapping of everything crossing a boundary is not.
- **Agent isolation does not cover values passed in.** An agent cannot write
  outer bindings, but it can mutate a mutable structure it was handed.

---

## 6. Missing language features

No async or promises. No iterators or generators. No traits, interfaces or
protocols. No operator overloading for user types. No
destructuring in `let`. No spread or rest. No default or named arguments. No
varargs for user functions. No tail calls, and recursion is depth-limited. No
regex. No date or time type. No JSON in the standard library. No streaming or
partial file IO — `read` and `write` handle whole files only. No networking.

---

## 7. Tooling

- **No LSP.** No autocomplete, no go-to-definition, no inline diagnostics. This
  is the single largest adoption blocker after the ecosystem.
- **No debugger.** No breakpoints, no stepping, no inspection.
- **No package manager or registry.** `import` is relative paths and `std/`.
- **The formatter does not wrap long lines.** A 200-character expression stays
  200 characters.
- **No editor syntax highlighting** definitions of any kind.
- **The REPL is line-based** — no multiline editing, no persistent history.
- **The test runner** has no filtering, no parallelism, no watch mode, and does
  not exercise contracts in imported modules, only in the entry file.
- **`--profile` prints a table**, with inclusive time only. No flamegraph, no
  allocation profile.
- **The bundler is bespoke** and handles this codebase, not JavaScript generally.
- **No coverage tooling for `.smarsh` code** — the coverage figures below are of
  the interpreter, not of programs written in Smarsh.
- **The fuzzer is grammar-based, not coverage-guided.** See §10.

---

## 8. Architecture

- **`interpreter.js` is a god object** at 2,015 lines, doing evaluation,
  capabilities, taint, agents, transactions, devices, modules, redefinition,
  contracts and budgets. It should be several files. It grows every time
  anything is added, which is the tell.
- **238 builtins and methods against 86 standard-library functions.** The
  breadth is welded into the runtime where Java's equivalent is in replaceable
  libraries, so none of it can be versioned, swapped, or deprecated without
  breaking the language.
- **40 keywords.** Go has 25.
- **13% of branches in `src/` are untested**, which is where the next defects
  are. `src/` overall is 94.4% of lines and 86.6% of branches; the weak spots
  are `prove.js` (57.8% of lines), `tensor.js` (82.1%) and `verify.js` (74.4% of
  branches). Note that the headline figure `node --test` prints is around 63%,
  because the run writes generated bundles and FFI fixtures into temp
  directories and counts them as source — the number to read is `src/`.
- **The CLI itself is barely covered.** `bin/smarsh.mjs` is exercised end to end
  by CI, not by unit tests, so its argument handling had a real defect
  (repeated `--grant` discarding all but the last) that no test would have
  caught.

---

## 9. Things whose names still flatter them

- **The quantum simulator** is a simulator: 22 qubits, no noise model, no
  hardware. Correct statistics, no speedup, and none is possible.
- **`energy()`** is a disclosed cost model, not a measurement. Nothing reads a
  power rail.
- **Lineage** is cryptographic, not hardware-enforced. It proves who asserted
  each step, not anything about a machine you do not control.
- **`distill()`** is a structural digest. It never calls a model, so it never
  invents anything — and it is not semantic.
- **Token counts** are a deterministic estimate, within roughly 10–15% of BPE on
  prose, not a real vocabulary.
- **Logical clocks** give a total order with no drift because they never read a
  wall clock. They cannot correlate with human time.

---

## 10. Process

Zero users. No third-party audit. One maintainer. Not published. No formal
language specification — `docs/reference.md` is a description, not a spec, and
there is no conformance suite.

**On the fuzzing.** `npm run fuzz` generates programs and asserts the runtime
never surfaces a raw JavaScript error. It is worth being precise about what that
does and does not establish. The generator is a fixed grammar of hand-written
fragments, not a coverage-guided fuzzer: it has no feedback loop, does not
mutate toward new paths, and cannot discover syntax nobody thought to list. Of
150,000 generated programs, about 22% run to completion and 43% stop at a syntax
error, so the parser is fuzzed considerably harder than the evaluator. It found
one real defect on its first serious run — control-flow signals escaping as bare
JavaScript objects — and has found nothing since, which is weak evidence of
robustness and strong evidence that the generator has stopped saying anything
new. A coverage-guided fuzzer over the real grammar would be worth more than
another decimal place on the case count.

---

## What this list is for

Every item here is either a known defect, an unbuilt capability, or a name that
needs qualifying. None of it is hidden in the code.

If you find something that belongs on this list and is not on it, that is a bug
report worth filing — the list being incomplete is itself a defect.
