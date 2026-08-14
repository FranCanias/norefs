# norefs

Find unused files, exports, and type/object members in a TypeScript project.

Most dead-code tools stop at the declaration boundary: an interface counts as "used" even when half its members are dead. `norefs` checks both levels. It finds unused files, unused exports, and unused exported types — and then looks inside the types that *are* used, including objects returned from functions (exported or not) and objects used as React component props.

## How it works

`norefs` loads your project with [ts-morph](https://ts-morph.com) and runs two passes.

### Module-level checks

- **Unused files** — no chain of imports from any entry point reaches the file. Because the check is reachability, not a count of direct importers, a whole dead cluster gets reported — including two unused files that only import each other. Entry points are read from what the build already declares — see [Entry points](#entry-points) — and `--entry` adds any the build does not name. Test, spec, stories, bench, and config files (and anything under a `test`, `tests`, `__tests__`, or `__mocks__` directory) are their own entry points, so they are never reported either — and their members are not analyzed: a fixture type with an unread field is noise, not dead code.
- **Unused exports** and **unused exported types** — an exported declaration that nothing outside its file uses. Interfaces, type aliases, and enums count as types; functions, classes, variables, and namespaces count as exports. References resolve through re-export chains, so a barrel between the declaration and its consumers does not hide usage. A declaration that is used inside its own file but never imported is reported as **over-exported**: the `export` keyword is dead even though the code is not, so the fix is to drop the keyword, not to delete the declaration. The public API is never reported: every declaration an entry file exports — resolved through re-export chains, `export *` and `export * as ns` included — is exempt, members and all, because its consumers live outside this program.
- **Exports in used namespace** and **exported types in used namespace** — the same check, at lower confidence, for two namespace shapes. When a module is consumed through a used `import * as ns` binding, its zero-reference exports are reported this way, because the namespace object may be consumed dynamically. And when a TS `namespace N { … }` is used, its exported members whose references never leave the namespace body are reported this way too.
- **Stranded handlers** — a handler registered under a channel string (`ipcMain.handle('recipeBox:load', …)`) whose every sender this report deletes. norefs finds the bridge your own `.d.ts` declares without being told; name any other boundary — HTTP routes, a socket bus — with the [`boundaries`](#boundaries) config key. The registration keeps the handler "used", so no reference-based analysis will ever flag it — including the next norefs run, once you remove the wrapper that sends to it. The finding lands on the handler's own file and line, while it is still visible. A sender counts as dying only when its own declaration goes: the method that holds the channel string, not the class around it, and never an over-exported declaration, whose fix drops a keyword and deletes nothing. It obeys `--scope` and the suppression comments like any other finding; the note on the wrapper names the far side either way.
- **Unused dependencies**, **unlisted dependencies**, and **misplaced dependencies** — see [Dependencies](#dependencies). An entry nothing imports and no script runs; an imported package no scanned `package.json` lists; and an entry whose section does not match how it is used. Peer and optional dependencies exist for consumers and are never reported. `@types/*` packages are consumed by the compiler and pair with their base package. Path aliases, node builtins, and relative imports never count as packages.

A finding at a higher level swallows the findings inside it: an unused file hides its exports and members, an unused export with zero references anywhere hides its members, and a type losing every member folds them into its one `becomes empty` finding. One line per problem, not fifty.

### Verdicts

Every finding carries a verdict: the claim it makes, with its safety profile. "Unused" is not one claim — it is six:

- **dead** — no references, no structural twin, no boundary crossing, and every write of the name accounted for. Safe to delete, and `--fix` does.
- **over-exported** — used in its own file only. Safe to de-export, and `--fix` does.
- **write-only** — a write of the member's name exists, and it survived validation against the type it feeds. The evidence says which kind you are holding: a *typed write* is proven — the value flows into a use whose type declares this very member, and nothing reads it; an *unverified name match* is a write the analysis could not type either way. A name match that provably feeds a *different* type is discarded instead of reported, so a member is never protected by how popular its name is elsewhere. `--fix-unsafe` retires a proven write-only member together with the writes that prove it.
- **contract** — the type's values cross a boundary the types cannot follow: a serialization call (`JSON.parse`, `JSON.stringify`, `structuredClone`, `postMessage`), a call on something a project `.d.ts` declares (an IPC bridge, a preload global), or any untraced result (`any`/`unknown`) pinned to the type by assertion — directly or through a containing type. The members document a wire format; deleting them destroys the documentation, not the data. When a twin of the type sits across the boundary, the two findings merge into one contract and each names the other side.
- **shadowed** — a duplicate of the type elsewhere *is* read: a structurally identical twin, or a same-named type whose shape overlaps enough to be a drifted copy. The member is probably alive through the duplicate, and the real finding is the duplication: merge the twins, don't delete the member.
- **test-only** — production code never touches it; only test files keep it alive. A real and common category of dead code, and never auto-fixed: the fix is deleting the code together with its tests, and only a human deletes tests. [`--production`](#production-mode) is the stricter cut, where the tests are not there at all.

Each soft verdict prints its evidence — the twin that reads the member, the boundary the type crosses. `--fix` only applies `dead` and `over-exported` findings; the rest wait for `--fix-unsafe` or your judgment.

### Member-level checks

The member pass looks for six kinds of member owners:

- `interface` declarations
- `type` aliases, and any inline object type (parameter types, return types, variable annotations — this covers React props like `function Foo({a}: {a: string})`)
- object literals returned from functions whose return type is inferred (not explicitly annotated) — exported or not, so a local producer whose output nobody reads is one finding: the computation is dead weight
- `enum` declarations
- **const object literals** — `const Timeouts = { … } as const`, the enum modern TypeScript writes. `Timeouts.SAVE_DEBOUNCE` reads a member the way an enum member is read, so a member nothing reads is dead the same way. Plain `const x = { … }` counts too, and a property written the short way (`{ spareJar }`) is a property like any other; a declared shape does not, because the type that declares it is what gets reported (see below)
- `class` declarations (properties, methods, accessors, static members, and constructor parameter properties)

For each property it finds, it asks TypeScript's own "find all references" (via `findReferencesAsNodes`) whether anything reads it. No references beyond the declaration itself means the property is unused.

Because the check is reference-based, it follows structural typing correctly — `v.x` resolves back to `interface A { x: number }` even without an explicit cast. See [Limitations](#limitations) for where that breaks down.

When every member of a named interface or type alias is unused while the type itself is still referenced, the member findings fold into one: ``interface `X` becomes empty: all 6 members are dead``. That is one logical fact, so it is one finding, carrying the most cautious verdict of the members it swallowed. Removing the members would leave an empty `interface X {}` behind, and only you know whether its consumers should go too — `--fix` never touches these. An interface that extends another is exempt — empty, it still works as an alias.

## Install

```sh
npm install -g norefs
```

Or run it without installing:

```sh
npx norefs
```

Then run `norefs` from any project with a `tsconfig.json`.

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
| `--entry <path>` | Treat this file or directory as an entry point: never reported unused, exports never reported (repeatable). Rarely needed — see [Entry points](#entry-points) |
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
| `--fix-unsafe` | Also apply `write-only`, `contract`, and `shadowed` findings (implies `--fix`); a proven write-only member goes with the writes that prove it, and a write no single edit can retire keeps the whole finding |
| `--dry-run` | With `--fix`: print the would-be changes as a unified diff without writing any file |
| `--watch` | Re-run on save: keep the loaded project in memory, refresh the changed files, and report again |
| `--anon` | Include findings on unnamed inline types and anonymous functions (hidden by default: they are the most false-positive-prone) |
| `-h, --help` | Show the help message |

`norefs` exits with code `1` when it finds unused code, `0` otherwise — so it slots into CI the same way a linter does. With `--fix` it exits `0` after it removes what it found.

The fixing flags interact: [docs/flags.md](docs/flags.md) is one page on what every flag and every combination does to a working tree.

### Configuration file

Put a `norefs.config.json` next to where you run `norefs`, and CI and teammates run the same thing without a shell alias:

```json
{
  "project": "tsconfig.app.json",
  "entry": ["src/worker.ts"],
  "ignore": ["src/generated/**"],
  "only": ["files", "exports", "types", "members"],
  "ignoreDependencies": ["ts-node", "@internal/*"],
  "boundaries": [{ "send": "fetch", "handle": ["app.get", "app.post"] }],
  "scope": "src",
  "reporter": "github",
  "anon": false,
  "explain": true,
  "production": false
}
```

The file holds **settings** — what shapes the analysis and the report. Those are true of a project every time it is analyzed, so they belong in a file everyone shares. It never holds an **action**: `--fix`, `--baseline`, `--dry-run`, `--export` and `--watch` each write something, and what a run does to your working tree is a decision you make at the moment you make it. An action key in the config file is an error, not a silent surprise.

`norefs init` writes the file for you, with every key present and set to its default:

```json
{
  "project": ["tsconfig.json"],
  "entry": [],
  "ignore": [],
  "only": [],
  "ignoreDependencies": [],
  "boundaries": [],
  "scope": "",
  "reporter": "text",
  "anon": false,
  "explain": false,
  "production": false
}
```

Fill in the keys you need and delete the rest — an empty array means the default: no extra entry points, nothing ignored, every kind reported. An empty `scope` is the whole project. `init` never overwrites an existing config.

All keys are optional. `project` also accepts an array of tsconfig paths for a monorepo. `entry` merges with `--entry`; for every other key, a flag passed on the run wins over the file. `--no-anon` and `--no-explain` are how a run says no to a project that said yes. `ignore` takes globs, matched against paths relative to the current directory (and absolute paths). Ignored files produce no findings, but their contents still count as usage of other code. `ignoreDependencies` takes package names or globs the dependency checks never report. `boundaries` is described below.

### Boundaries

norefs finds one kind of boundary on its own: a callee your project's own `.d.ts` declares — a preload global, an ambient IPC handle. That call leaves the program, so the string it takes first is a channel, and whatever registers a handler under the same string is its far side. That is the [stranded handler](#module-level-checks) check, and it needs no configuration.

Every other boundary belongs to a library, and no shape in the source says which library pairs `fetch` with `app.get` rather than running the handler itself. So you say it — two lists of callee names, one that sends on a channel and one that registers a handler for it:

```json
"boundaries": [
  { "send": "fetch", "handle": ["app.get", "app.post", "router.get"] },
  { "send": "socket.emit", "handle": "socket.on" }
]
```

Now a dead `fetch('/api/recipes/legacy')` names the route it was the last sender of, and the route gets a `stranded` finding on its own line:

```
src/client.ts
  12:9  dead property `saveLegacy` in class `ApiClient` — deleting it strands the far side of `'/api/recipes/legacy'` at src/routes.ts:5
src/routes.ts
  5:10  stranded handler for `'/api/recipes/legacy'`: its only sender is `saveLegacy` at src/client.ts:12, …
```

Each entry pairs only with itself, so a `socket.on('save', …)` never answers for a `fetch('save')`. Both sides are required — a boundary with one side pairs nothing, and a config that looks like it works is worse than none. A name matches the whole callee or its tail: `app.get` covers `this.app.get`, `fetch` covers `window.fetch`, and neither covers `getApp`.

Routes match by shape, so the holes the two sides fill differently line up: `app.get('/recipes/:id/audit')` pairs with ``fetch(`/recipes/${id}/audit`)``. The list route, the item route, and anything nested under them stay separate channels. An interpolated string that is not a route — `` api.send(`job:${kind}`) `` — is not a channel at all, because there is no shape both sides agree on.

### Suppressing findings

A finding can be wrong — a member kept for API symmetry, a type consumed by reflection. Suppress it where it lives:

```ts
export interface User {
  name: string;
  // norefs-ignore: kept for API symmetry
  legacyId: number;
  createdAt: Date; // norefs-ignore
}
```

`// norefs-ignore` on the reported line, or alone on the line above, suppresses that one finding. The reason after the colon is optional but kind to the next reader. A suppressed declaration counts as used, so norefs still looks inside it: suppressing an unused export keeps reporting its unused members.

When the whole declaration is the answer — five members of one wire format, not five separate decisions — use `// norefs-ignore-block`:

```ts
// norefs-ignore-block: the shape the desktop app sends, kept in sync by hand
export interface RecipePayload {
  id: string;
  vendor: string;
  firmware: string;
  serial: string;
  capabilities: string[];
}
```

It covers that declaration and every finding inside it: the members, the nested type literals under them, and the declaration itself. Put it on the declaration's line or in the comments above it — before or after a doc comment, either reads the same. Anything that holds findings takes it: an interface, a type alias, a class, a namespace, an enum, a const object, a producer whose returned object is flagged, an import.

Three marks, three reaches: `norefs-ignore` for one finding, `norefs-ignore-block` for a declaration and its contents, and `norefs-ignore-file` before a file's first statement for the whole file — generated code, for instance — which also covers the unused-file finding.

### Running in CI

A codebase with hundreds of pre-existing findings does not need a big-bang cleanup to adopt norefs. Record the debt once and fail only on new findings:

```sh
norefs --baseline        # writes norefs-baseline.json; commit it
norefs                   # from now on: exit 1 only for findings not in the baseline
```

The baseline matches findings by kind, file, and name — not by line — so ordinary edits do not break it. When findings are actually removed, norefs tells you the baseline has stale entries; run `--baseline` again to refresh it, or run with `--ratchet` and norefs drops the stale entries itself — the baseline becomes a one-way ratchet whose count only decreases. `--fix` also skips baselined findings, so it only removes new dead code.

Two reporters are made for CI:

- `--reporter github` prints one workflow command (`::error file=…`) per finding, so GitHub Actions shows them inline on the pull request.
- `--reporter sarif` prints a SARIF 2.1.0 run for anything that ingests SARIF, like GitHub code scanning.

### Speed

Unused files and every dependency check are decided by the import graph, and the
import graph is in the source text. Ask for only those and norefs never builds a
type checker: a single-pass scanner reads every file, the compiler resolves the
specifiers it found, and the answer arrives in well under a second.

```sh
norefs --only files,dependencies,unlisted,misplaced
```

The member checks are the other half. To know that `{ id: 1 }` writes the `id`
an interface declares, norefs has to ask the compiler what type that object
literal is read as — and answering that resolves the types of the surrounding
call or component. It is most of what a full run costs, and nothing but a
member finding rests on it, so a run that asks for no member findings does not
pay for it either:

```sh
norefs --only files,exports,types,ns-exports,ns-types,dependencies,unlisted
```

On a 338-file application:

| run | time | memory |
| --- | --- | --- |
| everything | 4.7 s | 1.0 GB |
| everything but members | 1.8 s | 630 MB |
| files and dependencies only | 0.21 s | 190 MB |

The findings are the same either way — the kinds you ask for change the work
done, not the answers.

For the checks that do need references, norefs indexes the whole project once —
one pass over every identifier, each filed under the declaration it names —
instead of asking the language service per declaration, which would rebuild an
import tracker every time.

The index skips what no finding can rest on. An occurrence named like nothing
the run will ask about is never resolved to a symbol. And where the checker's
contextual-type answer would type-check a whole call, the index reads the
argument's declared type off every signature of the callee instead — filing a
reference under each candidate rather than the one overload the checker would
pick. Filing wider costs nothing but a missed finding. Generic signatures work
the same way — which members `TableProps<T>` declares does not depend on what
`T` becomes — and each component or callee is read once, however many sites
use it. Only the cases where instantiation can reshape a type's members — a
naked type parameter, a conditional type, a mapped type, a spread, a class
component — still pay the checker's price.

### Watch mode

While you clean up a codebase, run norefs in a terminal on the side:

```sh
norefs --watch
```

Loading the project is the expensive part of a run, so watch mode does it once. On every save it refreshes only the changed files in memory, re-analyzes, and reports again — created and deleted files included. Changes to `tsconfig.json` or `norefs.config.json` need a restart; `--watch` does not combine with `--fix` or `--baseline`.

### Fixing automatically

`norefs --fix` prints the findings, then applies the ones whose verdict proves them safe and saves the files:

- An over-exported declaration loses only the `export` keyword. A dead export is removed whole, together with every import and re-export specifier that forwarded it — nothing dangles in a barrel. A dead member is deleted; a dead parameter property (`constructor(private readonly dead: number)`) only loses its modifiers and stays a plain parameter, so the constructor signature and every `new` call site keep working.
- `write-only`, `contract`, and `shadowed` findings wait for `--fix-unsafe` (it implies `--fix`). These are claims the analysis cannot prove — a wire format, a value alive through a duplicate type — and no type checker catches a wrong deletion. Review that diff with care.
- A fix finishes the finding it acts on, or refuses it. A proven `write-only` member is retired with the writes that prove it — the property assignments the evidence cites, any local whose last reader they were, and the dependency entries that named that local — because deleting the declaration alone would leave the value computed into a shape no named type describes: the finding, made undetectable by the next run. `useMemo(() => ({ track }), [track])` is the case that needs all three; stop at the write and the dependency array keeps the dead computation alive for the type checker and for norefs alike. When one of those writes cannot be removed on its own — a spread carries members beyond this one — the whole finding is kept and the write is named: ``Kept `extra` (src/payload.ts:2): the write at src/payload.ts:9 is why this isn't safe``.
- After the removals, norefs cleans each touched file: imports and unexported top-level declarations that only the removed code used are removed too. Then it re-analyzes and fixes again until nothing fixable is left, so cascades converge in one command.
- Unused files, namespace findings, and emptied types are never touched. Deleting a file is your call, a namespace finding is a lower-confidence guess, and an emptied type needs your judgment about its consumers.
- `--fix` only touches what is reported, so `--only`, `ignore` globs, and suppression comments limit the fixes the same way they limit the findings.
- Every fix happens in memory first. After the last pass, norefs verifies its own work: it type-checks the fixed project and compares against the errors that existed before. When a fix introduced an error, norefs bisects the fix set to the culprit, holds that one fix back with the errors as evidence, and re-verifies the rest — then it saves only the verified result. Disk never sees an unverified edit. `--no-verify` skips the check when the double type-check costs more than you want to pay.
- Know what "Verified" means per fix class. De-exporting is compiler-checkable by construction. A deleted member is not: a type check cannot see runtime-only reads (an identity-tracked context value, an inference-typed producer). When member deletions ride on the type check alone, norefs says so — and `--verify-command` is the honest witness for them.
- A fix that cannot be applied is held back too. When the editor refuses an edit, that is one finding's answer, not the run's: the campaign rolls back, names the finding and the refusal, and applies everything else. The same rule as a fix that fails the type check.
- Two things no probe can verify get pointed out instead. A comment that sits next to an edit but was kept — the leading comment of a statement a fix trimmed, or one a blank line above a deletion — is listed for you to reread, because no heuristic fixes prose. And a reported wrapper around a bridge — one your project's own `.d.ts` declares, or one you named with `boundaries` — reports where the same channel reappears: deleting the wrapper strands that far-side handler, which no reference-based analysis will ever flag. The note only appears when the fix deletes every sender of that channel — one surviving sender and nothing is stranded — and the handler also gets a `stranded` finding of its own, so it is visible before the deletion hides it.
- `--verify-command "npm test"` raises the bar: after the type check passes, the candidate files go to disk, the command runs, and the originals come back before the verdict. A fix your test suite rejects is held back like any other — the diff you get is one your own tests already passed.

Review the diff before you commit. The emptied-type findings point at the leftovers that need human judgment.

To see the diff without touching anything, run `norefs --fix --dry-run`. It applies the full fix — cascades included — to the in-memory project only and prints one unified diff per file. The exit code stays `1`, so it also works as a strict CI check.

### Example

```
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

### Anonymous findings

Some findings point at inline types with no name to anchor them — a `{x, y}` parameter type on an anonymous callback, for instance. These are the most false-positive-prone: TypeScript's reference search loses track of a value forwarded via shorthand into a *differently-declared* structural type, because the read then resolves to the other declaration. By default norefs reports only findings tied to a named interface, type alias, or function; pass `--anon` to include the anonymous ones too:

```sh
norefs --anon
```

### Monorepos and cross-project scans

In a workspace, run `norefs` with no flags. It reads the packages your package manager already reads — `pnpm-workspace.yaml`, or `workspaces` in `package.json` — and analyzes each package that has a `tsconfig.json`:

```sh
$ norefs
2 workspace package(s) from pnpm-workspace.yaml; skipped tools/jsonly — no tsconfig.json
```

Negated globs (`'!packages/legacy'`) are honoured, and a declared package with no `tsconfig.json` is named on stderr rather than dropped quietly — nothing analyzes it, and a run that silently covers less than the workspace is a run whose findings mean less than they look like they mean.

Nothing is executed and no glob can invent a project: every one resolves to a `tsconfig.json` that exists on disk, so the failure mode is a package nobody analyzed, never a package nobody has.

Pass `-p` when you want a different set. An explicit list is the list you meant, so it turns discovery off:

```sh
norefs -p packages/app/tsconfig.json -p packages/lib/tsconfig.json
```

Every file resolves its imports with the compiler options of the tsconfig that owns it, so per-package `paths` aliases work as they do in each package's own build, and `package.json` entries map back to source through each package's own `outDir` and `rootDir`. The scan still builds one program — that is what lets a reference in one package count as usage of another. When the packages import each other by package name, map that name in the importing package's `paths` to the target's source entry point, not its built `.d.ts`.

To find unused properties in a library whose only consumer lives in another repo, the umbrella approach still applies:

1. Write an umbrella `tsconfig.json` whose `include` covers both projects' source files.
2. Reproduce **every** path alias from both repos in its `paths` — including the library's internal aliases — and map the package specifier (`"my-lib"`) to the library's `src` entry point, not its built `.d.ts`.
3. Run `norefs -p umbrella.tsconfig.json --scope path/to/library/src`.

Resolution is everything here: each import that fails to resolve hides all references flowing through it, which turns used properties into "unused" findings. norefs checks for this and prints a warning listing the unresolved specifiers — fix those before trusting the results.

## Production mode

Every finding norefs makes is relative to a question. The default question is "does anything in this repository use it?", and the tests count — a member only a test reads is labelled `test-only`, not dead, because deleting it breaks something real.

`--production` asks the stricter question: **what is left standing if the tests were not there at all?**

```sh
norefs --production
```

Test, spec, stories, bench and config files — and everything under `test`, `tests`, `__tests__`, `__mocks__` — are treated as absent. Three things follow, and they are the whole definition:

- They stop keeping code reachable. A file only a test imports becomes a **dead file**, where a normal run would only label its exports `test-only`.
- Their references stop counting. What was `test-only` becomes plain **dead**.
- They report nothing of their own. A dead export inside a test file is not a finding, because that file is not part of the question.

`devDependencies` fall outside it too: they exist to build and test. So does the misplaced-dependency check, which needs both halves of the code to decide anything. A `dependencies` entry only the tests import is simply unused here.

**It never combines with `--fix`.** A production finding is dead to the shipping path and may be perfectly alive in the tests this run ignored — deleting it breaks them. That is the same reason `test-only` findings are never fixed either: the fix is deleting the tests too, and only you do that. `norefs --production --fix` is a usage error, exit code 2.

The two modes answer different questions, so run both: the default one to find what nothing uses, `--production` to find what only the scaffolding is holding up.

## Dependencies

A `package.json` says two things about every entry: that the project needs it, and when. norefs checks both.

**Nothing uses it.** An entry is reported dead when nothing in the project uses it, and four things count as using it.

An import, first. Then a script: `"build": "tsc -p tsconfig.json"` is TypeScript being used, and no import will ever say so — norefs reads each script's tokens and matches them against the packages you listed, by name and by the binaries each installed package declares in its own `bin` field. Then a tool config: an ESLint config imports its plugins from a file the TypeScript program never holds, and `environment: 'jsdom'` loads jsdom without naming a file at all, so a listed package written anywhere in a `*.config.*` counts as used. And last, a host: `@vitest/coverage-v8` runs behind `--coverage` and `bufferutil` behind `ws`, and each of them is a peer dependency of a package this project does use — which is how the ecosystem writes down "that one loads me".

Nothing here guesses which tool owns which command, or which plugin. `tsc` maps to `typescript`, and `bufferutil` to `ws`, because those packages' own manifests say so.

That is also the limit. A package that is not installed has no binaries to read, so norefs will not call a devDependency unused — it cannot see what a script might be running. Install first, or the claim goes unmade.

**It is in the wrong section.** Where an entry sits is a claim about when it is needed, and getting it wrong breaks something either way:

```
package.json
  9:5   `only-in-tests` is in dependencies: only test, spec, story, bench, and config files use it, so it ships for nothing
  15:5  `zod` is in devDependencies: production code imports it, so an install without dev dependencies is missing it
```

The second one is the expensive one — `npm install --omit=dev` and the package is gone at runtime.

Only an import that survives compilation counts here. `import type { Recipe } from 'shapes'` is erased before anything runs, so a devDependency the shipping code reads for types alone is already in the right section — moving it would ship a package the output never loads. The import still counts as the package being used, so nothing calls it dead.

One package shape is read differently: a module the environment provides. `import { app } from 'electron'` reads a `declare module 'electron'` block in electron's own types. That is what an API the host supplies looks like — the binary that loads the code brings the module with it, and no file in `node_modules` is what the import lands on at run time. Which section such a package belongs in is decided by whatever packages the app; electron-builder wants `electron` in `devDependencies` and reads it from there to pick the runtime it bundles. So an install without dev dependencies is not what would be missing it, and norefs does not make a claim it cannot ground.

Nor does it ask the other direction. `declare module` is also how a library older than ES modules ships its types — `@xterm/headless`, `node-pty` and `toml` all write it, and all three are ordinary packages a product installs and ships. The signal is strong enough to hold a claim back and far too weak to make one, so it is read in the direction that reports nothing.

A config file is a build's file, not the product's, so what it imports is never production usage. That holds for a second target's config: `vite.config.server.ts` beside `vite.config.ts` is read as a config too. Only at the package root, though — the extra segment is also how ordinary code gets named, and `src/form.config.schema.ts` is a schema, not a build.

**Fixing them.** `--fix-unsafe` removes an unused entry and moves a misplaced one, editing `package.json` as text so the key order and the indentation survive. It needs `--fix-unsafe` rather than `--fix` for an honest reason: the type checker does not read a dependency list, so the probe that guards every other fix has nothing to say here. `--verify-command` is the one that can judge these, and when it fails the manifest edits are held back on their own — the source fixes it did verify still land.

Use the `ignoreDependencies` config key for a dependency norefs still cannot see: a binary invoked from somewhere other than a script, a package a runtime injects by a name nothing writes down.

## Entry points

An entry point is where the import graph starts: the file is never reported unused, and its exports are the public API, so they are never reported either. Getting the list wrong is expensive in both directions — a missing entry reports a live file as dead, an invented one hides real findings.

So norefs does not ask you to keep the list. Your build already has it, written down in files norefs can read:

| Declared in | What is read |
| --- | --- |
| `package.json` | `main`, `bin`, and `exports`; paths into the compiled output map back to source through the tsconfig `outDir` and `rootDir` |
| `package.json` scripts | any argument that names a project file — `tsx src/server.ts`, `--config=playwright.config.ts`. A directory is a place to look, not a module: `eslint src` names no entry point |
| `*.html` | the `src` of every `<script>`; a leading `/` is the package root, as bundlers read it |
| `*.config.*` | every quoted path that lands on a project file — Vite's `input`, Vitest's `setupFiles`, Playwright's `globalSetup`, an alias target, and the same in tools nobody has written a plugin for. A build with two targets writes the second one down the same way, so `vite.config.server.ts` beside the manifest is read too |
| convention | `index`/`main`/`cli` beside a tsconfig or in its `src/` |

Nothing is executed. A config is read as text, and a path string that names a file this project holds is taken at its word — one rule, no per-tool plugins. Build output (`dist`, `build`, `out`, `coverage`, …) and `node_modules` are never walked, so a stale config in `dist/` cannot silence anything.

A path in a config is read the way an import is written: with its extension, without one, or as the directory whose `index` is the module. A script's argument is read one step tighter, because a command takes directories for a different reason — `eslint src` scans a tree, and calling `src/index.ts` an entry point on the strength of that would publish every export in it.

A bare word is left alone either way. `environment: 'jsdom'` names a package, not a file, and guessing an extension for it would silence every finding in a file that happened to share the name.

What a config *imports* is not an entry point, as long as the program holds the config itself: the import is already an edge in the graph, the config is already a root of it, and naming the target an entry point on top of that would publish that file's exports as API on the strength of one config line. A config the program never holds — `eslint.config.js`, or one the tsconfig does not include — is no root of anything, so what it imports is read as an entry point after all.

Test, spec, stories, bench, and config files are reachability roots too, on their own rule, and so is anything under `test`, `tests`, `__tests__`, or `__mocks__`. They are not entry points: nothing outside imports them, so their exports stay open to report.

To see what a run decided, and why:

```sh
$ norefs entries
src/boot.tsx    —  <script src> in index.html
src/main.ts     —  index/main/cli beside a tsconfig
src/preload.ts  —  a path named in vite.config.ts
src/server.ts   —  package.json scripts.serve
```

`--entry` is still there for what no config names — a script run straight with `node path/to/script.ts`, a file loaded by a name computed at runtime.

## What counts as usage

The test suite verifies that the reference check resolves all of these — none of them produce false positives:

- dot access (`v.prop`) and string-literal element access (`v['prop']`)
- destructuring, in parameters and in bodies
- spreads, into both same-typed and fresh object types
- mapped types (`Partial<T>`, `Pick<T, 'k'>`) and interface inheritance
- usage from other files, quoted property names, implementing class members
- property writes (a write-only property counts as used)
- a literal probe like `'name' in v` counts as usage of exactly that property
- class members reached through a declared `implements` or `extends` — TypeScript merges those reference groups
- reads through a spread copy of a class instance resolve back to the class members

## When norefs stays silent

Some consumption is invisible to static reference search. Rather than guess, norefs suppresses those findings entirely:

- **`keyof`-targeted types**: when `keyof T` appears anywhere, code is enumerating or indexing T's keys dynamically. All of T's members are skipped.
- **Key-enumerating and serializing sinks**: a value passed to `Object.keys`/`values`/`entries`/`assign`, `JSON.stringify`, `structuredClone`, or `Reflect.ownKeys`, iterated with `for...in`, or probed with a dynamic `key in v` marks its whole type as dynamically consumed.
- **Escaping values**: when an object leaves local view as a whole — a returned literal passed on as a bare argument, a whole-binding parameter or variable forwarded via shorthand into a differently-declared type, a property whose value flows onward wholesale, an `as`/`satisfies` cast whose value is spread into a combined array or passed bare — its properties may be consumed without any per-property reference. The affected type literal is skipped.
- **Assignability-required members**: a declared relation can make a member load-bearing with zero references. An `extends`/`implements` override (`interface Derived extends Base { items: DerivedItem[] }`) or a type predicate (`v is Derived`) forces one type to stay assignable to another, so the required members of the base shape are kept even when nothing reads them.
- **Type-level reads**: a name written in a type literal that the type system matches against another type is read on every compile, whatever the runtime does. Three positions count, and each credits the name to the literal *and* to the type it is matched against: a conditional type's `extends` clause, including through an alias like `Extract<Schedule, { type: 'DAILY' }>`; a predicate's asserted type (`r is Recipe & { id: string }`); and a written type argument against a literal constraint (`pickFirst<Row>(…)` where `T extends { id: string }`). A filter can also name a property one level in — `Extract<Event, { payload: { kind: 'RENAME' } }>` — and the nested name is read on whatever type the property holds, not on the type around it. An inferred type argument needs no rule — the value goes into the call whole, and the escape check already stops there.
- **Parameters of function types**: callback signatures declare parameter types, but implementations bind their own parameters; when callbacks are invoked with variables rather than literals, the signature's members can't be tracked.
- **Structural class implementations**: when an instance escapes into a type that is not the class or its declared heritage — `return new StoreImpl()` from a function typed as interface `Store`, with no `implements` clause — every call goes through the interface and the class members collect zero references while being used at runtime. The whole class is skipped, along with its base classes and any class whose instances only leave through methods of such a class. Declaring `implements` restores tracking.
- **Decorated classes**: a decorator hands the class to a framework that reads members through reflection or metadata. The whole class is skipped.
- **Dynamically consumed enums**: `keyof typeof E`, `Object.values(E)`, `for...in`, and reverse mapping or computed lookup (`E[x]`) all reach members without per-member references. The whole enum is skipped.
- **Const objects that hand out every member at once**: an object is a value, so its properties can be reached without naming one. `Object.values(Timeouts)`, a spread, an index with a computed key, or the binding passed on whole all read every member in one go, and each silences that declaration. A `'name' in Timeouts` probe is the exception: it names one key, so it marks that key used and leaves the rest reportable. A const object with a declared type — an annotation or a `satisfies` — is skipped here as well, because the type that declares the shape is what the type collectors already report.

## Remaining blind spots

- Dynamic access laundered through a generic helper (`function dump<T>(o: T) { return Object.keys(o) }`) hides the concrete type from the sink detection.
- An exported function with several `return` statements returning different object literals is skipped entirely, rather than guessed at.
- Only the top level of an object literal is read, in both the const-object and returned-object checks. `const cfg = { outer: { inner: 1, deadInner: 2 } }` reports nothing about `deadInner`: reaching it safely means proving that every read of `cfg.outer` keeps the value local, and that check is not written yet.
- A member the code writes but never reads is a reference like any other, so an annotated literal that fills in `spareJars` keeps that member off the report. The `write-only` verdict covers the case the reference check cannot see — a literal typed by inference — and not this one, where the reference is right there.
- Anonymous default-export classes (`export default class { … }`) are skipped: without a name there are no class references to run the escape checks on.
- Declaration files (`.d.ts`) are not scanned.
- Anonymous default exports (`export default { … }`) have no name to search references for, so the export check skips them.
- A file consumed only through a bare `import './x'` for its side effects counts as used when its importer is reachable, even if nothing else touches it. That is the safe reading.
- An entry point nothing declares in writing — a file loaded by a name the code computes at runtime — is a false positive until you pass it with `--entry`. Run `norefs entries` to see what was found before reaching for the flag.
- A dependency consumed without an import, without a script, without a config naming it, and without a host that lists it as a peer — a binary called from a Makefile, say — shows up as unused until you add it to `ignoreDependencies`. A binary named in a `package.json` script is read; anywhere else is not.
- A devDependency is never called unused when the package is not installed, because its binaries live in its own manifest and there is nothing there to read.

## Project layout

```
src/
  index.ts      CLI entry point
  config.ts     norefs.config.json loading and `norefs init`
  engine/       project loading, the module-level checks (files, exports, namespaces, dependencies),
                the project-wide reference index, what the build writes down (entry points,
                tool configs, workspaces), the syntax-only pipeline and its scanner,
                suppression comments, human-readable labels, orchestration, output formatting
  collectors/   one file per source of candidate members (interfaces, type literals, returned objects, enums, const objects, classes)
  filters/      post-collection filters (e.g. the anonymous-findings gate)
  types/        shared types
```

Adding a new source of candidates (JSX-spread props, …) means adding one file to `src/collectors/` and registering it in `src/collectors/index.ts`. Adding a new filter means extending `src/filters/index.ts`.

## Development

```sh
pnpm install
pnpm run build   # compile to dist/
pnpm test        # vitest fixture suite (tests/fixtures covers one usage pattern per file)
pnpm run lint    # biome lint
pnpm run format  # biome format --write
```

## License

ISC
