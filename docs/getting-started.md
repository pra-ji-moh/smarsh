# Getting started

This assumes you have never seen Smarsh and do not want to read a language
specification first. Twenty minutes, and you will have written something real.

## Before you start

Smarsh needs **Node 18 or newer**, and nothing else. Check:

```bash
node --version
```

If that prints a version below 18, or "command not found", install Node from
[nodejs.org](https://nodejs.org) first.

Smarsh itself has **no dependencies**. There is nothing to install beyond it.

## Install

```bash
npm install -g smarsh
```

Check it worked:

```bash
Smarsh --version
```

If you would rather not install globally, `npx smarsh run file.smarsh` works
the same way, and every command below can be prefixed with `npx smarsh`
instead of `Smarsh`.

## Your first program

Put this in `hello.smarsh`:

```smarsh
let name = "world"
print("hello, ${name}")
```

Run it:

```bash
smarsh run hello.smarsh
```

```
hello, world
```

That is the whole loop. No build step, no project file, no configuration.

## The five things that are not like other languages

Everything above is ordinary. This is the part worth twenty minutes.

### 1. A program cannot touch anything unless you let it

Try to write a file:

```smarsh
write("notes.txt", "hello")
```

```
error[E0402]: write needs the 'fs' capability; this frame holds nothing
```

It refuses, because you did not grant it:

```bash
smarsh run hello.smarsh --grant fs
```

This is not a setting to switch off and forget. Inside a program, a function
holds exactly what it declared — never what its caller held:

```smarsh
fn save(text) needs fs {
  write("notes.txt", text)          // fine: it declared fs
}

fn sneaky(text) {
  write("notes.txt", text)          // refused, even when the caller holds fs
}
```

Reading a function's signature tells you the worst it can do.

### 2. Money is exact, and floats are kept away from it

```smarsh
print(0.1 + 0.2 == 0.3)                        // false — `num` is a float
print(dec("0.1") + dec("0.2") == dec("0.3"))   // true
```

Use `dec` for anything that has to reconcile. It will not let a float in:

```smarsh
dec("100.00") + 0.1
```

```
error[E0301]: cannot mix `dec` with the float `0.1`; that would put a
              rounding error into exact arithmetic
help: write it exactly: `dec("0.1")`
```

### 3. `let` means immutable — including the contents

```smarsh
let xs = [1, 2]
xs.push(3)          // ImmutableError: bound with `let`, which freezes it

var ys = [1, 2]
ys.push(3)          // fine
```

If it has to change, bind it with `var`. There are no exceptions to remember.

### 4. Where a value came from travels with it

```smarsh
let reply = ungrounded("the model said revenue was 9.9bn")

grounded {
  print(reply)      // TaintError: a grounded block read an ungrounded value
}
```

The label survives being handled — concatenation, interpolation, method calls,
passing through functions. The only way to remove it is to say why:

```smarsh
let checked = trust(reply, "cross-checked against the filing by a human")
grounded { print(checked) }        // fine, and the reason is in the run trace
```

### 5. What a function promises is checked, and tested for you

```smarsh
fn share(total, n) requires n > 0 ensures result * n == total {
  return total / n
}
```

Those clauses run. And because they are a specification, Smarsh can generate
inputs from them:

```bash
smarsh prove hello.smarsh
```

It throws generated values at every contracted function, discards the ones the
preconditions reject, and reports where a promise did not hold — with the input
that broke it. You wrote no tests to get that.

## The commands you will actually use

```bash
smarsh run file.smarsh        # run it
smarsh check file.smarsh      # types, undefined names, races, taint — without running
smarsh test .               # tests, contracts, types and races together
smarsh fmt .                # one canonical layout, no options to argue about
smarsh explain E0402        # what an error code actually means
```

`smarsh check` is the one to get into your fingers. It catches typos, type
mismatches, data-race conditions and provenance leaks before anything executes,
and it is fast enough to run on every save.

## When something goes wrong

Errors point at the exact source, suggest a fix, and carry a code:

```
error[E0201]: `totl` is not defined
 --> tally.smarsh:6:10
  |
6 |   return totl
  |          ^^^^ not found in this scope
  |
help: there is a name in scope with a similar spelling: `total`
  run `smarsh explain E0201` for a longer explanation
```

If a message is unclear, that is a bug worth reporting — the error text is
treated as part of the product.

## Using code you already have

```smarsh
let os = foreign("node:os")
print(os.platform())
```

Any JavaScript module — built-in, CommonJS, or installed. It needs the `ffi`
capability, and results come back labelled `untrusted`, because once control is
inside JavaScript the runtime cannot see what happened.

## Where to go next

- [The tour](../examples/tour.smarsh) — every core feature in one runnable file:
  `smarsh run examples/tour.smarsh`
- [Money](../examples/money.smarsh) — exact arithmetic, a worked settlement
- [Typed](../examples/typed.smarsh) — how optional types behave
- [Modern](../examples/modern.smarsh) — records, pattern matching, interpolation
- [Reference](reference.md) — every keyword, builtin and command
- [README](../README.md) — what Smarsh is for, and an honest list of what it
  cannot do

## Two things to know before you rely on it

Smarsh is pre-1.0 and has no production users. Pin an exact version — see
[VERSIONING.md](../VERSIONING.md) for what is stable and what is not.

Its hand-rolled cryptography (`unaudited_crypto`) has never been audited and is
not constant time. [SECURITY.md](../SECURITY.md) has the full inventory of what
is platform-backed and what is not.
