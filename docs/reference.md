# Pēdāg reference

Complete list of keywords, block forms and builtins. For what any of it is
*for*, see the README.

## Declarations

| Form | Meaning |
|---|---|
| `let x = e` / `let x: T = e` | immutable binding |
| `var x = e` / `var x: T = e` | mutable binding |
| `record Name(a, b)` | immutable data carrier (contextual keyword) |
| `choice Name { A(x)  B(y)  C }` | a closed set of variants (contextual keyword) |
| `fn name(a: T, b) -> T { }` | function; annotations optional |
| `fn name(a, b) { }` | function |
| `fn(a, b) { }` | anonymous function (an expression) |
| `agent Name(args) { var s = ...  on msg(a) { } }` | actor template |
| `import "./m.pedag"` | bring a module's top level into scope |
| `import "./m.pedag" as m` | bind that top level as a map |
| `redefine fn name(...) { }` | replace a live function (validated) |
| `redefine on Agent.msg(...) { }` | replace a live handler (state survives) |

Functions may carry clauses, in this order: `needs cap, cap`,
`requires <expr>`, `ensures <expr>`. `result` is bound inside `ensures`, and
`old(expr)` names the value `expr` had on entry.

Records may carry `invariant <expr>`, checked at construction and after
`.with()`. Loops may carry `invariant <expr>` and one `variant <expr>`; the
variant must stay at or above zero and strictly decrease on every pass.

## Statements and blocks

| Form | Meaning |
|---|---|
| `if e { } else { }` | conditional |
| `while e { }` | loop |
| `for x in e { }` | iterate a list, string, map's keys, or tensor |
| `break` / `continue` / `return e` | control flow; a keyword with no enclosing loop or function is an error, reported by `check` |
| `attempt { } rescue e { }` | catch a failure; `e` is a map of `kind`/`message`/`line` |
| `maybe p { } else { }` | take the branch with probability `p` |
| `grounded { }` | refuse to read `ungrounded` or `untrusted` values |
| `region "eu" { }` | refuse to read values restricted elsewhere |
| `atomic { }` | every ledger append inside lands, or none does |
| `secret { }` | shred every secret created inside on exit |
| `budget steps N { }` / `budget tokens N { }` / `budget memory N { }` | hard ceiling; not catchable from inside |
| `using grant { }` | hold a delegated capability, for this block only |
| `authority "alice" { }` | act for a principal (needs `--principal alice`) |
| `release_to "bob" { }` | data leaving to a party; labels are checked here |
| `device "cpu" { }` / `device "workers" [n] { }` | choose the compute backend |

## Expressions

`"text ${expr}"` — string interpolation; `\${` is a literal.

`match subject { pattern [when guard] => expr, ... }` — patterns are literals,
`Record(p, ...)`, `[p, ...]`, a name (binds), or `_` (wildcard).

`choose { w => e, w => e }` — pick one arm, weighted.
`fork n { ... }` — n independent paths; `_` is the path index; yields a list.
`spawn Name(args)` — create an agent.
`tensor [[1,2],[3,4]]` — tensor literal.

Operators, loosest to tightest:
`=` · `or` `||` · `and` `&&` · `==` `!=` · `<` `<=` `>` `>=` · `+` `-` ·
`*` `/` `%` `@` · unary `-` `not` `!` · `**` · call/index/member.

`@` is matrix multiply. `+ - * / % **` broadcast over tensors, and `+ - *`
work on ciphertexts.

## Capabilities

Granted with `--grant`, declared with `needs`. A function holds exactly what it
declared, never what its caller held.

| Capability | Gates |
|---|---|
| `fs` | `read`, `write`, `weights`, arenas that spill |
| `clock` | `now` |
| `crypto` | Ed25519 keypairs, signing, OS entropy — platform-backed |
| `unaudited_crypto` | Paillier, Schnorr, Pedersen — hand-rolled, not constant time |
| `ffi` | `foreign` — calling JavaScript. Also needs `--foreign a,b` naming which modules; `'*'` for any |

## Builtins

**Core** — `print` `str` `num` `len` `type` `assert` `range`

**Math** — `abs` `floor` `ceil` `round` `signum` `sqrt` `exp` `log` `sin` `cos`
`tan` `min` `max` `clamp`

**Random (seeded)** — `random` `randint` `sample` `shuffle`

**Tensors** — `zeros` `ones` `full` `eye` `arange` `randn` `dot` `cosine`
`relu` `sigmoid` `tanh` `softmax` `argmax`
Members: `.shape` `.rank` `.size` `.T` `.sum()` `.mean()` `.max()` `.min()`
`.norm()` `.tolist()` `.reshape(s)` `.map(f)`

**Provenance** — `untrusted` `ungrounded` `restrict` `trust` `labels`
`is_tainted`

**Labels (decentralized label model)** — `classify(v, owner[, readers])`
`policy_of` `owners_of` `readers_of` `can_read` `declassify(v, owner, reason)`
`acting_for`

**Delegable capabilities** — `grant(cap[, note])` `caretaker` `revoke`
`is_live`; a grant has `.attenuate({ "uses": n })` / `{ "for": ticks }`,
`.describe()`, `.uses_left`, `.live`

**Memory** — `context(budget[, policy])` `tokens` `distill`
Context members: `.tokens` `.budget` `.evicted` `.push(t)` `.pin(t)` `.text()`
`.clear()`

**Ledgers** — `ledger(name)` with `.append(v)` `.verify()` `.head` `.len()`
`.entries()`

**Cryptography** — `sha256` `paillier_keygen` `encrypt` `decrypt` `zk_public`
`zk_prove` `zk_verify` `commit` `commit_open` `keypair` `sign`
`verify_signature` `lineage` `secret_of` `random_secret` `reveal`

**Quantum** — `qubits(n)` `qh` `qx` `qy` `qz` `qs` `qt` `qrx` `qry` `qrz`
`cnot` `cz` `qswap` `measure` `measure_all` `probabilities`

**Time** — `clock(node)` `before` `liquid(v, halflife)` `advance` `time`
`schedule(delay, fn)` `simulate([until])` `scheduled`

**Agents** — `send(to, msg, ...)` `run_agents([max])` `pending` `agents`
Inside a handler: `self`, `sender`

**Devices** — `devices` `device_stats` `topology` `pressure` `arena(bytes[,
dir])` `weights(path, shape, dtype)`

**Lifecycle** — `rollback` `versions` `callgraph` `callers` `dependents`
`recursive_cycles` `snapshot` `snapshot_report` `restore` `watch` `leaks`

**Schemas** — `schema(name, fields)` `negotiate` `adapt` `migrate`

**Cost** — `energy`

**Effects (capability-gated)** — `read` `write` `now`

## Types

Optional everywhere. `num` `str` `bool` `nil` `dyn` `dec` `tensor`, `list<T>`,
`map<T>`, `fn(A, B) -> R`, plus the runtime type names (`context`, `ledger`,
`agent`, `cipher`, `secret`, `qubits`, `clock`, `stamp`, `liquid`, `schema`,
`arena`, `weights`, and any `record` you declare).

`dyn` is consistent with every type, so unannotated code never fails to check.

## Standard library

`import "std/list" as list` — resolves to the library shipped with the runtime,
from anywhere. All four modules are written in Pēdāg.

- **std/list** — `take` `drop` `find` `index_of` `any` `all` `count` `zip`
  `enumerate` `flatten` `unique` `chunk` `windows` `sort_by` `min_by` `max_by`
  `group_by` `partition` `repeat` `first` `last` `is_empty`
- **std/str** — `repeat` `pad_left` `pad_right` `lines` `words` `strip_prefix`
  `strip_suffix` `count_of` `capitalise` `title` `truncate` `reverse`
  `is_palindrome` `is_blank` `is_empty`
- **std/math** — `sum` `mean` `median` `variance` `stdev` `percentile` `lerp`
  `gcd` `lcm` `factorial` `is_close` `compound`
- **std/result** — `Ok` `Err` `Some` `None` records, plus `ok` `err` `some`
  `none` `from_nil` `is_ok` `is_err` `is_some` `is_none` `unwrap_or` `expect`
  `map_ok` `map_err` `and_then` `or_else` `all_ok` `oks` `errors`

## Interop

`foreign("node:os")` loads a JavaScript module. Needs the `ffi` capability
*and* the module named by `--foreign`; granting `ffi` alone opens nothing.
Values are converted rather than shared, and everything returned is labelled
`untrusted`.

## Command line

```
pedag run <file> [--seed n] [--grant a,b] [--trace] [--profile]
pedag check <file>              types, undefined names, fork races, taint
pedag verify <file>             prove contracts for every input
pedag test [path]               tests, contracts, types and races together
pedag fmt <path> [--check]      one canonical layout, no options
pedag explain <code>            a longer explanation of an error code
pedag prove <file> [--trials n] [--seed n]
pedag build <file> [-o out.mjs]
pedag repl [--seed n] [--grant a,b]
pedag eval "<source>"
```

## Error kinds

`SyntaxError` `NameError` `TypeError` `ValueError` `IndexError` `KeyError`
`ArityError` `ShapeError` `AttributeError` `ZeroDivisionError` `ImmutableError`
`RecursionError` `AssertError` `IOError` `ContractError` `CapabilityError`
`TaintError` `SecretError` `CryptoError` `AgentError` `AgentIsolationError`
`BudgetError` `RedefineError` `RestoreError` `ImportError` `SchemaError`
`DeviceError` `MemoryError` `StepLimitError` `ControlFlowError`

## Exact numbers

`19.99d` is a decimal literal: the digits are read from the source and never
pass through a float, which is why `dec` otherwise takes a string —
`dec(0.1)` would have lost the value before `dec` saw it. `2d` is a whole
decimal. An exponent cannot carry the suffix, so `1e3d` is refused: the value
would have come through a float to get there.

`d` is only a suffix immediately after digits and not followed by more of a
name, so `d`, `data` and `dozen` remain ordinary identifiers.

| | |
|---|---|
| `-amount` | negates a decimal |
| `amount * 3` | a whole number is allowed |
| `amount + 0.1` | refused: a float near exact arithmetic |
| `total.div(3d, 2)` | division states its scale, rounding half to even |
| `dec("19.99")` | still works, and is what a computed string needs |

## Choices

A `choice` is one type whose values are exactly one of a fixed set of variants.

```
choice Payment {
  Card(last4, amount)
  Transfer(iban, amount)
  Cash(amount)
  Refused(reason)
}
```

Each variant is an ordinary record: it constructs the same way, has the same
fields, the same structural equality, the same printed form, the same `.with()`,
and it is matched by the same patterns. A variant may carry an `invariant`, and
it is checked when one is built, exactly as for a record.

What the choice adds is that the set is **closed**, and a closed set is what
lets `pedag check` prove a `match` handles every case:

```
error[E0605]: this match on `Payment` does not handle `Refused`
help: add an arm for it, or `_ => ...` if the rest genuinely need no case
```

Without that, the four records above would run identically right up until a
payment was refused and nothing had a case for it.

**A variant carrying nothing is a value, not a constructor.** There is only
ever one of it, so it is written `Pending`, not `Pending()` — when built, and
when matched. In a pattern a bare name normally binds anything, so this is a
deliberate exception: a name that is already a nullary variant tests for that
variant. Without the exception, an arm reading `Pending =>` would silently
swallow every other case that reached it. An ordinary variable keeps binding as
before; only names bound to a nullary variant behave this way.

The checker stays quiet when it cannot be certain. It says nothing if the match
has a `_` or a bare binding, if the arms span two different choices, if a
variant name is declared by more than one choice, or if the only arms are
literals. A `when` guard does not close its variant, because a guarded arm may
decline to fire.

Exhaustiveness is a static check. A program run without `check` still fails
safely — a match with no arm for its subject raises `MatchError` rather than
returning nil.

`std/result` is built from two of them:

```
choice Result { Ok(value)  Err(error) }
choice Option { Some(value)  None }
```

## Budgets

A `budget` block sets a ceiling that the code inside cannot raise, cannot catch
and cannot talk its way out of. A nested budget may only tighten. Only the
boundary turns the stop into an ordinary `BudgetError`, for whoever set it.

| Kind | Counts |
|---|---|
| `steps` | statements and loop iterations executed |
| `tokens` | tokens counted through context windows |
| `memory` | estimated bytes of growth: list literals, `.push`, `map.set` |

`memory` is a deterministic estimate, not a reading of the host heap. Sampling
real memory would make a run depend on what else the machine was doing, and
every replay guarantee in Pēdāg rests on a run being reproducible from its seed.
The figure is therefore a fixed charge per allocating operation: it bounds
runaway growth, and it is not a profiler.

```
budget memory 20000 {
  var xs = []
  while true { xs.push(1) }     // BudgetError, not an out-of-memory kill
}
```
