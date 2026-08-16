# Contributing to Pēdāg

## The one rule

**A feature's name must be true.**

Pēdāg ships things that sound impossible — homomorphic arithmetic, zero-knowledge
proofs, quantum simulation, un-overridable kill switches. They are in the tree
because each one actually does what its name says, and where a name would
overclaim, the name changed rather than the claim.

Two examples of that rule in action:

- The lineage chain is `lineage`, not `hardware_lineage`. It proves who asserted
  each step and that the sequence is intact. It cannot prove a fact about a byte
  that crossed a machine we don't control, so it does not say it can.
- The quantum register is documented as a simulator on every surface it appears
  on. Superposition, entanglement and interference are real; the speedup is not.

If you are adding something and find yourself writing "effectively" or "in
practice this is basically" — stop and rename the feature.

## Getting set up

Node 18 or newer. There are no dependencies to install.

```bash
node --test tests/*.test.mjs
node bin/pedag.mjs run examples/tour.pedag
```

## What a pull request needs

1. **Tests that could fail.** A test that passes with the feature deleted is
   not a test. Prefer asserting a property (`the worker backend computes exactly
   what the cpu backend does`) over asserting an implementation detail.
2. **The honest caveat, in the README.** If a feature is partial, bounded, or
   an approximation, the limitation goes in the caveats list in the same PR.
   Not the next one.
3. **`pedag check` clean** on any `.pedag` you add.
4. **No dependencies.** The runtime has none and is not going to acquire any.
   `node:` builtins are fine.

## Style

Match what is already there. Some specifics that are easy to miss:

- Error messages say what happened and what to do, in a sentence a person would
  say out loud. `a grounded block read an ungrounded argument; check or launder
  it with trust() outside the block first` — not `TaintError: label violation`.
- Comments explain *why*, not *what*. If a block needs a comment to say what it
  does, the code is the problem.
- Capabilities gate effects, not convenience. Anything that reads real entropy,
  the clock, the filesystem or the network needs one — that is what keeps a
  program reproducible by default.

## Adding a new value type

Types added by later layers name themselves rather than teaching the interpreter
about each one:

```js
export class Thing {
  get pedagType() { return 'thing'; }        // typeName() picks this up
  toString() { return '<thing>'; }          // print() picks this up
  pedagMembers(interp, line) {               // `.field` and `.method()` dispatch
    return { size: 3, poke: nf('poke', 0, () => 42) };
  }
}
```

No interpreter changes needed. `src/temporal.js` is a short example to copy.

## Where things are

See the layout table in the README. The short version: `src/lexer.js` →
`src/parser.js` → `src/interpreter.js` is the spine, and everything else hangs
off `builtins.js`.

## Reporting a security issue

pedag runs untrusted-ish code by design — capabilities, taint tracking and
budgets are all load-bearing. If you find a way to escape any of them (reach the
filesystem without `fs`, launder a taint label without `trust()`, or survive a
`budget` block), that is a security bug. Open an issue with a reproducing
`.pedag` file.
