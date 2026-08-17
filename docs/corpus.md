# Corpus validation

norefs is validated against real, widely used TypeScript repositories, not
only its own fixtures. Each run is a shallow clone, `npm install
--ignore-scripts`, then `norefs -p <tsconfig>` — no per-repo configuration,
no ignore lists. This file records the results and doubles as a regression
log: rerun the repos, compare the counts, explain every jump.

Every heading carries the date of its run and the release it ran on, and the
counts under it are the counts **that** release printed on **that** clone. A
later release re-runs the repo and reports the difference in its own section.
So the numbers on this page are a history, not a snapshot: compare within a
section, never across two.

## Method

- Clone at depth 1, note the date.
- Run against the repo's own build tsconfig, out of the box.
- Read the verdict distribution before individual findings: the shape of the
  report says more than its size.
- Spot-check the biggest per-file buckets by hand before believing them.

## hono (2026-08-13, pre-0.4.0, tsconfig.build.json)

**195 findings: 104 dead, 79 over-exported, 10 write-only, 1 likely
contract, 1 shadowed — in ~2 seconds** over a library with 76 published
subpath entries (242 with `--anon`, which includes the anonymous findings
hidden by default).

The public-API handling carries the run: everything hono's exports map
publishes — resolved through `export *` chains and mapped from `dist` paths
back to source — is exempt down to the type members, so the report contains
internals only. What it flags holds up under review: AWS event types the
lambda adapter declares but never reads (`src/adapter/aws-lambda/types.ts`),
handler types exported but consumed nowhere else, and one structurally
duplicated type the shadowed verdict pins with file and line.

## zod (2026-08-13, pre-0.4.0, packages/zod/tsconfig.json)

**43 findings: 23 dead, 16 over-exported, 1 likely contract, 3 test-only —
in ~4 seconds**, running inside a workspace package of a monorepo (81 with
`--anon`).

The test-only findings are a category no reference count sees: code with
plenty of references, all of them in test files. `StandardSchemaWithJSON`
is an interface only zod's own tests consume; `_FlattenedError.fieldErrors`
is read nowhere but a test. Production-dead, test-alive — reported with the
one verdict that says so, and never auto-fixed, because deleting them means
deleting their tests.

The run demonstrates three boundaries handled without configuration: the
workspace root's hoisted tooling satisfies the dependency checks, test
fixtures produce no member noise, and `export * as util` namespace
re-exports count as public API whole. What remains is the interesting part:
zod's v3 legacy helpers carry genuinely unreferenced members, exactly the
layer a years-old, heavily maintained codebase would accumulate.

## inshellisense (2026-08-13, pre-0.4.0, application-shaped)

**43 findings: 24 dead, 19 over-exported — in ~2 seconds** on Microsoft's
terminal-autocomplete CLI, the corpus's first application (entries come from
`bin`, not an exports map).

Hand-verified: `strip-ansi` and `uuid` sit in `dependencies` with no import
anywhere; `clearGeneratorState` is a dead export. The run also shows the
honesty machinery working: one import specifier
(`@withfig/autocomplete/build/index.js`) does not resolve for TypeScript, and
norefs leads the report with a warning that references through it are
invisible — so a reader knows which findings deserve distrust before acting
on any. `getSuggestions`, consumed through a dynamic import whose types that
unresolved specifier poisons, is exactly the finding that warning brackets.
Making verdicts soften automatically inside the blast radius of an
unresolved import is the follow-up this run argues for.

## norefs on norefs (2026-08-13, pre-0.4.0)

**No unused code found.** The tool runs clean on its own codebase because it
is kept that way: `norefs --fix` fixed its own 12 findings in one verified
run — 11 dropped `export` keywords and one dead function, type-checked in
memory before a byte reached disk.

The run also demonstrated why verification is layered. Two exports' only
consumer is the test suite, which lives outside the analyzed tsconfig — a
consumer no static analysis of the program can see. The type-check probe is
scoped to the program by definition, so this is precisely the gap
`--verify-command "vitest run"` closes: the test suite votes on every fix.
Both exports now carry a `norefs-ignore` with the reason, which is the
designed answer for consumers beyond the program's horizon.

## The 0.7.0 re-run (2026-08-14, v0.7.0)

0.7.0 changed what counts as a dependency in use and what counts as an entry
point, so both are claims a real repository has to check. The two repos below
were cloned fresh and run twice, once per version, against the same clone —
upstream has moved since August 13, and a same-clone comparison is the only one
that isolates the release.

**inshellisense: 55 findings before, 53 after.** The two that went away were
`jest` and `ts-jest`, both reported dead by 0.6.0 and both in use. `jest.config.cjs`
writes `"ts-jest"` as the transform for TypeScript files, which is that package
being used; `ts-jest` in turn lists `jest` as a peer dependency, which is that
package loading it. Neither is imported anywhere in the source, and no script
names either one. This is the exact false-positive class the 0.6.0 review
reported, found in the wild.

**hono: 158 findings before, 158 after — byte-identical reports.** The point of
running it was the risk in the other direction: reading paths in configs more
loosely could invent an entry point, and an invented entry silences real findings
without a trace. On a library with 76 published subpath entries and a config per
runtime, nothing moved.

The re-run also killed a feature. A draft of this release read `declare module`
in a package's own types as "the environment provides this" in both directions,
and reported a host runtime sitting in `dependencies` as misplaced. On
inshellisense that fired four times — `@xterm/addon-unicode11`, `@xterm/headless`,
`node-pty`, `toml` — and all four are ordinary packages that belong exactly where
they sit. `declare module` is simply how a library older than ES modules ships
its types. The signal survives in the direction that reports nothing, which is
the only direction it can carry.

zod was not re-run; nothing in this release touches the workspace handling that
run exercises.

## apollo-client (2026-08-17, unreleased, tsconfig.json)

**141 findings: 33 dead, 27 over-exported, 1 write-only, 64 test-only, 2
unlisted dependencies, 14 misplaced — in 12.4 seconds** over 541 files. The
largest repository in the corpus, and the source the speed table now cites:
[Speed](speed.md) records the same clone under three `--only` settings, so the
numbers on that page are a command rather than a memory.

The run was made to answer one question — whether pruning kinds changes the
answers — and the first answer was no. Asked for everything, norefs reported 88
module-level findings; asked for the same kinds without members, 89.

The extra one was a false positive, and the disagreement was the only reason
anybody saw it: `FoodCategory`, exported by a test fixture and consumed in
`types.test.ts` as `const { FoodCategory } = await import(…)`. A dynamic import
destructured on the spot leaves the binding as a symbol of its own, so no
reference lands on the export. Both runs were blind to it. The full run stayed
quiet only because a member run files occurrences under every symbol they could
stand for, and a same-named enum in a sibling fixture absorbed it — silence for
the wrong reason, which is not silence at all.

The index reads that pattern now. It asks the syntax first, so a run that wants
no member findings pays nothing for the answer, and both runs report the same 88.
The one `FoodCategory` still on the report is the other one, in
`local-resolvers.ts`, where every reference really does sit inside its own file.

The 64 test-only findings are the verdict earning its keep at scale: production
code with references, all of them in tests. Nothing in that bucket is auto-fixed,
because deleting it means deleting its tests.

## The exhibit repository (since 0.5.0)

The five reviews of this tool are themselves a corpus. Every exhibit they
raised — the provider literal, the colour chain, the imperative handle, the
IPC bridge — now lives in `tests/exhibit-repo`, a small TypeScript project the
test suite builds the binary against and runs, the way a user would. The test
asserts the report, that `--fix-unsafe --dry-run` finishes, that its diff takes
each comment out with the property it described, and that the fixture tree is
byte-identical afterwards.

It exists because 0.4.0 shipped a headline feature that had never completed a
run against the example in its own release notes. A reviewer should not be the
first to run a release's features.

## What the corpus says so far

- **Speed**: three libraries and an application, each analyzed member-deep in
  single-digit seconds — except the 541-file one, at 12.4.
- **Precision**: no standing false "dead" verdict from the reference analysis on
  any repo. apollo-client produced one — a dynamic import destructured on the
  spot — and it is fixed rather than documented. Boundary rules (public API,
  harness files, workspace manifests) decide what is in scope; inside that
  scope, the spot-checked findings have held, and the one near-miss sat behind
  the unresolved-import warning the report itself led with.
- **The verdicts earn their keep**: shadowed, write-only, and test-only
  findings arrive pre-triaged with evidence where any other tool would print
  a flat "unused".

Next: enough manual verification per repo to publish a precision number
instead of an anecdote.
