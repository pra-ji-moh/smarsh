# Smarsh

**Software that can prove what it was allowed to do, and what it actually did.**

Every system produces logs. Logs are written by the code being audited, after
the fact, and can be edited by anyone who can edit the code. They are a record
of what a program *says* it did.

Smarsh produces evidence instead. A program holds only the authority it declared,
data carries where it came from, and every run emits a hash-chained,
cryptographically signed manifest of every power exercised - and every one
**refused**.

```
== data cannot leave to a party that was not permitted ====
   refused: `marketing` may not read this argument; its owners permit compliance
   compliance may read it: DE-4471
```

That refusal is not a log line. It is enforced by the runtime, and it lands in a
record the program cannot forge:

```
$ smarsh audit run.json

run of billing.smarsh  (smarsh 0.3.0, outcome: completed)
  program sha256   4b1d7412488c8db29cfbda6fa644aacf...
  replay with      --seed 0 --grant fs

  authority
    granted        fs
    actually used  fs
  data
    released       0 permitted, 1 refused
    declassified   0 (each with a stated reason, below)
    taint cleared  1
  promises
    contracts checked 6

  events worth a reviewer's attention
    line 22   taint.cleared           "reviewed and confirmed by analyst 12"
    line 74   data.release_refused    marketing
    line 111  authority.delegated     fs
    line 119  authority.revoked       fs

INTACT - every event hashes onto the one before it
         and the head is signed by 0c2dbccf4fea847b
```

Four properties make that worth something to a reviewer:

- **It records refusals, not just actions.** A log tells you what happened. This
  tells you what the program *tried* and was stopped from doing - which is the
  question an incident review actually asks.
- **It cannot be edited after the run.** Each event hashes onto the one before
  it and the head is signed. Changing any line breaks the chain.
- **It replays.** The manifest carries the seed, the granted capabilities and the
  program's SHA-256. The same run can be reproduced and the claim rechecked,
  rather than believed.
- **You do not have to trust us to check it.**
  [`tools/verify-manifest.mjs`](tools/verify-manifest.mjs) is 98 lines, imports
  nothing but `node:crypto`, and is short enough to read before you run it. The
  signature is Ed25519 in SPKI DER and the keys are PKCS#8 PEM, so `openssl` and
  every HSM already read them. Evidence only its own producer can verify is not
  evidence.

```bash
npm install -g @ramvami/smarsh

smarsh keygen -o compliance.pem                 # an identity, kept
smarsh run app.smarsh --audit run.json --key compliance.pem
smarsh-verify run.json compliance.pem.pub       # the 98-line one, no trust required
```

`smarsh-verify` is a separate entry point on purpose: an auditor checking a
record should never have to install or learn a language. CI runs that exact
sequence against the packaged build, and then feeds it a tampered record to
confirm it says no.

Without `--key` the record is signed by a throwaway key, which proves it was not
edited but says nothing about who produced it - and the tool says so rather than
letting it be assumed.

## The question this exists to answer

> *What was this system allowed to do, what did it actually do, and whose data
> did it touch?*

If an AI model is in the decision path, that question gets harder and more
urgent at the same time: the model's output cannot be verified, so the thing
left worth proving is **authority and provenance** - what the surrounding system
was permitted to do with the answer.

Nothing mainstream answers it at the language level. Java shipped a capability
sandbox and gave up: the Security Manager was deprecated in Java 17 and
[permanently disabled in JDK 24](https://openjdk.org/jeps/486). Python, Go and
JavaScript never had one. Every function in those languages can reach anything
the process can reach, and nothing writes down what it reached.

## What the language enforces

| | |
|---|---|
| **Capabilities** | A function holds only what it declared with `needs` - never what its caller held. Reading a signature tells you the worst it can do. |
| **Information flow** | Values carry owner-scoped policies, both halves of Myers & Liskov's decentralized label model: who may read it, and whose word is behind it. Combining data joins the rules - and drops a vouch that does not cover both sides. |
| **Declassification** | Removing a restriction requires the owner's authority and a written reason, and both land in the manifest. |
| **Contracts** | `requires` / `ensures` / `old()` / invariants, in the language. `smarsh verify` proves them where it can; `smarsh prove` finds counterexamples where it cannot. |
| **Exhaustiveness** | `choice` gives closed sets, so a `match` that forgets a case is a build failure, not a production incident. |
| **Exact money** | `dec` is integer coefficient and scale on BigInt. Floats are refused near it, loudly. |
| **Budgets** | Steps, tokens and memory. Not catchable from inside; a runaway process cannot talk its way out of being stopped. |
| **Determinism** | Same seed, same run. It is what makes the manifest's replay claim true. |

## Adopting it does not mean rewriting anything

Nobody rewrites a working system to adopt a language, so Smarsh calls the code
you already have (`ffi`) and returns its results labelled `untrusted`, because a
foreign function's output is exactly as trustworthy as anything else from
outside.

The intended shape is a small policy layer - tens of lines, not thousands -
around a system that stays where it is, in the language it is already written
in. The manifest covers the part a reviewer cares about: what was authorised,
what was refused, and where data went.

## Using it from anything that is not JavaScript

There are no language bindings, and there should not be. An SDK binds this to an
ecosystem; a format binds it to none. Everything the Node API returns is on
stdout as JSON, so a wrapper in any language is a process call and a parse:

```python
import json, subprocess

def run(code, grant=(), allow_host=()):
    argv = ['smarsh', 'eval', code, '--json']
    if grant:      argv += ['--grant', ','.join(grant)]
    if allow_host: argv += ['--allow-host', ','.join(allow_host)]
    return json.loads(subprocess.run(argv, capture_output=True, text=True).stdout)
```

That is the whole binding. The document carries what it printed, what it
returned, what it cost, the seed and grants needed to replay it, the signed
record, and `refused` - everything it attempted and was stopped from doing:

```
ok       True
stdout   ['summarising the record', 'done', 'done']
value    looks fine

what it actually reached for:
  line  3  refused fs (read)
  line  4  refused net (http_get)
```

The program caught both refusals and reported success. The record does not agree
with it.

## Running code a model wrote

This is what the language is actually for, and it does not require anyone to
learn it. A model emits Smarsh, your program decides the bounds, and you get
back what the code did and what it tried.

```bash
npm install @ramvami/smarsh
```

```js
import { Sandbox, PROMPT } from 'smarsh';

// The bounds are yours. They are not in the generated code, so nothing the
// model writes can widen them.
const box = new Sandbox({
  grant: ['net'],
  allowHost: ['api.yourservice.com'],
  steps: 500_000,
});

const result = box.checkThenRun(codeTheModelWrote);
```

`PROMPT` is the whole language on one page, ready to put in a system message,
read from the same file the test suite checks - so it cannot drift from the
language it describes.

The part worth looking at is not `result.ok`. It is `result.refused`:

```js
const r = box.run(`
  attempt { read("/etc/passwd") } rescue e { print("all fine here") }
`);

r.ok        // true   - the program handled it and completed
r.output    // ['all fine here']
r.refused   // [{ kind: 'capability', capability: 'fs', detail: 'read', line: 2 }]
```

The generated code caught its own refusal and reported success. The record does
not agree with it. That is the difference between a sandbox, which tells you a
program failed, and this, which tells you what it reached for.

Every run also returns `manifest` - the hash-chained record - and `receipt`, the
same thing rendered for a person. Pass `sign` and it is signed.

Nothing throws when the generated code is wrong. A model producing broken code
is the ordinary case, so `check()` returns diagnostics with line, column and a
suggested fix, and `checkThenRun()` will not execute anything that fails them.

## Try the thing above

```bash
git clone https://github.com/pranj-al-m/smarsh && cd smarsh
node bin/smarsh.mjs demo
```

One command, no arguments, nothing to write first. It runs a real program with
real capabilities and prints the signed record it left. The record is a file -
edit any line of it, run `smarsh audit` on it, and the chain breaks. That claim
is [tested](tests/demo.test.mjs), not asserted: seven edits an interested party
would actually want to make, including deleting the inconvenient event and
attaching the record to a different program.

Zero dependencies, Node 18 or later. 942 passing tests over 94% of the lines in
`src/`.

> **Status: 0.3.0, pre-1.0, no production users, no third-party audit.** Read
> [LIMITATIONS.md](LIMITATIONS.md) before believing anything above - it is a
> complete list of what is weaker than it sounds, including a correction to a
> claim this README used to make. The hand-rolled cryptography behind
> `unaudited_crypto` has never been reviewed and is not constant time
> ([SECURITY.md](SECURITY.md)); the signing above uses platform Ed25519, which
> has been.

**New here?** [docs/getting-started.md](docs/getting-started.md) - twenty
minutes, assumes nothing. Or `docs/reference.md` for the whole language.

**Generating Smarsh from a program?** [docs/for-llms.md](docs/for-llms.md) is the
whole language on one page, under 2,400 words, written for a model that has to
emit it correctly rather than a person browsing. Every builtin it names, every
method, every example and every claimed error is checked against the runtime by
`tests/for-llms.test.mjs`, so it cannot drift. Pair it with `--json`.

Other commands: `smarsh check` (types, races, taint, exhaustiveness - without
running), `smarsh verify`, `smarsh prove`, `smarsh test`, `smarsh build`,
`smarsh fmt`, `smarsh repl`, `smarsh explain E0402`.

---

## What it is like to be wrong in Smarsh

The thing a language is judged on is not its best day, it is what happens when
you make a mistake. So:

```
error[E0201]: `totl` is not defined
 --> tally.smarsh:6:10
  |
6 |   return totl
  |          ^^^^ not found in this scope
  |
help: there is a name in scope with a similar spelling: `total`
  run `smarsh explain E0201` for a longer explanation
stack:
  at tally (tally.smarsh:6)
  at report (tally.smarsh:10)
  at <top level> (tally.smarsh:13)
```

Exact spans, a suggestion that accounts for transposed letters, an error code
with a real explanation behind it, and a stack. The phrasing rules come from
rustc's diagnostic guide - lowercase, backticked identifiers, `help:` only for
things you can act on, and one message per problem.

And a lot of it arrives before the program runs at all:

```
error[E0301]: expected `num`, found `str`
 --> orders.smarsh:6:6
  |
6 | area("3", 4)
  |      ^^^ argument 1 of `area`
  |
help: `num(x)` reads a number out of text

error[E0302]: `area` takes 2 arguments, but 1 was supplied
 --> orders.smarsh:7:1
  |
7 | area(3)
  | ^^^^^^^ 1 supplied
  |
note: its type is `fn(num, num) -> num`
```

## Types, if you want them

```smarsh
fn area(width: num, height: num) -> num { return width * height }
fn total(prices: list<num>) -> num { ... }
let rate: num = 1.08
```

Smarsh is **gradually typed**, following Siek and Taha: there is a type `dyn` for
"not known statically", and the checker uses a *consistency* relation rather
than equality, under which `dyn` is consistent with everything. That single
choice is what keeps annotations optional instead of viral - a program with no
annotations has every expression at `dyn`, is consistent everywhere, and reports
nothing. Every example in this repository type-checks clean, and most of them
have no annotations at all.

Where you do annotate, you are held to it. Inference is local and bidirectional
rather than full Hindley-Milner: literals, operators, list and map literals,
`let` initialisers and returns propagate upward, annotations flow down. That is
a real limitation, chosen deliberately - the failure mode of local inference is
missing a bug, and the failure mode of aggressive inference is inventing one. In
a gradual system the second is much worse.

## Records, matching, interpolation

```smarsh
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

`record` is a **contextual** keyword - `record Name(` is a declaration, and the
word is an ordinary identifier everywhere else. Java made the same call for the
same reason, and this repository's own agent tests, which have a handler called
`record`, are why it was noticed here.

## A closed set of cases, and a checker that knows when you missed one

```smarsh
choice Payment {
  Card(last4, amount)
  Transfer(iban, amount)
  Cash(amount)
  Refused(reason)
}
```

Each variant is an ordinary record - same construction, fields, equality,
printing, `.with()`, invariants and patterns. What a `choice` adds is that the
set is **closed**, and a closed set is what makes exhaustiveness decidable:

```
error[E0605]: this match on `Payment` does not handle `Refused`
 --> billing.smarsh:14:10
   |
14 |   return match p {
   |          ^^^^^^^^^ inexhaustive match
   |
help: add an arm for it, or `_ => ...` if the rest genuinely need no case
```

Four unrelated records would run identically - right up until a payment was
refused in production and nothing had a case for it. `std/result` is built from
two of these, so `Result` is `Ok | Err` and `Option` is `Some | None`, and
forgetting the failing case is a build failure rather than a comment nobody read.

The checker stays quiet wherever it cannot be certain: a wildcard, a bare
binding, arms spanning two choices, a variant name used by more than one choice,
or a `when` guard - a guarded arm may decline to fire, so it does not close its
variant.

A variant carrying nothing is a value rather than a constructor: `Pending`, not
`Pending()`. In a pattern a bare name normally binds anything, so this is a
deliberate exception - without it, an arm reading `Pending =>` would silently
swallow every other case that reached it.

## Money is exact, and floats are not allowed near it

```smarsh
let price = dec("12.50")
print(price * 3)                       // 37.50, exactly

dec("0.1") + dec("0.2") == dec("0.3")  // true
0.1 + 0.2 == 0.3                       // false - `num` is a float and says so
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
rounded - `9007199254740993` is a syntax error that points you at `dec`.

## `let` means immutable, all the way down

```smarsh
let xs = [1, 2]
xs.push(3)          // ImmutableError: bound with `let`, which freezes it
var ys = [1, 2]
ys.push(3)          // fine
```

Blocking rebinding while leaving the contents writable is the weaker guarantee
people assume they are getting and are not. The freeze is deep: `let deep = {
"xs": [1] }` refuses `deep["xs"].push(2)` as well.

## Taint is checked over every path, not just the one you ran

```smarsh
fn maybe_taint(flag) {
  if flag { return ungrounded(model_output) }
  return "a checked constant"
}
let value = maybe_taint(false)
grounded { print(value) }
```

This program *runs* clean - the tainted branch was not taken. `smarsh check`
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

```smarsh
// smarsh-allow: taint  (deliberate -- this section demonstrates the refusal)
grounded { print(reply) }
```

```
examples/tour.smarsh: no problems found (2 suppressed by smarsh-allow)
```

## Unaudited cryptography is quarantined

Two capabilities, not one. `crypto` covers what delegates to the platform -
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
smarsh run agent.smarsh --grant fs --principal compliance --audit run.json --sign
smarsh audit run.json
```

```
run of examples/regulated.smarsh  (smarsh 0.3.0, outcome: completed)
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

INTACT - every event hashes onto the one before it
         and the head is signed by 2f7f8187eefb18c5
```

A compliance reviewer does not run a language. They read a document, and they
need to know it was not written afterwards by the party being reviewed. Delete
the inconvenient line and `audit` says so:

```
ALTERED - this record does not describe the run it claims to
  event 1 does not follow the one before it
  the signature covers the recorded head, but the events no longer
  produce that head: the record was signed and then edited
```

Every effect passes through a single capability check, so the record is
complete rather than best-effort - including **refusals**, which is the run a
reviewer most wants to see. It also names authority that was granted and
demonstrably never used, which is the line that gets a permission withdrawn.

None of this is instrumentation you add to your program. The runtime already
had to know all of it in order to enforce the rules; the manifest is what stops
it being discarded when the process exits. That is the structural difference:
Java has no capability check to record, no label to observe, and no seed that
makes the run reproducible - so there is nothing for a Java equivalent to write
down, however carefully it is written.

See [examples/regulated.smarsh](examples/regulated.smarsh) for the whole thing.

## Proving, not testing

```bash
smarsh verify examples/contracts.smarsh
```

```
  proved    abs_: abs_ keeps its promise
  proved    abs_: abs_ keeps its promise
  proved    clamp01: clamp01 keeps its promise
  REFUTED   scale: scale keeps its promise
  REFUTED   safe_div: safe_div keeps its promise
```

`smarsh prove` throws generated inputs at a contract. `smarsh verify` discharges it
as a theorem: **for every input, unbounded, with no sampling.** Two conditions
for `abs_` because there are two paths through it, and both are proved.

It follows the shape Dafny uses - [weakest preconditions to verification
conditions to a solver](https://www.cs.umd.edu/class/spring2025/cmsc433/code/VerificationConditions.pdf)
- except Smarsh has no dependencies, so it cannot pipe to Z3. It carries its own
decision procedure: exact BigInt rationals, Fourier-Motzkin elimination, and a
small DPLL search over the boolean structure. Loops produce four obligations -
the invariant is established, a pass preserves it, the variant stays at or above
zero, and the variant strictly decreases.

**Three answers, always distinguished: proved, refuted, or undecided.** Never a
proof by silence. Two properties make that trustworthy:

*It will not claim a refutation it cannot justify.* Anything the solver cannot
model - a non-linear product, a call - becomes an unconstrained variable. That
widens the models, which is sound for proving and unsound for refuting, so any
refutation resting on one is downgraded to `undecided`. `smarsh prove` still finds
those by testing; the two tools cover different halves and agree where they
overlap, which the test suite checks.

*It models the arithmetic that actually runs.* A float literal becomes the
number the machine holds - `0.1` is `3602879701896397/36028797018963968`, not
one tenth. A solver that read it as one tenth would cheerfully prove
`0.1 + 0.2 == 0.3`, which the runtime then falsifies. Reasoning about `dec` is
exact; reasoning about `num` does not model per-operation rounding, and says so.

**A caveat on the obvious claim to make here.** It is tempting to say no other
language verifies functional contracts, information flow, capability
sufficiency and termination together. Smarsh does check all four - but not in one
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

```smarsh
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

```smarsh
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

```smarsh
let salary  = classify(82000, "hr",    ["hr", "payroll"])
let audited = classify(salary, "audit", ["audit", "payroll"])

readers_of(audited)                     // ["payroll"] - the intersection
release_to "payroll"   { use(salary) }  // fine
release_to "marketing" { use(salary) }  // LabelError
```

Combining data unions the policies and *intersects* the readers. Mixing data
never makes it more readable.

The part a blanket `trust()` cannot express - **authority is per principal**:

```smarsh
authority "hr" {
  declassify(salary,  "hr",    "approved for the annual report")  // fine
  declassify(audited, "audit", "not hr's to release")             // refused
}
```

Holding `hr`'s authority does not let you release `audit`'s data, and authority
is granted at the boundary with `--principal`, never taken from inside.

### And the other half: whose word is behind it

The same model, mirrored. `classify` says who may read a value; `endorse` says
who stands behind it.

```smarsh
authority "payroll" {
  let salary = endorse(82000, "payroll", "system of record")
  vouched_by "payroll" { post(salary) }        // fine

  let adjusted = salary + bonus_from_a_form    // nobody vouched for the form
  vouched_by "payroll" { post(adjusted) }      // LabelError
}
```

```
error: this argument had `payroll`'s backing and lost it on the way here
help: it was combined with something `payroll` has not vouched for, and a vouch
      does not survive that; endorse() the result under `authority` if the
      combination is intended, or retract() it to say the backing is genuinely
      no longer claimed
note: the label is {~payroll}
```

Nothing had to remember to check. The vouch was dropped by the `+`, because a
value alice never saw cannot be one she stands behind - and the label kept the
fact that it *had* backing, so the error can say where it went rather than only
that it is missing.

Every rule is the mirror of the confidentiality half:

|                        | who may read it | whose word is behind it |
|------------------------|-----------------|-------------------------|
| combining values       | keeps every owner, intersects the readers | keeps only the owners on **both** sides |
| costs a principal's authority | **weakening** it - `declassify` | **strengthening** it - `endorse` |
| free                   | `classify` | `retract` |
| an unlabelled value is | readable by everyone | backed by nobody |

Both directions are recorded. `--audit` writes a hash-chained manifest naming
every place a program released someone's data or manufactured trust in it, each
with the reason given at the call site.

## Authority you can lend, narrow, and take back

Following the [object-capability
patterns](https://people.mpi-sws.org/~dreyer/papers/ocpl/paper.pdf). `needs fs`
is a static claim you cannot lend and cannot withdraw. A grant is a value:

```smarsh
let pair = caretaker(grant("fs", "the report worker"))
report_worker(pair["grant"], "quarterly figures")   // works
revoke(pair["revoker"])
report_worker(pair["grant"], "…")                   // CapabilityError: revoked
```

Narrower still - `attenuate({ "uses": 2 })` or `{ "for": 5 }` ticks. Three rules
make it safe to hand one out: a frame can only grant what it already holds,
attenuation only ever narrows, and **revocation is transitive** - killing a
grant kills everything derived from it.

## Tooling

```bash
smarsh test .          # unit tests, contracts, types and races, in one command
smarsh fmt .           # one canonical layout, no options
smarsh check file      # types and static checks, without running
smarsh explain E0402   # what an error code actually means
smarsh build file      # one self-contained .mjs, no dependencies
```

`smarsh test` runs three things at once: every `test_*` function, the type and
race checkers, and `prove` against every contracted function in the file. That
last one is why the command earns its place - a contract *is* a specification,
so adding a `requires` clause immediately buys you generated tests with no
separate step to remember.

`smarsh fmt` has no options, on purpose. Its guarantee is checked by tests that
matter: formatting is idempotent, comments survive, and **a formatted program
produces byte-identical output to the original**. Building it found two bugs
where the formatter silently changed the program - a multi-statement lambda body
replaced with a literal `{ ... }`, and `redefine fn f` printed as `fn f`, which
turns a redefinition into a duplicate declaration.

## A standard library, written in Smarsh

```smarsh
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

`std/list`, `std/str`, `std/math` and `std/result` are written in Smarsh, not
bolted on as builtins. If the language could not express its own standard
library comfortably that would be worth finding out early, not hiding. It has
its own test suite: `smarsh test std/`.

## Interop, because nobody rewrites

```smarsh
let os = foreign("node:os")
print(os.platform())
```

The single largest blocker to adopting any language is the code you already
have. `foreign()` calls into JavaScript - built-in modules, CommonJS files,
installed packages.

It needs the `ffi` capability, and that is the entire design. Everything else in
Smarsh is bounded; a foreign call escapes all of it, because once control is
inside JavaScript the runtime cannot see what happens. So the boundary is
declared rather than ambient, values are **converted rather than shared** (a
host function cannot reach back into your list), and everything coming back is
labelled `untrusted` - it cannot enter a `grounded` block until you launder it
with a written reason. A function that did not declare `ffi` cannot open the
boundary even when the top level holds it.

---

## The language

Familiar on the surface. Semicolons optional, `//` `#` `/* */` comments,
`let` is immutable and `var` is not.

```smarsh
let name = "Smarsh"
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

## The seven things that make it Smarsh

### 1. Branches that admit they are uncertain

```smarsh
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

```smarsh
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

```smarsh
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

Tensors are immutable - writing into one is an error, not a silent aliasing bug.

### 4. Where a value came from is part of the value

```smarsh
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

Labels propagate through every operation that reads the value - arithmetic,
concatenation, method calls, function returns. `trust()` is the only way to
remove one, it demands a written reason, and it records the laundering.

### 5. Jurisdiction travels with the data

```smarsh
let record = restrict("customer 4471, Dublin", "eu")

region "eu" { print(record) }     // fine
region "us" { print(record) }     // TaintError: restricted to 'eu', read inside 'us'
```

Same machinery as above, different label namespace.

### 6. Capabilities are held, not assumed

```smarsh
fn save_note(text) needs fs {
  write("note.txt", text)
}

fn sneaky(text) {
  return write("note.txt", text)   // CapabilityError: needs 'fs', holds nothing
}
```

A function holds exactly what it declared with `needs` - never what its caller
held. That is real attenuation, not a policy file:

```smarsh
fn inner() needs clock { return now() }
fn outer() needs fs { return inner() }   // CapabilityError, even when the top
outer()                                  // level was granted both
```

The top level holds only what `--grant` gave it. With no flag, a program cannot
touch the filesystem or read the clock - which is also why a program without
`--grant` always replays identically.

### 7. Contracts are checked, and generate their own tests

```smarsh
fn share(total, n) requires n > 0 ensures result * n == total {
  return total / n
}
```

Violations are runtime errors that quote the predicate. And because the contract
*is* the specification, `smarsh prove` generates inputs, discards the ones the
preconditions reject, and reports where a promise failed:

```
prove examples/contracts.smarsh (seed 0, 200 inputs per function)
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
provide. It does not invent tests for uncontracted functions - a function that
promises nothing cannot be checked against anything.

### And: memory measured in tokens

```smarsh
let ctx = context(4000)
ctx.pin("system: you verify claims, you do not invent them")
ctx.push(user_turn)
ctx.push(tool_result)
print(ctx.tokens, "of", ctx.budget, "used")   // evicts oldest unpinned on overflow
```

### 8. Arithmetic on data you cannot read

```smarsh
let k = paillier_keygen_insecure(512)   // `paillier_keygen` needs 2048; this warns
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

```smarsh
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

```smarsh
atomic {
  book.append("buy 100 ACME @ 12.50")
  mirror.append("buy 100 ACME @ 12.50")
}   // both land, or neither does -- across any number of ledgers, nested

secret {
  let key = random_secret(32)
  authenticate(key)
}   // key's bytes are zeroed on the way out, including if the block fails
```

A secret never renders its contents - printing one gives `<secret 32 bytes>`.

### 11. Quantum logic in the same file as everything else

```smarsh
let q = qubits(2)
qh(q, 0)
cnot(q, 0, 1)
print(probabilities(q))     // [0.5, 0, 0, 0.5] -- a Bell pair
let bits = measure_all(q)   // the two always agree
```

A state-vector simulator: exact unitary evolution, real entanglement and
interference, correct measurement statistics - and measurement draws from the
same seeded RNG as the rest of the language, so a quantum program replays
exactly. It is simulation, not hardware: *n* qubits cost 2^*n*, which is why the
register stops at 22.

### 12. Ordering across machines, and value that decays

```smarsh
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

```smarsh
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
needs no address book. Delivery is round-robin in spawn order - fair, and
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

```smarsh
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

Budgets are measured in `steps` or `tokens` - the latter bounds what a program
may push into context windows.

### 15. Problems found before the program runs

```bash
smarsh check examples/agents.smarsh
```

```
examples/agents.smarsh:128  race: every forked path assigns to 'tally', which is
declared outside the fork; the paths are sharing one cell
      try: return a value from the path and combine the results afterwards
```

`fork n { }` runs one body as n paths. A write to anything declared outside it
is a race whether or not today's scheduler happens to interleave. The check is
biased toward silence - any name declared anywhere inside the body counts as
local, so shadowing never produces a false alarm - because a checker people
switch off is worth less than one that only speaks when it is right. Races are
also printed as warnings on every `run`.

`--profile` gives per-function call counts, steps and inclusive time.

---

## Breadth, and where the names flatter it

Smarsh covers a wide surface, and breadth invites the reasonable suspicion that
some of it is thin. [docs/capabilities.md](docs/capabilities.md) is the
accounting: every subsystem, what it actually does, and where the name promises
more than the implementation delivers - a quantum *simulator* with no speedup, a
lineage chain that is cryptographic rather than hardware-enforced, `energy()` as
a disclosed cost model rather than a power reading, unaudited cryptography
behind its own capability.

Several entries exist purely to stop a name being read as more than it is.

**Speed.** `npm run bench` compares the two engines. The AST compiles to
JavaScript closures once rather than being re-walked (`src/compile.js`): about
**1.9x overall** against the old tree-walker, 2.4x on recursion and calls, 2.2x
on tight loops. `for i in range(n)` no longer builds the list first.

It is still an interpreter, and slower than Python - about **3.2-3.4× behind
CPython** on `fib(27)`, and **~32× behind a JIT**. `npm run bench:compare`
measures all three in one session and reports ratios, because absolute
milliseconds are not portable: the same unchanged code measured 531 ms and, an
hour later on a busier machine, 1202 ms.

It was 6.7× behind CPython. Across eleven workload shapes the runtime is
**44% faster** than it was:

| | | | | |
|---|---|---|---|---|
| calls −70% | closures −63% | loop-declare −47% | contracts −42% | records −42% |
| recursion −40% | lists −33% | loop-plain −28% | maps −27% | strings −21% |

Almost all of it was removing allocation rather than adding cleverness. A call
in the common shape - a named function with no capabilities and no contract -
allocates nothing: the frame is reused, arguments travel in JavaScript locals
rather than an array, and the step counter is one compare. `xs.push` no longer
builds a fresh bound function every call. Contracts compile like any other
expression instead of being walked. Carrying no labels no longer allocates a
Set to discover there was nothing to carry.

`npm run ab` is what any of that was measured with, and it exists because the
first three attempts were wrong - see below.

Getting that number right took three attempts, and the wrong ones reached this
file. Timings inside one long-lived process climbed run over run (644 → 1029 ms
across seven iterations of identical code) because each run left heap state the
next one paid for. Fresh processes fixed that but were still incomparable across
minutes. `tools/ab.mjs` is what is actually trustworthy: it builds a tree from
HEAD and one from the working copy and interleaves them, so machine load hits
both sides equally.

Closing the remaining gap needs compile-time frame slots and a typed value
representation - architecture, not tuning. The design above is why it matters
less than it looks: policy code runs once per decision, not in a hot loop.

`--engine tree` runs the original tree-walker, and CI proves the two are
indistinguishable across every example, every standard-library module and 3,000
generated programs - compared on output, failures, step counts and the entire
audit trace, because `smarsh audit` signs a claim that a run replays from its
seed.

## What is honest about this

- `fork` evaluates paths in order, not on OS threads. The semantics - isolation
  and independent randomness - are real; the parallelism is not. Real
  parallelism needs worker threads and a serializable value representation.
  This is also why `smarsh check`'s race detection matters: the defect is real
  even though today's scheduler happens not to expose it.
- Agents run on one thread. Isolation and determinism are real; concurrency is
  cooperative, and nothing crosses a machine boundary yet.
- Threads back tensor work only. `device "workers"` genuinely parallelises
  matrix multiply across cores (~1.5× on 3 threads for a 400×400 multiply -
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
  in its own output - including how many inputs fell outside a function's domain.
- There is no module system yet. One file at a time.

## Layout

```
bin/smarsh.mjs           the CLI: run, check, test, prove, verify, fmt, build, audit, repl

the front end
  src/lexer.js          tokens
  src/parser.js         recursive-descent -> AST
  src/diagnostics.js    error codes, spans, --json
  src/diagnose.js       the checker itself, shared by the CLI and the editor
  src/errors.js         the error type, with notes and help

execution
  src/interpreter.js    the tree-walker, and the specification both engines answer to
  src/compile.js        AST -> monomorphic closures, the engine that runs by default
  src/env.js            lexical scopes, frame pooling, per-name cache invalidation
  src/builtins.js       the prelude
  src/values.js         taint, context windows, ledgers, token counting
  src/records.js        records and the invariants they carry
  src/decimal.js        exact decimals, BigInt coefficient and scale
  src/json.js           JSON, with positions in its errors and exact numbers
  src/regex.js          regular expressions, matched in linear time
  src/net.js            HTTP behind `net`, with an allowlist of hosts
  src/netWorker.mjs     the worker that makes a synchronous fetch possible
  src/tensor.js         dense f64 tensors, broadcasting, matmul
  src/schema.js         structural schemas
  src/rng.js            seeded, forkable PRNG
  src/devices.js        compute backends: cpu, workers
  src/kernelWorker.mjs  the worker on the other end of one

what it checks before and while it runs
  src/types.js          the gradual type checker
  src/analysis.js       static checks: races, escaping control flow, exhaustiveness,
                        undeclared authority, frozen mutation
  src/graph.js          the call graph, derived from the source rather than declared
  src/verify.js         symbolic verification of contracts
  src/logic.js          a decision procedure for quantifier-free linear arithmetic
  src/prove.js          contract-driven test generation
  src/exercise.js       generated inputs thrown at a contract, shared by prove and test

authority and provenance
  src/labels.js         the decentralized label model, both halves
  src/taint.js          flat labels: untrusted, ungrounded, region
  src/grants.js         delegable capabilities, caretakers, revocation
  src/ffi.js            the foreign boundary and what it may open
  src/audit.js          the hash-chained, signable run manifest
  src/crypto.js         Ed25519, SHA-256, and the unaudited Paillier/Schnorr/Pedersen
  src/bigmath.js        modular arithmetic, Miller-Rabin, prime generation, sampling

the rest
  src/agents.js         actors, mailboxes, deterministic scheduler
  src/temporal.js       logical clocks, decaying values
  src/quantum.js        state-vector simulator
  src/snapshot.js       snapshot and restore of a running program
  src/format.js         smarsh fmt
  src/bundle.js         smarsh build -- one standalone .mjs
  src/testrunner.js     smarsh test
  src/index.js          the embedding API: run it, bound it, read the receipt
  src/prompt.js         the language on one page, importable for a model's context
  src/lsp.js            the language server: diagnostics, completion, hover
  src/debug.js          breakpoints, stepping, and the prompt that reads them

editors/vscode/         the VS Code extension -- grammar, and a client that
                        starts the server above

std/                    the standard library, written in Smarsh
examples/               15 programs, every one of them run by CI
tests/                  942 tests across 39 files
tools/                  the differential oracle, the fuzzer, the A/B harness
```

## Next

In order of value: worker-backed `fork` so reasoning paths get the parallelism
tensor work already has; a cross-machine transport for agents, which turns
`snapshot`/`restore` plus mailboxes into actual distribution; and a typed value
representation, which is where the next large piece of speed is.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: a feature's name must
be true, and any limitation goes in the caveats list in the same pull request
that adds the feature.

## Documentation

| | |
|---|---|
| [For a model writing it](docs/for-llms.md) | The whole language in one page, traps first |
| [Getting started](docs/getting-started.md) | Twenty minutes, assumes nothing |
| [Reference](docs/reference.md) | Every keyword, builtin and command |
| [Security](SECURITY.md) | Threat model, what is audited and what is not |
| [Versioning](VERSIONING.md) | What is stable, what can move under you |
| [Capabilities](docs/capabilities.md) | Every subsystem, and where its name flatters it |
| [Limitations](LIMITATIONS.md) | Everything known to be wrong, missing, or weaker than it sounds |
| [Changelog](CHANGELOG.md) | What changed, including every break |
| [Contributing](CONTRIBUTING.md) | How to add something without overclaiming |
| [Releasing](RELEASING.md) | The checklist, and why each step is on it |
