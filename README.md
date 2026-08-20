# norefs

[![npm](https://img.shields.io/npm/v/norefs.svg)](https://www.npmjs.com/package/norefs)
[![CI](https://github.com/FranCanias/norefs/actions/workflows/ci.yml/badge.svg)](https://github.com/FranCanias/norefs/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/norefs.svg)](LICENSE)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/14170/badge)](https://www.bestpractices.dev/projects/14170)

Find unused files, exports, and type/object members in a TypeScript project.

Most dead-code tools stop at the declaration boundary: an interface counts as "used" even when half its members are dead. `norefs` checks both levels. It finds unused files, unused exports, and unused exported types — and then looks inside the types that *are* used, including objects returned from functions (exported or not) and objects used as React component props.

## Install

```sh
npm install -g norefs
```

Or run it without installing:

```sh
npx norefs
```

Then run `norefs` from any project with a `tsconfig.json`. norefs needs Node 22.4
or newer. One command, and the report:

```
$ norefs

src/models/User.ts
  4:3  dead property `legacyId` in interface `User`

src/legacy/formatter.ts
  dead file

src/hooks/useConfig.ts
  3:18  over-exported: interface `ConfigDefaults` is used only in this file
  8:14  dead export `configDefaults`

src/recipes/RecipeBox.ts
  12:3  property `maxServings` in interface `RecipeIO` looks like a data contract: its values come out of `JSON.parse(…)`

5 findings: 3 dead, 1 over-exported, 1 likely contract
```

## Usage

```sh
norefs [options]
norefs init      # write a norefs.config.json with every option at its default
norefs entries   # list every entry point and what named it
```

| Option | Description |
| --- | --- |
| `-p, --project <path>` | Path to `tsconfig.json` (default: `./tsconfig.json`); repeatable for a monorepo, where each package resolves imports with its own tsconfig's options |
| `--scope <path>` | Only report findings declared under this path; the whole project still resolves usages |
| `--entry <path>` | Treat this file or directory as an entry point: never reported unused, exports never reported (repeatable). Rarely needed — see [Entry points](docs/configuration.md#entry-points) |
| `--only <kinds>` | Report only these finding kinds, comma-separated: `files`, `exports`, `types`, `ns-exports`, `ns-types`, `members`, `empty-types`, `dependencies`, `unlisted`, `misplaced`, `stranded` |
| `--reporter <name>` | Output format: `text` (default), `json`, `github`, `sarif` |
| `--baseline` | Write the findings to `norefs-baseline.json` and exit; later runs fail on new findings only |
| `--ratchet` | With a baseline: drop entries whose finding vanished, so the count can only go down |
| `--explain` | Append each finding's evidence chain: what was searched, what was found, why the verdict |
| `--no-verify` | Skip the check after `--fix`; by default norefs type-checks in memory, holds back any fix that breaks the build, and saves only what verifies |
| `--verify-command <cmd>` | A command that must exit 0 for the fixes to count (your test suite); runs after the type check passes, and a fix that fails it is held back too |
| `--allow-dirty` | Let `--fix` write into a tree with uncommitted changes; by default it refuses, so the fixes stay separable from your own edits |
| `--export <md\|json>` | Also write findings to `norefs-findings.md` or `norefs-findings.json` in the current directory |
| `--fix` | Apply the fixes the verdicts prove safe: `dead` code is removed, `over-exported` declarations lose the `export` keyword |
| `--fix-unsafe` | Also apply `write-only`, `contract`, and `shadowed` findings, and edit `package.json` (implies `--fix`); a proven write-only member goes with the writes that prove it, and a write no single edit can retire keeps the whole finding |
| `--dry-run` | With `--fix`: print the would-be changes as a unified diff without writing any file |
| `--watch` | Re-run on save: keep the loaded project in memory, refresh the changed files, and report again |
| `--production` | Ask the stricter question — what is left standing if the tests were not there at all? Never combines with `--fix` — see [Production mode](docs/checks.md#production-mode) |
| `--anon` | Include findings on unnamed inline types and anonymous functions (hidden by default: they are the most false-positive-prone) |
| `-h, --help` | Show the help message |

`norefs` exits with code `1` when it finds unused code, `0` otherwise, and `2` for a usage error — so it slots into CI the same way a linter does. With `--fix` it exits `0` after it removes what it found.

The fixing flags interact: [docs/flags.md](docs/flags.md) is one page on what every flag and every combination does to a working tree.

### Configuration file

Put a `norefs.config.json` next to where you run `norefs`, and CI and teammates run the same thing without a shell alias:

```json
{
  "project": "tsconfig.app.json",
  "ignore": ["src/generated/**"],
  "scope": "src",
  "reporter": "github"
}
```

`norefs init` writes the file with every key present and set to its default. The file holds **settings** — what shapes the analysis and the report. It never holds an **action** like `--fix` or `--baseline`: what a run does to your working tree is a decision you make at the moment you make it. Every key — including `boundaries`, which pairs senders like `fetch` with handlers like `app.get` so a dead sender names the route it strands — is described in [docs/configuration.md](docs/configuration.md).

### Suppressing findings

A finding can be wrong — a member kept for API symmetry, a type consumed by reflection. Suppress it where it lives, with an optional reason for the next reader:

```ts
// norefs-ignore: kept for API symmetry
legacyId: number;
```

Three marks, three reaches: `norefs-ignore` for one finding, `norefs-ignore-block` for a declaration and its contents, and `norefs-ignore-file` for the whole file. See [Suppressing findings](docs/configuration.md#suppressing-findings).

### Running in CI

A codebase with hundreds of pre-existing findings does not need a big-bang cleanup to adopt norefs. Record the debt once and fail only on new findings:

```sh
norefs --baseline        # writes norefs-baseline.json; commit it
norefs                   # from now on: exit 1 only for findings not in the baseline
```

The baseline matches findings by kind, file, name, and context — the interface a member belongs to, the `package.json` section an entry sits in — but never by line, so ordinary edits do not break it. When findings are actually removed, norefs tells you the baseline has stale entries; run `--baseline` again to refresh it, or run with `--ratchet` and norefs drops the stale entries itself — the baseline becomes a one-way ratchet whose count only decreases. `--fix` also skips baselined findings, so it only removes new dead code.

Two reporters are made for CI:

- `--reporter github` prints one workflow command (`::error file=…`) per finding, so GitHub Actions shows them inline on the pull request.
- `--reporter sarif` prints a SARIF 2.1.0 run for anything that ingests SARIF, like GitHub code scanning.

### Fixing automatically

`norefs --fix` prints the findings, then applies the ones whose verdict proves them safe. Every fix happens in memory first: norefs type-checks the fixed project, holds back any fix that breaks the build, and saves only what verifies — disk never sees an unverified edit. `norefs --fix --dry-run` prints the diff without touching anything; `--fix-unsafe` also applies the evidence-backed verdicts, and `--verify-command "npm test"` makes your own suite the judge. The full contract — what a fix removes, cleans up, refuses, and points out — is [docs/fixing.md](docs/fixing.md).

### When norefs is wrong

A finding you disagree with has four answers, in the order worth trying:

1. **The finding is right about the code, wrong about you** — an export kept
   for API symmetry, a type read by reflection. Suppress it where it lives:
   [Suppressing findings](docs/configuration.md#suppressing-findings).
2. **The file should never have been reported** — it is an entry point norefs
   could not read from the build. Run `norefs entries` to see every entry point
   and what named each one, then add the missing one with `--entry` or the
   `entry` config key: [Entry points](docs/configuration.md#entry-points).
3. **A dependency is used in a way no import shows** — a script, a tool config,
   a peer. [Dependencies](docs/dependencies.md) says what counts as use, and
   `ignoreDependencies` covers the rest.
4. **The analysis cannot see it at all** — a dynamic read, an unresolved
   import, a boundary the types do not cross. [Limitations](docs/limitations.md)
   names each blind spot, and `--explain` prints the evidence chain behind any
   finding so you can see which one you are holding.

A wrong finding that fits none of these is a bug worth reporting.

## How it works

`norefs` loads your project with [ts-morph](https://ts-morph.com) and runs two passes.

The **module-level pass** works on the import graph. It finds unused files, unused exports and exported types (a declaration used only inside its own file is *over-exported*: the fix is to drop the keyword, not the code), stranded handlers (a handler whose every sender this report deletes), and three dependency problems: unused, unlisted, and misplaced `package.json` entries.

The **member pass** looks inside the types that survive: interfaces, type aliases and inline object types (React props included), enums, const objects, classes, and object literals returned from functions. For each member it asks norefs' own project-wide reference index whether anything reads it.

Every finding carries a **verdict** — the claim it makes, with its safety profile: `dead`, `over-exported`, `write-only`, `contract`, `shadowed`, or `test-only`. `--fix` applies only the first two; each of the others prints its evidence and waits for `--fix-unsafe` or your judgment.

Entry points are not yours to maintain: norefs reads them from what the build already declares — `package.json`, scripts, HTML, tool configs. Run `norefs entries` to see the list and what named each one.

The full definitions live in the docs: [every check and verdict](docs/checks.md), [the dependency checks](docs/dependencies.md), and [what counts as usage — and what the analysis cannot see](docs/limitations.md).

## How it compares

[knip](https://github.com/webpro-nl/knip), [ts-prune](https://github.com/nadeesha/ts-prune), and [depcheck](https://github.com/depcheck/depcheck) ask related questions. The honest split: knip understands your **toolchain** better; norefs understands your **code** better. Three things set norefs apart:

- **It looks inside the types.** The others stop at the declaration boundary — an interface counts as used while half its members are dead. norefs reports the unused members of interfaces, type aliases, enums, classes, const objects, and returned object literals.
- **Every finding carries a verdict.** Not one flat "unused", but a claim with a safety profile — `dead`, `over-exported`, `write-only`, `contract`, `shadowed`, `test-only` — and `--explain` prints the evidence behind it.
- **The fix verifies itself.** `--fix` type-checks the fixed project in memory, bisects to any fix that broke the build, holds it back, and saves only what verifies.

Where knip is better: about a hundred framework and tool plugins, coverage of non-TypeScript sources (`.vue`, `.svelte`, `.astro`), and years of publicly answered issues. ts-prune is in maintenance mode and covers unused exports only — its own README points at knip. depcheck covers dependencies only. If your project leans on a framework knip has a plugin for, running both is a fine answer: they disagree in useful places.

## Documentation

- [What norefs finds](docs/checks.md) — every check, the six verdicts, and `--production` mode
- [Dependencies](docs/dependencies.md) — what counts as using a package, and the misplaced-entry check
- [Configuration](docs/configuration.md) — the config file, boundaries, suppression comments, entry points, monorepos
- [Fixing automatically](docs/fixing.md) — what `--fix` removes, verifies, refuses, and points out
- [Flags](docs/flags.md) — what every flag and combination does to a working tree, and the exit codes
- [Speed](docs/speed.md) — fast runs with `--only`, and watch mode
- [Limitations](docs/limitations.md) — what counts as usage, when norefs stays silent, the remaining blind spots
- [Corpus validation](docs/corpus.md) — results on real, widely used repositories
- [Changelog](CHANGELOG.md) — every release, with what changed and why
- [Security policy](https://github.com/FranCanias/norefs/blob/main/SECURITY.md) — how to report a vulnerability, and what norefs does on your machine

## Project layout

```
src/
  index.ts      CLI entry point
  config.ts     norefs.config.json loading and `norefs init`
  baseline.ts   norefs-baseline.json
  describe.ts   the human-readable labels every layer prints
  messages.ts   one error-to-line helper, shared by every layer
  engine/       project loading, the module-level checks (files, exports, namespaces, dependencies),
                what the build writes down (entry points, tool configs, workspaces), the
                syntax-only pipeline and its scanner, suppression comments, the fix campaign,
                orchestration, output formatting
  lookup/       the project-wide reference index and its query API
  collectors/   one file per source of candidate members (interfaces, type literals, returned objects, enums, const objects, classes)
  filters/      post-collection filters (e.g. the anonymous-findings gate)
  types/        shared types
```

Adding a new source of candidates (JSX-spread props, …) means adding one file to `src/collectors/` and registering it in `src/collectors/index.ts`. Adding a new filter means extending `src/filters/index.ts`.

## Development

```sh
pnpm install
pnpm run build      # compile to dist/
pnpm test           # vitest suite (tests/fixtures covers one usage pattern per file)
pnpm run check      # biome ci: lint, formatting, and import order
pnpm run typecheck  # tsc --noEmit, over src and tests both
pnpm run format     # biome check --write
```

norefs runs on Node 22.4; developing it needs 22.12. The reasons, how the suite
is organized, how a release happens, and the writing rules the code and docs
follow are all in
[CONTRIBUTING.md](https://github.com/FranCanias/norefs/blob/main/CONTRIBUTING.md).

## License

ISC
