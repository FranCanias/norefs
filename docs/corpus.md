# Corpus validation

norefs is validated against real, widely used TypeScript repositories, not
only its own fixtures. Each run is a shallow clone, `npm install
--ignore-scripts`, then `norefs -p <tsconfig>` — no per-repo configuration,
no ignore lists. This file records the results and doubles as a regression
log: rerun the repos, compare the counts, explain every jump.

## Method

- Clone at depth 1, note the date.
- Run against the repo's own build tsconfig, out of the box.
- Read the verdict distribution before individual findings: the shape of the
  report says more than its size.
- Spot-check the biggest per-file buckets by hand before believing them.

## hono (2026-08-13, tsconfig.build.json)

**242 findings: 149 dead, 79 over-exported, 12 write-only, 1 likely
contract, 1 shadowed — in ~2 seconds** over a library with 76 published
subpath entries.

The public-API handling carries the run: everything hono's exports map
publishes — resolved through `export *` chains and mapped from `dist` paths
back to source — is exempt down to the type members, so the report contains
internals only. What it flags holds up under review: AWS event types the
lambda adapter declares but never reads (`src/adapter/aws-lambda/types.ts`),
handler types exported but consumed nowhere else, and one structurally
duplicated type the shadowed verdict pins with file and line.

## zod (2026-08-13, packages/zod/tsconfig.json)

**81 findings: 58 dead, 16 over-exported, 2 write-only, 1 likely contract,
4 test-only — in ~4 seconds**, running inside a workspace package of a
monorepo.

The four test-only findings are a category no reference count sees: code
with plenty of references, all of them in test files. `StandardSchemaWithJSON`
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

## norefs on norefs (2026-08-13)

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

## What the corpus says so far

- **Speed**: both repos analyze member-deep in single-digit seconds.
- **Precision**: across both repos, no confirmed false "dead" verdict from
  the reference analysis. Boundary rules (public API, harness files,
  workspace manifests) decide what is in scope; inside that scope, the
  spot-checked findings have held.
- **The verdicts earn their keep**: on hono, one shadowed and twelve
  write-only findings would have been flat "unused" claims in any other
  tool; here they arrive pre-triaged with evidence.

Next: an application-shaped repository (both entries above are libraries),
and enough manual verification per repo to publish a precision number
instead of an anecdote.
