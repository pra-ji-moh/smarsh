# Releasing

A checklist, so a release is a procedure rather than a memory test. Every step
is here because skipping it has a specific failure mode.

## Before tagging

```bash
node --test tests/*.test.mjs        # all green, no skips
node bin/smarsh.mjs test std/         # the standard library's own suite
node bin/smarsh.mjs fmt . --check     # everything formatted
node bench/run.mjs                  # note the numbers; investigate a regression
```

Then the checks CI cannot make for you:

- [ ] `CHANGELOG.md` has an entry for this version, and every breaking change is
      under a `### Breaking` heading with what to do about it.
- [ ] Anything new is in `docs/reference.md`.
- [ ] Anything the release *cannot* do is in the README's caveats. A feature
      whose limitation is not written down is not finished.
- [ ] `package.json` version matches the changelog heading.
- [ ] New capabilities are listed in `SECURITY.md`'s threat model table.

## The step that is easy to skip and should not be

**Install the package the way a stranger would, in a clean directory, and run
it.**

```bash
npm pack --pack-destination /tmp
mkdir /tmp/Smarsh-check && cd /tmp/Smarsh-check && npm init -y
npm install /tmp/smarsh-<version>.tgz
printf 'import "std/math" as math\nprint(math.mean([2, 4, 6]))\n' > hello.smarsh
npx smarsh run hello.smarsh
```

This exists because `std/` was once missing from the `files` list in
`package.json`. Everything passed locally; an installed copy had no standard
library at all. Tests do not catch packaging, only a real install does.

Check the tarball contents while you are there:

```bash
npm pack --dry-run
```

`bin/`, `src/`, `std/`, `examples/`, `docs/`, `README.md`, `LICENSE`. Nothing
missing, no scratch files, no `.tgz` from a previous run.

## Tagging and publishing

```bash
git tag -a v<version> -m "v<version>"
git push origin main --tags
npm publish --access public
```

Then confirm the published artefact, not the local one:

```bash
cd /tmp && npm install smarsh@<version> && npx smarsh --version
```

## After

- [ ] GitHub release notes: paste the changelog section, nothing else.
- [ ] If the release contains a security fix, say so plainly at the top of the
      notes and update `SECURITY.md` if the threat model moved.
- [ ] Open `## [Unreleased]` at the top of the changelog for the next one.

## If a release is broken

Do not unpublish - that breaks anyone who already installed it. Fix forward:
release a patch, and add a note to the changelog entry of the broken version
saying what was wrong and which version to use instead.
