# Getting started

This assumes you have never seen Sarvm and do not want to read a language
specification first. Twenty minutes, and you will have written something real.

## Before you start

Sarvm needs **Node 18 or newer**, and nothing else. Check:

```bash
node --version
```

If that prints a version below 18, or "command not found", install Node from
[nodejs.org](https://nodejs.org) first.

Sarvm itself has **no dependencies**. There is nothing to install beyond it.

## Install

```bash
npm install -g sarvm
```

Check it worked:

```bash
Sarvm --version
```

If you would rather not install globally, `npx sarvm run file.sarvm` works
the same way, and every command below can be prefixed with `npx sarvm`
instead of `Sarvm`.

## Your first program

Put this in `hello.sarvm`:

```sarvm
let name = "world"
print("hello, ${name}")
```

Run it:

```bash
sarvm run hello.sarvm
```

```
hello, world
```

That is the whole loop. No build step, no project file, no configuration.

## The five things that are not like other languages

Everything above is ordinary. This is the part worth twenty minutes.

### 1. A program cannot touch anything unless you let it

Try to write a file:

```sarvm
write("notes.txt", "hello")
```

```
error[E0402]: write needs the 'fs' capability; this frame holds nothing
```

It refuses, because you did not grant it:

```bash
sarvm run hello.sarvm --grant fs
```

This is not a setting to switch off and forget. Inside a program, a function
holds exactly what it declared — never what its caller held:

```sarvm
fn save(text) needs fs {
  write("notes.txt", text)          // fine: it declared fs
}

fn sneaky(text) {
  write("notes.txt", text)          // refused, even when the caller holds fs
}
```

Reading a function's signature tells you the worst it can do.

### 2. Money is exact, and floats are kept away from it

```sarvm
print(0.1 + 0.2 == 0.3)                        // false — `num` is a float
print(dec("0.1") + dec("0.2") == dec("0.3"))   // true
```

Use `dec` for anything that has to reconcile. It will not let a float in:

```sarvm
dec("100.00") + 0.1
```

```
error[E0301]: cannot mix `dec` with the float `0.1`; that would put a
              rounding error into exact arithmetic
help: write it exactly: `dec("0.1")`
```

### 3. `let` means immutable — including the contents

```sarvm
let xs = [1, 2]
xs.push(3)          // ImmutableError: bound with `let`, which freezes it

var ys = [1, 2]
ys.push(3)          // fine
```

If it has to change, bind it with `var`. There are no exceptions to remember.

### 4. Where a value came from travels with it

```sarvm
let reply = ungrounded("the model said revenue was 9.9bn")

grounded {
  print(reply)      // TaintError: a grounded block read an ungrounded value
}
```

The label survives being handled — concatenation, interpolation, method calls,
passing through functions. The only way to remove it is to say why:

```sarvm
let checked = trust(reply, "cross-checked against the filing by a human")
grounded { print(checked) }        // fine, and the reason is in the run trace
```

### 5. What a function promises is checked, and tested for you

```sarvm
fn share(total, n) requires n > 0 ensures result * n == total {
  return total / n
}
```

Those clauses run. And because they are a specification, Sarvm can generate
inputs from them:

```bash
sarvm prove hello.sarvm
```

It throws generated values at every contracted function, discards the ones the
preconditions reject, and reports where a promise did not hold — with the input
that broke it. You wrote no tests to get that.

## The commands you will actually use

```bash
sarvm run file.sarvm        # run it
sarvm check file.sarvm      # types, undefined names, races, taint — without running
sarvm test .               # tests, contracts, types and races together
sarvm fmt .                # one canonical layout, no options to argue about
sarvm explain E0402        # what an error code actually means
```

`sarvm check` is the one to get into your fingers. It catches typos, type
mismatches, data-race conditions and provenance leaks before anything executes,
and it is fast enough to run on every save.

## When something goes wrong

Errors point at the exact source, suggest a fix, and carry a code:

```
error[E0201]: `totl` is not defined
 --> tally.sarvm:6:10
  |
6 |   return totl
  |          ^^^^ not found in this scope
  |
help: there is a name in scope with a similar spelling: `total`
  run `sarvm explain E0201` for a longer explanation
```

If a message is unclear, that is a bug worth reporting — the error text is
treated as part of the product.

## Using code you already have

```sarvm
let os = foreign("node:os")
print(os.platform())
```

Any JavaScript module — built-in, CommonJS, or installed. It needs the `ffi`
capability, and results come back labelled `untrusted`, because once control is
inside JavaScript the runtime cannot see what happened.

## Where to go next

- [The tour](../examples/tour.sarvm) — every core feature in one runnable file:
  `sarvm run examples/tour.sarvm`
- [Money](../examples/money.sarvm) — exact arithmetic, a worked settlement
- [Typed](../examples/typed.sarvm) — how optional types behave
- [Modern](../examples/modern.sarvm) — records, pattern matching, interpolation
- [Reference](reference.md) — every keyword, builtin and command
- [README](../README.md) — what Sarvm is for, and an honest list of what it
  cannot do

## Two things to know before you rely on it

Sarvm is pre-1.0 and has no production users. Pin an exact version — see
[VERSIONING.md](../VERSIONING.md) for what is stable and what is not.

Its hand-rolled cryptography (`unaudited_crypto`) has never been audited and is
not constant time. [SECURITY.md](../SECURITY.md) has the full inventory of what
is platform-backed and what is not.
