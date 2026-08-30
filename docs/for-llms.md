# Smarsh for a model writing it

The whole language, in one page. Written for a program that has to emit correct
Smarsh on the first or second try, not for a person browsing.

Read the **Traps** first. They are the four places where a reflex from Python,
JavaScript or TypeScript produces code that will not run.

---

## Traps

**1. `let` freezes, deeply. Use `var` for anything you change.**

```smarsh
let xs = []
xs.push(1)          // ERROR: let freezes the value

var xs = []
xs.push(1)          // correct
```

It freezes the *value*, not the binding, so it reaches through aliases:
`var ys = [1]` then `let a = ys` makes `ys.push(2)` fail too. Copy instead -
`let a = ys.slice(0, ys.len())`.

**2. A function must declare the authority it uses.**

```smarsh
fn save(t) { write("out.txt", t) }           // ERROR: uses fs
fn save(t) needs fs { write("out.txt", t) }  // correct
```

This travels to callers: calling something that `needs fs` means you need `fs`
too. Only these builtins need anything - `read` `write` `weights` (fs),
`now` (clock), `foreign` (ffi), `keypair` `random_secret` (crypto), and the
`unaudited_crypto` set.

**3. Money is `dec`, built from a string, never mixed with floats.**

```smarsh
let price = 19.99d           // a decimal literal; dec("19.99") also works
price * 3                    // fine: dec times a whole number
-price                       // fine: a refund
price + 0.1                  // ERROR: cannot mix dec with a float
price.div(3d, 2)             // division states its scale
```

The digits in `19.99d` never pass through a float, which is why `dec` takes a
string rather than a number - `dec(0.1)` would already have lost the value.

`0.1 + 0.2 == 0.3` is false. `dec("0.1") + dec("0.2") == dec("0.3")` is true.

**4. A `match` over a `choice` must handle every variant.**

Missing one is a build error, not a runtime surprise. `_ => ...` closes it.

---

## The fix loop

Every command takes `--json`. Do not parse the human output.

```
smarsh check f.smarsh --json   -> { ok, diagnostics: [{ code, message, line, column, helps }] }
smarsh run   f.smarsh --json   -> { ok, stdout, failure: { kind, code, message, line, stack } }
smarsh test  dir     --json   -> { ok, totals, files: [{ passed, failed, contracts }] }
smarsh explain E0406          -> what a code means, and how to fix it
```

`check` finds unknown names, type mismatches, wrong arity, missing `match`
arms, undeclared authority, mutation of a frozen value, taint reaching a sink,
and races in `fork`. Run it before running anything.

---

## Syntax

```smarsh
// comment

let x = 1                  // immutable, and freezes what it holds
var y = 2                  // mutable
let n: num = 3             // annotations optional, checked where present

fn add(a, b) { return a + b }
fn area(w: num, h: num) -> num { return w * h }
fn save(t) needs fs { write("f.txt", t) }
let double = fn(x) { return x * 2 }        // a function value

if x > 0 { } else if x == 0 { } else { }
while i < n { }
for item in [1, 2, 3] { }
for i in range(5) { }                      // range(stop), range(a,b), range(a,b,step)
break    continue    return v

attempt { risky() } rescue e { print(e["kind"]) }    // e has kind, message, line

"text ${expr} more"                        // interpolation
[1, 2, 3]                                  // list
{ "k": v }                                 // map, string keys
nil  true  false
and  or  not                               // not && || !
```

Operators: `+ - * / % **`, `== != < <= > >=`, `@` for matrix multiply.
There is no `++`, no `+=`, no ternary. Write `x = x + 1`.

## Types

```smarsh
record Point(x, y)                               // immutable, structural equality
record Account(balance) invariant balance >= 0   // checked on construction
let p = Point(1, 2)
p.x                                              // field
p.with("x", 9)                                   // a new record, invariant rechecked

choice Status {                            // a closed set of variants
  Pending                                  // no fields: a value, not a call
  Done(at)
  Failed(code)
}
let s = Pending                            // not Pending()

match s {
  Pending    => "waiting",
  Done(at)   => "done at ${at}",
  Failed(c)  => "failed ${c}"
}
```

Patterns: literals, `_`, a name (binds anything), `Name(a, b)` (destructures a
record or variant), `[a, b]` (a list of exactly that length), and `when cond`
on an arm. A bare name that is already a nullary variant tests for that
variant rather than binding.

## Contracts

```smarsh
fn withdraw(acct, amt)
  requires amt > 0
  ensures result.balance == old(acct.balance) - amt
{
  return acct.with("balance", acct.balance - amt)
}
```

`requires` on the way in, `ensures` on the way out with `result` bound,
`old(e)` for the value on entry. `smarsh prove` generates inputs and reports
counterexamples with the arguments that break them, so a contract is a
specification and a test suite at once.

Loops take `invariant` and `variant` before the body.

## Authority and provenance

```smarsh
fn f() needs fs, clock { }                 // declared, never inherited
using grant("fs") { }                      // hold one for a block
let pair = caretaker(grant("fs"))          // pair["grant"]; revoke(pair["revoker"])

untrusted(v)   ungrounded(v)               // label a value
grounded { }                               // refuses to read either label
trust(v, "why")                            // remove labels; the reason is recorded
classify(v, owner, [readers])              // who may READ it
release_to "party" { }                     // checked at the boundary
authority "p" { declassify(v, "p", "why") }   // weakening costs authority

authority "p" { endorse(v, "p", "why") }   // whose word is BEHIND it
vouched_by "p" { }                         // refuses what p does not back
retract(v, "p", "why")                     // withdrawing costs nothing
trusted_by(v, "p")  vouchers_of(v)  writers_of(v)
region "eu" { }
```

The two halves are mirrors, and the mirroring is the part to get right:

|                     | `classify` (read) | `endorse` (write)   |
|---------------------|-------------------|---------------------|
| combining values    | keeps every owner | keeps only the owners on **both** sides |
| needs `authority`   | to **weaken** it (`declassify`) | to **strengthen** it (`endorse`) |
| an unlabelled value | unconstrained     | backed by nobody    |

So `endorse(x, "alice", ...) + 5` is **no longer** vouched for by alice -- a
literal is not something alice stood behind, and a vouch does not survive
contact with anything she did not. That is deliberate, not a bug to work
around. Where the mixing is intended, `endorse` the result again; the audit
trail records every place you did. If the value simply does not need backing
downstream, `retract` it, which claims nothing and costs no authority.

A value that *lost* a vouch prints as `{~alice}` and is not the same as one
that never had it (`{}`). The error tells you which.

Capabilities: `fs clock crypto unaudited_crypto ffi net`. Granted with
`--grant a,b`, principals with `--principal p`. Two of them need a second flag
saying *what for*, and granting them alone opens nothing: `ffi` needs
`--foreign node:path`, and `net` needs `--allow-host api.example.com`
(`*.example.com` for a suffix, `*` for anywhere).

```smarsh
fn rate() needs net {
  let r = http_get("https://api.example.com/rate")   // http_post, http(method, url) too
  assert(r["status"] == 200, "upstream said " + str(r["status"]))
  return json_parse(r["body"])["rate"]
}
```

Three things about `net` that will otherwise surprise you. Every response is
**untrusted**, so `grounded { }` refuses it until you have checked it. Redirects
are **not followed** -- you get the 3xx and its `Location`, because following one
could reach a host the run was never permitted to reach. And a non-2xx status is
a **response, not an error**: the runtime does not decide what a 404 means to
your program.

## Blocks

```smarsh
budget steps 5000 { }              // also tokens, memory. Not catchable inside
atomic { }                         // every ledger append lands, or none does
secret { }                         // secrets shredded on exit
device "workers" { }               // cpu | workers
fork 4 { _ }                       // _ is the path index; isolated, seeded
maybe 0.3 { } else { }             // seeded, so it replays
```

## Builtins

Core: `print str num len type assert range abs floor ceil round min max clamp
sqrt exp log signum`.

Random, all seeded: `random randint sample shuffle`.

Lists: `.len .push .pop .slice .contains .join .map .filter .reduce(f, init)
.sort .reverse .sum`
Strings: `.len .upper .lower .trim .split .replace .slice .contains .starts
.ends .tokens`
Maps: `.len .get .set .has .remove .keys .values`

Exact numbers: `19.99d` literals, `dec is_dec dec_sum`, and `.div(amount, scale)`.

Regex: `re_test re_match re_all re_replace re_split`. Write patterns as raw
strings -- `r"^\d{3}$"` -- which take their characters literally.

The engine matches in **linear time**, so there are no backreferences, no
lookahead and no lazy quantifiers: those need backtracking, and backtracking is
how `(a+)+b` takes hours on forty characters. Everything else is here.

JSON: `json_parse to_json is_json`. A fractional number parses to an exact
decimal, not a float, so `19.99` survives the round trip. Taint survives it too:
`json_parse(untrusted(body))` is untrusted all the way down.

Tensors: `tensor [[1,2],[3,4]]`, `@`, and `.T .shape .rank .size .sum .mean
.max .min .norm .reshape .map .tolist`, plus `zeros ones eye full arange randn
dot cosine relu sigmoid tanh softmax argmax`.

Also present, by area: agents (`send run_agents pending agents`), context
windows (`context tokens distill`), ledgers (`ledger`), cryptography (`sha256 sign
verify_signature keypair`, and behind `unaudited_crypto` (`paillier_keygen` refuses a modulus below 2048 bits; `paillier_keygen_insecure(512)` is the demonstration form and warns):
`paillier_keygen encrypt decrypt commit commit_open zk_public zk_prove
zk_verify`), quantum simulation (`qubits qh qx cnot
measure`), time (`clock advance liquid`), schema (`schema negotiate adapt
migrate`), introspection (`callgraph callers snapshot restore watch leaks
energy`). `smarsh explain` and `docs/reference.md` cover the rest.

## A whole program

```smarsh
choice Status { Balanced  Short(amount) }

record Invoice(id, owed, paid)

fn status(inv) {
  if inv.paid == inv.owed { return Balanced }
  return Short(inv.owed - inv.paid)
}

fn describe(s) {
  return match s {
    Balanced => "balanced",
    Short(a) => "short by ${a}"
  }
}

var seen = []
for inv in [Invoice("A", dec("10.00"), dec("10.00")), Invoice("B", dec("20.00"), dec("18.50"))] {
  seen.push("${inv.id}: ${describe(status(inv))}")
}
print(seen.join("  |  "))
```

Then `smarsh check p.smarsh --json`, and `smarsh run p.smarsh --json`.
