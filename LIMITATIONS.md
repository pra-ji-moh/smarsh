# Limitations

Everything known to be wrong, missing, or weaker than it sounds. Kept in the
repository rather than in someone's head, because a limitation nobody wrote down
becomes a surprise for whoever finds it first.

Ordered by how likely it is to bite you.

---

## 1. Correctness surprises

Things that behave in a way a reasonable person would not predict.

### `let` freezes shared structure, including through an alias

```pedag
var xs = [1, 2]
let ys = xs        // freezes the list itself
xs.push(3)         // ImmutableError, even though xs is a var
```

`let` freezes the *value*, and `xs` and `ys` are the same value. Binding
something with `let` therefore reaches back and freezes it everywhere. This is
consistent, and it is not what most people expect. Rust solves this with
ownership; Pēdāg does not have ownership.

**Workaround:** copy before binding — `let ys = xs.slice(0, xs.len())`.

### A record is only as immutable as what you put in it

```pedag
var items = [1]
let h = Holder(items)
items.push(2)          // h.items is now [1, 2]
```

Record *fields* cannot be reassigned, but a mutable list handed to a constructor
stays mutable through the original binding. Records are shallowly immutable.

### Type errors do not stop a run

`pedag check` reports them; `pedag run` executes anyway. A program with a proven
type error still runs until the value actually misbehaves at runtime. This is
deliberate for a gradual system but it means `run` is not a gate.

**Workaround:** run `pedag check` in CI. It exits non-zero.

### Determinism is per-version, not forever

The same seed replays identically within a version. Changing the PRNG or the
order of draws is not a breaking change, so a seed does not reproduce across
versions. Anything using replay as audit evidence must pin the version.

### A `using` grant is spent on entry

If the block fails, the use is still consumed. Conservative on purpose, and
surprising if you expected transactional semantics.

---

## 2. The verifier

`pedag verify` is real but narrow. What it cannot do matters as much as what it
can.

### No interprocedural reasoning — the biggest gap

A call is an opaque value. The verifier does **not** use a callee's contract at
the call site:

```pedag
fn callee(n) requires n > 0 ensures result > n { return n + 1 }
fn caller(n) requires n > 0 ensures result > 1 { return callee(n) }
//  -> undecided, even though callee's own contract makes it obvious
```

Dafny does this and it is the single largest thing standing between Pēdāg's
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
extract a model. `pedag prove` gives you concrete inputs; `verify` does not.

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

`pedag verify` does contracts and termination. `pedag check` does information flow
and races, in a *different engine*, with a different algorithm. They are one
toolchain, not one pass — the taint analysis is not part of the verification
condition system and cannot use its solver. Unifying them is real work that has
not been done.

---

## 3. Performance

- **A tree-walking interpreter.** About 1.9µs per function call, orders of
  magnitude off a JIT. A bytecode VM is the honest next step.
- **Agents are single-threaded and cooperative.** An agent runtime that cannot
  use more than one core for agent logic is architecturally limited for the
  workload it is pitched at.
- **`fork` is sequential.** Isolation and independent randomness are real; the
  parallelism is not.
- **Worker threads back matrix multiply only**, at about 1.5× on three threads.
- **`member()` allocates** a function object on some method-access paths.
- **No incremental anything** — every tool reparses the whole file.

---

## 4. Type system

- **No generics.** `list<num>` is checkable but there are no type variables, so
  you cannot write a function generic in its element type and have it checked.
- **No union or optional types.** Nullability is not tracked; `nil` is `dyn`.
- **No flow-sensitive narrowing.** Testing `if type(x) == "num"` teaches the
  checker nothing.
- **No sealed types, so no exhaustiveness checking** on `match`. A missing arm
  is a runtime `MatchError`, not a compile-time error. This is a real gap given
  that `Ok`/`Err` are separate record types with nothing tying them together.
- **No subtyping, no interfaces, no traits.**
- **Local inference only.** No Hindley-Milner, no inference across statements.
- **Capabilities are not in the type system.** They are checked dynamically and
  by a separate static pass; a function's type does not mention its effects.

---

## 5. Security

- **`unaudited_crypto` is unaudited and not constant time.** BigInt arithmetic
  in JavaScript leaks timing. Quarantined behind its own capability; still not
  safe against an adversary who can measure you.
- **`ffi` is a total escape.** Granting it leaves every guarantee behind.
- **No host sandbox.** Capabilities bound what Pēdāg code reaches, not what the
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
- **Only confidentiality labels.** The decentralized label model has integrity
  labels too; Pēdāg implements the confidentiality half.
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
protocols. No sum types or enums. No operator overloading for user types. No
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
- **No coverage tooling for `.pedag` code** — the 94% figure is coverage of the
  interpreter, not of programs written in Pēdāg.
- **The fuzzer is grammar-based, not coverage-guided.** See §10.

---

## 8. Architecture

- **`interpreter.js` is a god object** at roughly 1,900 lines, doing evaluation,
  capabilities, taint, agents, transactions, devices, modules, redefinition,
  contracts and budgets. It should be several files.
- **238 builtins and methods against 86 standard-library functions.** The
  breadth is welded into the runtime where Java's equivalent is in replaceable
  libraries, so none of it can be versioned, swapped, or deprecated without
  breaking the language.
- **40 keywords.** Go has 25.
- **About 20% of interpreter branches are untested**, which is where the next
  defects are.

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
