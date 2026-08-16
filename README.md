# Sarvm

A programming language for programs that reason under uncertainty and have to
be held accountable for it.

Java and Python assume the program knows what it is doing: a condition is true
or false, a value is just a value, and a function may do anything it can reach.
Sarvm assumes none of that. A branch can be probabilistic. A value carries where
it came from. A function holds only the powers it declared. A function that
promises something gets checked against generated inputs.

It runs today: a real interpreter in dependency-free JavaScript, with 387
passing tests.

**New here?** [docs/getting-started.md](docs/getting-started.md) — twenty
minutes, assumes nothing.

> **Status: 0.3.0, pre-1.0, no production users.** Pin an exact version
> ([VERSIONING.md](VERSIONING.md)). The hand-rolled cryptography has never been
> audited and is not constant time ([SECURITY.md](SECURITY.md)).

```bash
node bin/sarvm.mjs run examples/tour.sarvm
```

```bash
node bin/sarvm.mjs prove examples/contracts.sarvm
```

```bash
node --test tests/*.test.mjs
```

Other commands: `sarvm check <file>` (types and static checks, without running),
`sarvm explain E0301`, `sarvm build`, `sarvm repl`, `sarvm eval "<source>"`. Flags:
`--seed N`, `--grant fs,clock,crypto`, `--trace`, `--profile`, `--trials N`.

**Speed.** `node bench/run.mjs` runs the benchmark suite. The optimisation pass
took it from 1037 ms to about 700 ms (~1.5×) by removing per-call and per-block
allocations. It is an optimised tree-walker and it is still orders of magnitude
off a JIT — Java is not in reach here, and a bytecode VM is the honest next step
rather than more micro-tuning. A later pass of micro-optimisations produced no
measurable change at all and was reverted; run-to-run variance on this hardware
is about 5%, and a change inside the noise is not an improvement.

---

## What it is like to be wrong in Sarvm

The thing a language is judged on is not its best day, it is what happens when
you make a mistake. So:

```
error[E0201]: `totl` is not defined
 --> tally.sarvm:6:10
  |
6 |   return totl
  |          ^^^^ not found in this scope
  |
help: there is a name in scope with a similar spelling: `total`
  run `sarvm explain E0201` for a longer explanation
stack:
  at tally (tally.sarvm:6)
  at report (tally.sarvm:10)
  at <top level> (tally.sarvm:13)
```

Exact spans, a suggestion that accounts for transposed letters, an error code
with a real explanation behind it, and a stack. The phrasing rules come from
rustc's diagnostic guide — lowercase, backticked identifiers, `help:` only for
things you can act on, and one message per problem.

And a lot of it arrives before the program runs at all:

```
error[E0301]: expected `num`, found `str`
 --> orders.sarvm:6:6
  |
6 | area("3", 4)
  |      ^^^ argument 1 of `area`
  |
help: `num(x)` reads a number out of text

error[E0302]: `area` takes 2 arguments, but 1 was supplied
 --> orders.sarvm:7:1
  |
7 | area(3)
  | ^^^^^^^ 1 supplied
  |
note: its type is `fn(num, num) -> num`
```

## Types, if you want them

```sarvm
fn area(width: num, height: num) -> num { return width * height }
fn total(prices: list<num>) -> num { ... }
let rate: num = 1.08
```

Sarvm is **gradually typed**, following Siek and Taha: there is a type `dyn` for
"not known statically", and the checker uses a *consistency* relation rather
than equality, under which `dyn` is consistent with everything. That single
choice is what keeps annotations optional instead of viral — a program with no
annotations has every expression at `dyn`, is consistent everywhere, and reports
nothing. Every example in this repository type-checks clean, and most of them
have no annotations at all.

Where you do annotate, you are held to it. Inference is local and bidirectional
rather than full Hindley-Milner: literals, operators, list and map literals,
`let` initialisers and returns propagate upward, annotations flow down. That is
a real limitation, chosen deliberately — the failure mode of local inference is
missing a bug, and the failure mode of aggressive inference is inventing one. In
a gradual system the second is much worse.

## Records, matching, interpolation

```sarvm
record Point(x, y)

let a = Point(3, 4)
print("${a} and ${a.with("x", 10)}")     // records are immutable

fn describe(p) {
  return match p {
    Point(0, 0)             => "the origin",
    Point(0, y)             => "on the y axis at ${y}",
    Point(x, y) when x == y => "on the diagonal at ${x}",
    Point(x, y)             => "somewhere at ${x}, ${y}",
    _                       => "not a point at all"
  }
}
```

Records compare by value, so two points at the same coordinates are the same
point. Patterns destructure them, guards refine an arm, and a value that matches
nothing says so rather than returning nil.

`record` is a **contextual** keyword — `record Name(` is a declaration, and the
word is an ordinary identifier everywhere else. Java made the same call for the
same reason, and this repository's own agent tests, which have a handler called
`record`, are why it was noticed here.

## Money is exact, and floats are not allowed near it

```sarvm
let price = dec("12.50")
print(price * 3)                       // 37.50, exactly

dec("0.1") + dec("0.2") == dec("0.3")  // true
0.1 + 0.2 == 0.3                       // false — `num` is a float and says so
```

`dec` is an integer coefficient and a scale, backed by BigInt: no upper bound,
no rounding you did not ask for. A thousand additions of `dec("0.01")` is
exactly `10.00`. Division states its scale and rounds half-to-even.

Decimals do not mix with floats implicitly, and that refusal is the feature:

```
error[E0301]: cannot mix `dec` with the float `0.1`; that would put a rounding
              error into exact arithmetic
help: write it exactly: `dec("0.1")`
```

An integer literal past 2^53 is refused at parse time rather than silently
rounded — `9007199254740993` is a syntax error that points you at `dec`.

## `let` means immutable, all the way down

```sarvm
let xs = [1, 2]
xs.push(3)          // ImmutableError: bound with `let`, which freezes it
var ys = [1, 2]
ys.push(3)          // fine
```

Blocking rebinding while leaving the contents writable is the weaker guarantee
people assume they are getting and are not. The freeze is deep: `let deep = {
"xs": [1] }` refuses `deep["xs"].push(2)` as well.

## Taint is checked over every path, not just the one you ran

```sarvm
fn maybe_taint(flag) {
  if flag { return ungrounded(model_output) }
  return "a checked constant"
}
let value = maybe_taint(false)
grounded { print(value) }
```

This program *runs* clean — the tainted branch was not taken. `sarvm check`
reports it anyway:

```
error[E0403]: a value labelled `ungrounded` can reach this grounded block
note: this is every path, not only the one a run took
```

Labels propagate through call chains, collections, string interpolation and
branch merges. It is a may-analysis, deliberately conservative: where it cannot
follow a value it assumes the worst rather than assuming safety.

When a violation is intentional, you say so in the source, and the summary
counts it:

```sarvm
// sarvm-allow: taint  (deliberate -- this section demonstrates the refusal)
grounded { print(reply) }
```

```
examples/tour.sarvm: no problems found (2 suppressed by sarvm-allow)
```

## Unaudited cryptography is quarantined

Two capabilities, not one. `crypto` covers what delegates to the platform —
Ed25519, SHA-256, OS entropy. `unaudited_crypto` covers Paillier, Schnorr and
Pedersen, which are implemented here in BigInt.

Those three are correct as far as the test suite can establish, and the group
parameters are re-derived rather than trusted. But **BigInt arithmetic in
JavaScript is not constant time, so they leak timing information and are exposed
to side-channel attack, and they have had no third-party audit.** Holding
`crypto` does not reach them. A deployment can take the platform primitives and
refuse the rest, and the grant appears in the run's configuration where a
reviewer will see it.

## The run leaves a record it cannot rewrite

This is the part Java structurally cannot do, and it is the reason the rest of
the language exists.

```bash
sarvm run agent.sarvm --grant fs --principal compliance --audit run.json --sign
sarvm audit run.json
```

```
run of examples/regulated.sarvm  (sarvm 0.3.0, outcome: completed)
  program sha256   02d2859c794440679c593e86a0b6d06f...
  replay with      --seed 0 --grant fs

  authority
    granted        fs
    actually used  fs
  data
    released       0 permitted, 1 refused
    taint cleared  1

  events worth a reviewer's attention
    line 22   taint.cleared           "reviewed and confirmed by analyst 12"
    line 73   data.release_refused    marketing
    line 110  authority.delegated     fs
    line 118  authority.revoked       fs

INTACT — every event hashes onto the one before it
         and the head is signed by 2f7f8187eefb18c5
```

A compliance reviewer does not run a language. They read a document, and they
need to know it was not written afterwards by the party being reviewed. Delete
the inconvenient line and `audit` says so:

```
ALTERED — this record does not describe the run it claims to
  event 1 does not follow the one before it
  the signature covers the recorded head, but the events no longer
  produce that head: the record was signed and then edited
```

Every effect passes through a single capability check, so the record is
complete rather than best-effort — including **refusals**, which is the run a
reviewer most wants to see. It also names authority that was granted and
demonstrably never used, which is the line that gets a permission withdrawn.

None of this is instrumentation you add to your program. The runtime already
had to know all of it in order to enforce the rules; the manifest is what stops
it being discarded when the process exits. That is the structural difference:
Java has no capability check to record, no label to observe, and no seed that
makes the run reproducible — so there is nothing for a Java equivalent to write
down, however carefully it is written.

See [examples/regulated.sarvm](examples/regulated.sarvm) for the whole thing.

## Proving, not testing

```bash
sarvm verify examples/contracts.sarvm
```

```
  proved    abs_: abs_ keeps its promise
  proved    abs_: abs_ keeps its promise
  proved    clamp01: clamp01 keeps its promise
  REFUTED   scale: scale keeps its promise
  REFUTED   safe_div: safe_div keeps its promise
```

`sarvm prove` throws generated inputs at a contract. `sarvm verify` discharges it
as a theorem: **for every input, unbounded, with no sampling.** Two conditions
for `abs_` because there are two paths through it, and both are proved.

It follows the shape Dafny uses — [weakest preconditions to verification
conditions to a solver](https://www.cs.umd.edu/class/spring2025/cmsc433/code/VerificationConditions.pdf)
— except Sarvm has no dependencies, so it cannot pipe to Z3. It carries its own
decision procedure: exact BigInt rationals, Fourier-Motzkin elimination, and a
small DPLL search over the boolean structure. Loops produce four obligations —
the invariant is established, a pass preserves it, the variant stays at or above
zero, and the variant strictly decreases.

**Three answers, always distinguished: proved, refuted, or undecided.** Never a
proof by silence. Two properties make that trustworthy:

*It will not claim a refutation it cannot justify.* Anything the solver cannot
model — a non-linear product, a call — becomes an unconstrained variable. That
widens the models, which is sound for proving and unsound for refuting, so any
refutation resting on one is downgraded to `undecided`. `sarvm prove` still finds
those by testing; the two tools cover different halves and agree where they
overlap, which the test suite checks.

*It models the arithmetic that actually runs.* A float literal becomes the
number the machine holds — `0.1` is `3602879701896397/36028797018963968`, not
one tenth. A solver that read it as one tenth would cheerfully prove
`0.1 + 0.2 == 0.3`, which the runtime then falsifies. Reasoning about `dec` is
exact; reasoning about `num` does not model per-operation rounding, and says so.

**A caveat on the obvious claim to make here.** It is tempting to say no other
language verifies functional contracts, information flow, capability
sufficiency and termination together. Sarvm does check all four — but not in one
pass and not in one engine. `verify` does contracts and termination against the
solver; `check` does information flow, types and races with entirely different
algorithms. One toolchain, four analyses, no shared logic between them.
Unifying them is real work nobody has done here.

The largest gap in `verify` is that **a call is opaque**: it does not use a
callee's contract at the call site, so anything built out of function calls is
undecidable to it. Dafny does this, and it is what stands between this verifier
and usefulness on real code. See [LIMITATIONS.md](LIMITATIONS.md).

## Contracts that talk about before and after

Following [Eiffel](https://www.eiffel.org/doc/eiffel/ET-_Design_by_Contract_(tm),_Assertions_and_Exceptions):

```sarvm
record Account(holder, balance) invariant balance >= 0

fn withdraw(account, amount)
  requires amount > 0
  ensures result.balance == old(account.balance) - amount
{ return account.with("balance", account.balance - amount) }
```

`old(...)` is the value on the way in, so a postcondition can state a *change*
rather than only a result. A record invariant holds at construction and again
after every `.with()`, so there is no moment at which an `Account` exists with a
negative balance.

And loops can prove they finish:

```sarvm
while i > 0
  invariant seen >= 0
  variant i
{ seen = seen + 1  i = i - 1 }
```

The variant must stay non-negative and strictly decrease. A loop that spins gets
told which promise it broke, with the numbers:

```
LoopError: the loop variant `5 - j` did not decrease (5 then 6) on pass 2,
           so this loop is not making progress
```

## Whose data is this, and who said who may read it

Following [Myers and Liskov's decentralized label
model](https://www.cs.cornell.edu/andru/papers/sp98/sp98.pdf). Flat labels
answer "is this suspect". They cannot answer the question a system with several
mutually distrusting parties actually has.

```sarvm
let salary  = classify(82000, "hr",    ["hr", "payroll"])
let audited = classify(salary, "audit", ["audit", "payroll"])

readers_of(audited)                     // ["payroll"] — the intersection
release_to "payroll"   { use(salary) }  // fine
release_to "marketing" { use(salary) }  // LabelError
```

Combining data unions the policies and *intersects* the readers. Mixing data
never makes it more readable.

The part a blanket `trust()` cannot express — **authority is per principal**:

```sarvm
authority "hr" {
  declassify(salary,  "hr",    "approved for the annual report")  // fine
  declassify(audited, "audit", "not hr's to release")             // refused
}
```

Holding `hr`'s authority does not let you release `audit`'s data, and authority
is granted at the boundary with `--principal`, never taken from inside.

## Authority you can lend, narrow, and take back

Following the [object-capability
patterns](https://people.mpi-sws.org/~dreyer/papers/ocpl/paper.pdf). `needs fs`
is a static claim you cannot lend and cannot withdraw. A grant is a value:

```sarvm
let pair = caretaker(grant("fs", "the report worker"))
report_worker(pair["grant"], "quarterly figures")   // works
revoke(pair["revoker"])
report_worker(pair["grant"], "…")                   // CapabilityError: revoked
```

Narrower still — `attenuate({ "uses": 2 })` or `{ "for": 5 }` ticks. Three rules
make it safe to hand one out: a frame can only grant what it already holds,
attenuation only ever narrows, and **revocation is transitive** — killing a
grant kills everything derived from it.

## Tooling

```bash
sarvm test .          # unit tests, contracts, types and races, in one command
sarvm fmt .           # one canonical layout, no options
sarvm check file      # types and static checks, without running
sarvm explain E0402   # what an error code actually means
sarvm build file      # one self-contained .mjs, no dependencies
```

`sarvm test` runs three things at once: every `test_*` function, the type and
race checkers, and `prove` against every contracted function in the file. That
last one is why the command earns its place — a contract *is* a specification,
so adding a `requires` clause immediately buys you generated tests with no
separate step to remember.

`sarvm fmt` has no options, on purpose. Its guarantee is checked by tests that
matter: formatting is idempotent, comments survive, and **a formatted program
produces byte-identical output to the original**. Building it found two bugs
where the formatter silently changed the program — a multi-statement lambda body
replaced with a literal `{ ... }`, and `redefine fn f` printed as `fn f`, which
turns a redefinition into a duplicate declaration.

## A standard library, written in Sarvm

```sarvm
import "std/list" as list
import "std/math" as math
import "std/result" as res

list.group_by(trades, fn(t) { return t.symbol })
math.percentile(latencies, 99)

match parse_price(input) {
  Ok(v)  => settle(v),
  Err(e) => report(e)
}
```

`std/list`, `std/str`, `std/math` and `std/result` are written in Sarvm, not
bolted on as builtins. If the language could not express its own standard
library comfortably that would be worth finding out early, not hiding. It has
its own test suite: `sarvm test std/`.

## Interop, because nobody rewrites

```sarvm
let os = foreign("node:os")
print(os.platform())
```

The single largest blocker to adopting any language is the code you already
have. `foreign()` calls into JavaScript — built-in modules, CommonJS files,
installed packages.

It needs the `ffi` capability, and that is the entire design. Everything else in
Sarvm is bounded; a foreign call escapes all of it, because once control is
inside JavaScript the runtime cannot see what happens. So the boundary is
declared rather than ambient, values are **converted rather than shared** (a
host function cannot reach back into your list), and everything coming back is
labelled `untrusted` — it cannot enter a `grounded` block until you launder it
with a written reason. A function that did not declare `ffi` cannot open the
boundary even when the top level holds it.

---

## The language

Familiar on the surface. Semicolons optional, `//` `#` `/* */` comments,
`let` is immutable and `var` is not.

```sarvm
let name = "Sarvm"
var count = 0
while count < 3 { count = count + 1 }

fn fib(n) requires n >= 0 {
  if n < 2 { return n }
  return fib(n - 1) + fib(n - 2)
}

for i in range(5) { print(i, fib(i)) }

let squares = [1, 2, 3].map(fn(x) { return x * x })
let cfg = { "retries": 3, "mode": "strict" }

attempt {
  1 / 0
} rescue e {
  print(e["kind"], e["message"])
}
```

Types: `num` `str` `bool` `nil` `list` `map` `fn` `tensor` `context` `ledger`.

---

## The seven things that make it Sarvm

### 1. Branches that admit they are uncertain

```sarvm
maybe 0.7 { explore() } else { exploit() }

let strategy = choose {
  0.6 => "exploit",
  0.3 => "explore",
  0.1 => "ask a human"
}
```

Probabilistic, but **not** irreproducible: every run with the same `--seed`
takes the same path, and `--trace` prints every draw and the branch it caused.
A language with `maybe` in it would be undebuggable otherwise.

### 2. Forking a reasoning path

```sarvm
let scores = fork 5 {
  let prior = 0.4 + (_ * 0.05)
  prior * 0.6 + random() * 0.4
}
print("best is path", argmax(scores))
```

`fork n { ... }` runs `n` independent paths, each with its own scope and its own
random stream derived from the current one, and collects the results. Paths
diverge from each other; the whole fan-out replays identically next run.

### 3. Tensors are values, not a library

```sarvm
let w = tensor [[0.2, -0.4, 0.1], [0.7, 0.3, -0.9]]
let x = tensor [1.0, 2.0, 0.5]
let h = relu(w @ x)          // matmul, rank-1 and rank-2
let s = softmax(h)
let b = w * 2 + 1            // broadcasting
```

`@` is matrix multiply, `+ - * / % **` broadcast, and shape mistakes are
language errors with a line number:

```
ShapeError: cannot multiply [2, 3] @ [2, 3]: inner sizes 3 and 2 differ (line 34)
```

Tensors are immutable — writing into one is an error, not a silent aliasing bug.

### 4. Where a value came from is part of the value

```sarvm
let reply = ungrounded("the filing says revenue was 9.9bn")
let form  = untrusted(user_input)

labels(reply)              // ["ungrounded"]
labels(reply.upper())      // ["ungrounded"]  -- survives being handled

grounded {
  print(reply)             // TaintError: a grounded block read an ungrounded value
}

let checked = trust(reply, "cross-checked against filing.pdf p14 by a human")
grounded { print(checked) }   // fine, and the laundering is in the trace
```

Labels propagate through every operation that reads the value — arithmetic,
concatenation, method calls, function returns. `trust()` is the only way to
remove one, it demands a written reason, and it records the laundering.

### 5. Jurisdiction travels with the data

```sarvm
let record = restrict("customer 4471, Dublin", "eu")

region "eu" { print(record) }     // fine
region "us" { print(record) }     // TaintError: restricted to 'eu', read inside 'us'
```

Same machinery as above, different label namespace.

### 6. Capabilities are held, not assumed

```sarvm
fn save_note(text) needs fs {
  write("note.txt", text)
}

fn sneaky(text) {
  return write("note.txt", text)   // CapabilityError: needs 'fs', holds nothing
}
```

A function holds exactly what it declared with `needs` — never what its caller
held. That is real attenuation, not a policy file:

```sarvm
fn inner() needs clock { return now() }
fn outer() needs fs { return inner() }   // CapabilityError, even when the top
outer()                                  // level was granted both
```

The top level holds only what `--grant` gave it. With no flag, a program cannot
touch the filesystem or read the clock — which is also why a program without
`--grant` always replays identically.

### 7. Contracts are checked, and generate their own tests

```sarvm
fn share(total, n) requires n > 0 ensures result * n == total {
  return total / n
}
```

Violations are runtime errors that quote the predicate. And because the contract
*is* the specification, `sarvm prove` generates inputs, discards the ones the
preconditions reject, and reports where a promise failed:

```
prove examples/contracts.sarvm (seed 0, 200 inputs per function)
  . abs_     held over 147 accepted inputs (53 outside its domain)
  . clamp01  held over 147 accepted inputs (53 outside its domain)
  X scale    3 counterexamples over 48 accepted inputs
      scale(-1, 2)     ->  scale promised result >= x, but returned -2
      scale(-0.5, 10)  ->  scale promised result >= x, but returned -5
  X safe_div 3 counterexamples over 106 accepted inputs
      safe_div(-894, 352) -> safe_div promised result * b == a, but returned -2.53977272727
  ~ persist  skipped: declares needs fs; calling it would perform real effects
```

Both findings above are genuine: `scale` is wrong for negative `x`, and
`safe_div`'s postcondition assumes exact arithmetic that floating point does not
provide. It does not invent tests for uncontracted functions — a function that
promises nothing cannot be checked against anything.

### And: memory measured in tokens

```sarvm
let ctx = context(4000)
ctx.pin("system: you verify claims, you do not invent them")
ctx.push(user_turn)
ctx.push(tool_result)
print(ctx.tokens, "of", ctx.budget, "used")   // evicts oldest unpinned on overflow
```

### 8. Arithmetic on data you cannot read

```sarvm
let k = paillier_keygen(512)
let payroll = encrypt(k, 82000) + encrypt(k, 95000) + encrypt(k, 71000)
let after_fee = payroll - 1000
print(decrypt(k, after_fee))          // 247000 -- nothing decrypted in between
```

Real Paillier. `+`, `-` and `*`-by-a-plaintext are homomorphic operations on
ciphertexts, written as ordinary arithmetic. Multiplying two ciphertexts is
refused with an explanation, because Paillier is additive and pretending
otherwise would produce silent nonsense. A public key can do the arithmetic and
still cannot decrypt the answer.

### 9. Proving without revealing, and provenance that travels

```sarvm
let pw = secret_of("correct horse battery staple")
let proof = zk_prove(pw)
print(zk_verify(zk_public(pw), proof))     // true, and the verifier learns nothing

let sealed = commit(4200, blinding)        // Pedersen: binding and hiding
print(commit_open(sealed, 4200, blinding))

let chain = lineage("sensor-7", keypair())
chain.record("raw 41.2C")
chain.record("calibrated 40.9C")
print(chain.verify())    // every hash re-derived, every step signature checked
```

Schnorr proofs over RFC 3526 group 14, made non-interactive by Fiat-Shamir, with
Ed25519 for signatures. The group is not taken on trust: the test suite
re-derives that *p* is prime, that *q = (p−1)/2* is prime, and that both
generators lie in the order-*q* subgroup.

### 10. All of it or none of it, and secrets that do not linger

```sarvm
atomic {
  book.append("buy 100 ACME @ 12.50")
  mirror.append("buy 100 ACME @ 12.50")
}   // both land, or neither does -- across any number of ledgers, nested

secret {
  let key = random_secret(32)
  authenticate(key)
}   // key's bytes are zeroed on the way out, including if the block fails
```

A secret never renders its contents — printing one gives `<secret 32 bytes>`.

### 11. Quantum logic in the same file as everything else

```sarvm
let q = qubits(2)
qh(q, 0)
cnot(q, 0, 1)
print(probabilities(q))     // [0.5, 0, 0, 0.5] -- a Bell pair
let bits = measure_all(q)   // the two always agree
```

A state-vector simulator: exact unitary evolution, real entanglement and
interference, correct measurement statistics — and measurement draws from the
same seeded RNG as the rest of the language, so a quantum program replays
exactly. It is simulation, not hardware: *n* qubits cost 2^*n*, which is why the
register stops at 22.

### 12. Ordering across machines, and value that decays

```sarvm
let alice = clock("alice")
let bob = clock("bob")
let placed = alice.tick()
let seen = bob.merge(placed)      // bob learns of it, then stamps the receipt
print(before(placed, seen))       // true

let edge = liquid(10000, 20)      // halves every 20 ticks
advance(20)
print(edge + 0)                   // 5000 -- the discount is the type
```

The clock is deliberately *logical*. Two machines cannot agree on "now" to the
nanosecond, so this never reads a wall clock: it gives a deterministic total
order, identical on every node and consistent with causality, and there is
nothing to drift. Decay runs on the same logical time, so a schedule replays.

### 13. Agents that can only talk

```sarvm
agent Keeper(name) {
  var seen = 0
  var total = 0
  on record(n) { seen = seen + 1  total = total + n }
  on audit()   { send(sender, "result", name, total) }
}

let books = spawn Keeper("london")
send(books, "record", 1200)
run_agents()
```

Private state, message handlers, and `sender` bound on the way in so a reply
needs no address book. Delivery is round-robin in spawn order — fair, and
deterministic enough that the same program delivers the same messages in the
same order every run.

The isolation is enforced, not advised. An agent that reaches for anything
outside its own state is stopped:

```
AgentIsolationError: an agent may only change its own state,
and 'shared_counter' belongs to the scope outside it
```

It can still *read* globals and call the program's functions. It just cannot
write to them, which is the property an actor model exists to provide.

### 14. A kill switch the code inside cannot argue with

```sarvm
attempt {
  budget steps 5000 {
    attempt {
      runaway()
    } rescue e {
      print("this line never runs")
    }
  }
} rescue supervisor {
  print(supervisor["kind"])     // BudgetError
}
```

A budget stop is deliberately **not** a catchable failure. Code inside the block
cannot rescue it, cannot raise its own ceiling, and a nested `budget` can only
tighten. Only the boundary converts it into an ordinary error, for whoever set
the budget to handle. That asymmetry is the whole feature: a runaway agent must
not be able to talk its way out of being stopped.

Budgets are measured in `steps` or `tokens` — the latter bounds what a program
may push into context windows.

### 15. Problems found before the program runs

```bash
sarvm check examples/agents.sarvm
```

```
examples/agents.sarvm:128  race: every forked path assigns to 'tally', which is
declared outside the fork; the paths are sharing one cell
      try: return a value from the path and combine the results afterwards
```

`fork n { }` runs one body as n paths. A write to anything declared outside it
is a race whether or not today's scheduler happens to interleave. The check is
biased toward silence — any name declared anywhere inside the body counts as
local, so shadowing never produces a false alarm — because a checker people
switch off is worth less than one that only speaks when it is right. Races are
also printed as warnings on every `run`.

`--profile` gives per-function call counts, steps and inclusive time.

---

## Status against the 50 features you listed

Split by what is actually true today, not by what sounds good.

### Shipped and working (41)

| # | Feature | How it landed |
|---|---|---|
| 2 | Non-deterministic control flow | `maybe p {}`, `choose {}`, seeded and replayable |
| 7 | Semantic error trapping | `requires` / `ensures` — executable intent, checked at the boundary |
| 8 | Asynchronous mind-forking | `fork n {}`, isolated scope + independent random stream per path |
| 9 | Vector math first-class | `tensor`, `@`, broadcasting, `softmax`/`relu`/`dot`/`cosine` |
| 11 | Hallucination sandboxing | `ungrounded()` + `grounded {}` blocks |
| 12 | Token-based memory accounting | `tokens()`, per-entry accounting on every context |
| 14 | Cross-border regulatory type-checking | `restrict()` + `region "xx" {}` |
| 15 | Immutable ledger primitives | `ledger()`, hash-chained, `verify()` detects tampering |
| 1 | Native context-window memory | `context(budget)` with eviction and pinning |
| 4 | Real-time state distillation | `distill()` — deterministic structural digest |
| 35 | Data-sovereignty tainting | same label engine as #14, per-variable, propagating |
| 37 | Adversarial input isolation | `untrusted()` + taint reaching a sink |
| 40 | Capability-based access control | `needs`, deny-by-default, real attenuation |
| 43 | Compiler-driven synthetic test generation | `sarvm prove` |
| 34 | Homomorphic encryption runtime | Paillier; `+`, `-`, `*`-by-plaintext on ciphertexts as ordinary operators |
| 21 | Zero-knowledge math integration | Schnorr proofs and Pedersen commitments over a verified 2048-bit group |
| 38 | Cryptographic provenance | Ed25519 `sign` / `verify_signature`, no third-party package |
| 17 | Data lineage | `lineage()` — hash-chained *and* per-step signed; see the caveat below |
| 39 | Ephemeral secret shredding | `secret { }` scopes, zeroed buffers, secrets never print |
| 18 | Atomic cross-ledger execution | `atomic { }`, all-or-nothing, correctly nested |
| 31 | Quantum-classical hybrid | State-vector simulator, seeded and replayable |
| 42 | Deterministic distributed timestamps | Logical clocks — a total order with no wall clock to drift |
| 20 | Dynamic liquidity typings | `liquid(value, halflife)`, decay on logical time |
| 5 | Agent-to-agent primitives | `agent` / `spawn` / `send`, private state, enforced isolation |
| 33 | Autonomous kill-switch | `budget steps N { }` — not raisable or catchable from inside |
| 44 | Deep observability | `--profile`: calls, steps and inclusive time per function, no instrumentation |
| 19 | Predictive race blocking | `sarvm check` finds shared writes across forked paths before running |
| 25 | Dynamic kernel slicing | matmul split across OS threads over SharedArrayBuffers |
| 26 | Race safety at the slicing level | each thread owns a disjoint band of output rows, so collisions are impossible by construction |
| 27 | Memory eviction instead of crashing | `arena(bytes, dir)` spills least-recently-used tensors to disk and reads them back |
| 3 | Large immutable weights | `weights(file, shape, dtype)` pages rows from disk; the file never becomes resident |
| 6 | Safe self-modifying code | `redefine`, validated against shape, capabilities and inherited contracts |
| 10 | Execution graph recompilation | the call graph is rederived on every redefinition; `dependents()` says what is affected |
| 41 | Zero-downtime hot swap | `redefine on Agent.msg` reaches live agents with their state intact |
| 47 | Stateful migration | `snapshot()` / `restore()` move values, agents, mail and the RNG position |
| 36 | Leak detection | `watch()` / `leaks()` report structures that grew at every sample |
| 48 | Self-documenting API evolution | `schema` / `negotiate` / `adapt` — structural, no version strings |
| 22 | Live re-typing | `migrate()` reshapes records in memory through the same path as the wire |
| 46 | Binary-level de-duplication | modules are cached by content hash, so identical files are one instance |
| 16 | Macro and micro in one block | `schedule` / `simulate` — one event queue, any mix of timescales |
| 49 | Cost-aware compilation | `energy()` with a disclosed weight table |

Caveats that matter, and none of them are hidden in the code:

- **#1** is a bounded token-accounted buffer, not an LLM context addressed as
  RAM — no model is attached.
- **#4** is structural, not semantic. It never calls a model, so it never
  invents anything.
- **#12** uses a deterministic token estimate (within roughly 10–15% of BPE
  counts on prose), not a real vocabulary.
- **#7** checks stated intent. It does not read minds.
- **#37** is now checked statically as well as at runtime — `sarvm check` reports
  a labelled value reaching a sink on any path.
- **#17** is the honest half of what you asked for. The chain proves *who
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
  which is the semantic content of the feature — but they share one thread, and
  there is no cross-machine transport yet. "Socket protocols between machines"
  is not done.
- **#19** is a single static check (shared writes from forked paths) plus arity.
  It is not a general race detector, and it says nothing about market
  front-running, which is not a property a compiler can see.
- **#44** reports inclusive time, so a caller's number contains its callees'.

### Shipped, but smaller than you asked for (6)

These work, and the gap between what they do and what the original line said is
named rather than blurred.

| # | You asked for | What ships | The gap |
|---|---|---|---|
| 23 | CPU/GPU unified memory | `device "x" { }` blocks; one syntax, backend chosen at the block | Backends are `cpu` and `workers`. No GPU, so no host/device transfer to elide. |
| 24 | NVIDIA / AMD / ASIC from one source | a backend registry a new backend plugs into | Nothing implements a GPU backend. A registry with no GPU in it is a seam, not silicon agnosticism. |
| 28 | Silicon topology awareness | real core count, model, clock, memory, load | No NUMA distances, no cache hierarchy, no interconnect map. Node cannot see them. |
| 29 | Asymmetric compute pipelining | small jobs stay on the calling thread, large ones go wide | Routing by size, not by matrix-core vs general-core. There is no second core type to route to. |
| 50 | one universal native binary | `sarvm build` → one `.mjs`, no dependencies, no install | It needs Node. Universal binaries are per-target builds in a wrapper; this is the honest version of the idea. |
| 13 | deterministic nanosecond GC | `arena.reclaim()` — you choose the moment, and it reports the pause it caused in nanoseconds | Not a collector, and not pause-free. It measures the pause instead of promising there isn't one. |

### Not achievable as stated (4)

- **#30 Thermal-aware clock throttling.** No portable way to read die
  temperature from a runtime. `pressure()` reports CPU load and free memory,
  which is what is actually observable — it is not a thermal reading, and it is
  not named as one.
- **#32 On-chip interconnect primitives.** Addressing a chip-to-chip bridge
  needs a driver, not a language.
- **#45 Infinite horizontal elasticity, 1 to 10,000 servers, no config.** A
  language cannot conjure servers. `snapshot`/`restore` is the migration half;
  the provisioning half is somebody's infrastructure either way.
- **#17's "hardware-enforced" half.** The signed, hash-chained lineage above is
  the achievable part; see the caveats.

That is 41 + 6 + 3 = all 50, with #17 appearing twice on purpose: the
cryptographic half shipped, the hardware half cannot.

The honest summary of what stays out of reach on Node: anything that must
address a GPU, an ASIC, or a thermal sensor directly. Everything else on the
list either works or works smaller, and the difference is written down.

---

## What is honest about this

- `fork` evaluates paths in order, not on OS threads. The semantics — isolation
  and independent randomness — are real; the parallelism is not. Real
  parallelism needs worker threads and a serializable value representation.
  This is also why `sarvm check`'s race detection matters: the defect is real
  even though today's scheduler happens not to expose it.
- Agents run on one thread. Isolation and determinism are real; concurrency is
  cooperative, and nothing crosses a machine boundary yet.
- Threads back tensor work only. `device "workers"` genuinely parallelises
  matrix multiply across cores (~1.5× on 3 threads for a 400×400 multiply —
  sub-linear, because copying into the shared buffer and memory bandwidth eat
  the rest). `fork` does not use them.
- `energy()` weights are a disclosed model, not a measurement. Nothing here
  reads a power rail. It answers "did that change make the program do more
  work", which is usually what an energy budget is a proxy for.
- The bundler inlines this codebase, which it can do because the codebase is
  small and its own. It is not a general-purpose JavaScript bundler and should
  not be pointed at one.
- Module imports resolve inside the entry directory only, and cannot form a
  cycle.
- Token counts are a stable estimate, not a BPE vocabulary.
- The ledger hash is FNV-1a, not a cryptographic hash.
- Taint tracking is dynamic. It catches what a run actually touches, not every
  path a program could take. A static pass would strengthen it.
- `prove` generates inputs from a fixed pool weighted toward numbers. It finds
  real counterexamples (see `scale` above) but is not exhaustive, and it says so
  in its own output — including how many inputs fell outside a function's domain.
- There is no module system yet. One file at a time.

## Layout

```
bin/sarvm.mjs        CLI: run, prove, repl, eval
src/lexer.js        tokens
src/parser.js       recursive-descent -> AST
src/interpreter.js  tree-walking evaluator, capabilities, taint, contracts
src/builtins.js     the prelude
src/tensor.js       dense f64 tensors, broadcasting, matmul
src/values.js       taint, context windows, ledgers, token counting
src/crypto.js       Paillier, Schnorr, Pedersen, Ed25519, lineage, secrets
src/bigmath.js      modular arithmetic, Miller-Rabin, prime generation
src/quantum.js      state-vector simulator
src/temporal.js     logical clocks, decaying values
src/agents.js       actors, mailboxes, deterministic scheduler
src/analysis.js     static checks: fork races, arity
src/prove.js        contract-driven test generation
src/rng.js          seeded, forkable PRNG
examples/           tour, contracts, crypto, quantum, agents
tests/              151 tests across 4 files
```

## Next

In order of value: worker-backed `fork` so reasoning paths get the parallelism
tensor work already has; a cross-machine transport for agents, which turns
`snapshot`/`restore` plus mailboxes into actual distribution; and a standard
library, because 41 features and no `sort` for maps is a strange place to be.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: a feature's name must
be true, and any limitation goes in the caveats list in the same pull request
that adds the feature.

## Documentation

| | |
|---|---|
| [Getting started](docs/getting-started.md) | Twenty minutes, assumes nothing |
| [Reference](docs/reference.md) | Every keyword, builtin and command |
| [Security](SECURITY.md) | Threat model, what is audited and what is not |
| [Versioning](VERSIONING.md) | What is stable, what can move under you |
| [Limitations](LIMITATIONS.md) | Everything known to be wrong, missing, or weaker than it sounds |
| [Changelog](CHANGELOG.md) | What changed, including every break |
| [Contributing](CONTRIBUTING.md) | How to add something without overclaiming |
| [Releasing](RELEASING.md) | The checklist, and why each step is on it |
