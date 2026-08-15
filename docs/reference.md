# Sarvm reference

Complete list of keywords, block forms and builtins. For what any of it is
*for*, see the README.

## Declarations

| Form | Meaning |
|---|---|
| `let x = e` / `let x: T = e` | immutable binding |
| `var x = e` / `var x: T = e` | mutable binding |
| `record Name(a, b)` | immutable data carrier (contextual keyword) |
| `fn name(a: T, b) -> T { }` | function; annotations optional |
| `fn name(a, b) { }` | function |
| `fn(a, b) { }` | anonymous function (an expression) |
| `agent Name(args) { var s = ...  on msg(a) { } }` | actor template |
| `import "./m.sarvm"` | bring a module's top level into scope |
| `import "./m.sarvm" as m` | bind that top level as a map |
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
| `break` / `continue` / `return e` | control flow |
| `attempt { } rescue e { }` | catch a failure; `e` is a map of `kind`/`message`/`line` |
| `maybe p { } else { }` | take the branch with probability `p` |
| `grounded { }` | refuse to read `ungrounded` or `untrusted` values |
| `region "eu" { }` | refuse to read values restricted elsewhere |
| `atomic { }` | every ledger append inside lands, or none does |
| `secret { }` | shred every secret created inside on exit |
| `budget steps N { }` / `budget tokens N { }` | hard ceiling; not catchable from inside |
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
| `ffi` | `foreign` — calling JavaScript |

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
from anywhere. All four modules are written in Sarvm.

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

`foreign("node:os")` loads a JavaScript module. Needs the `ffi` capability.
Values are converted rather than shared, and everything returned is labelled
`untrusted`.

## Command line

```
sarvm run <file> [--seed n] [--grant a,b] [--trace] [--profile]
sarvm check <file>              types, undefined names, fork races, taint
sarvm verify <file>             prove contracts for every input
sarvm test [path]               tests, contracts, types and races together
sarvm fmt <path> [--check]      one canonical layout, no options
sarvm explain <code>            a longer explanation of an error code
sarvm prove <file> [--trials n] [--seed n]
sarvm build <file> [-o out.mjs]
sarvm repl [--seed n] [--grant a,b]
sarvm eval "<source>"
```

## Error kinds

`SyntaxError` `NameError` `TypeError` `ValueError` `IndexError` `KeyError`
`ArityError` `ShapeError` `AttributeError` `ZeroDivisionError` `ImmutableError`
`RecursionError` `AssertError` `IOError` `ContractError` `CapabilityError`
`TaintError` `SecretError` `CryptoError` `AgentError` `AgentIsolationError`
`BudgetError` `RedefineError` `RestoreError` `ImportError` `SchemaError`
`DeviceError` `MemoryError` `StepLimitError`
