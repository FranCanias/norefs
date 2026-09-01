# Configuration

## The config file

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

The file holds **settings** — what shapes the analysis and the report. Those are true of a project every time it is analyzed, so they belong in a file everyone shares. It never holds an **action**: `--fix`, `--fix-unsafe`, `--baseline`, `--ratchet`, `--dry-run`, `--export` and `--watch` each write something, and what a run does to your working tree is a decision you make at the moment you make it. An action key in the config file is an error, not a silent surprise.

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

All keys are optional. `project` also accepts an array of tsconfig paths for a monorepo. `entry` merges with `--entry`; for every other key, a flag passed on the run wins over the file. `--no-anon`, `--no-explain` and `--no-production` are how a run says no to a project that said yes. `ignore` takes globs, matched against paths relative to the current directory (and absolute paths). Ignored files produce no findings, but their contents still count as usage of other code. `ignoreDependencies` takes package names or globs the dependency checks never report. `boundaries` is described below.

## Boundaries

norefs finds one kind of boundary on its own: a callee your project's own `.d.ts` declares — a preload global, an ambient IPC handle. That call leaves the program, so the string it takes first is a channel, and whatever registers a handler under the same string is its far side. That is the [stranded handler](checks.md#module-level-checks) check, and it needs no configuration.

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

## Suppressing findings

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
  title: string;
  cuisine: string;
  author: string;
  steps: string[];
}
```

It covers that declaration and every finding inside it: the members, the nested type literals under them, and the declaration itself. Put it on the declaration's line or in the comments above it — before or after a doc comment, either reads the same. Anything that holds findings takes it: an interface, a type alias, a class, a namespace, an enum, a const object, a producer whose returned object is flagged, an import.

Three marks, three reaches: `norefs-ignore` for one finding, `norefs-ignore-block` for a declaration and its contents, and `norefs-ignore-file` before a file's first statement for the whole file — generated code, for instance — which also covers the unused-file finding.

## Entry points

An entry point is where the import graph starts: the file is never reported unused, and its exports are the public API, so they are never reported either. Getting the list wrong is expensive in both directions — a missing entry reports a live file as dead, an invented one hides real findings.

So norefs does not ask you to keep the list. Your build already has it, written down in files norefs can read:

| Declared in | What is read |
| --- | --- |
| `package.json` | `main`, `types`, `bin`, and `exports`; paths into the compiled output map back to source through the tsconfig `outDir` and `rootDir`. When that mapping lands on no file the run holds, the package's source roots are tried instead — a bundler builds what it likes, and a tsconfig kept for the type check alone is free to describe a build nobody runs. Two roots answering at once is no answer, so nothing is named. A subpath pattern — `"./*": "./dist/*.js"` — publishes every module it matches and names none of them, so it is matched against the files the run holds, harness files excepted. Naming none of them, it keeps a file alive without putting it on the shipping path |
| `package.json` scripts | any argument that names a project file — `tsx src/server.ts`, `--config=playwright.config.ts`. A directory is a place to look, not a module: `eslint src` names no entry point |
| `*.html` | the `src` of every `<script>`; a leading `/` is the package root, as bundlers read it |
| `*.config.*` | every quoted path that lands on a project file — Vite's `input`, Vitest's `setupFiles`, Playwright's `globalSetup`, an alias target, and the same in tools nobody has written a plugin for. A build with two targets writes the second one down the same way, so `vite.config.server.ts` beside the manifest is read too |
| convention | `index`/`main`/`cli` beside a tsconfig or in its `src/` |

Nothing is executed. A config is read as text, and a path string that names a file this project holds is taken at its word — one rule, no per-tool plugins. Build output (`dist`, `build`, `out`, `coverage`, …) and `node_modules` are never walked, so a stale config in `dist/` cannot silence anything.

A path in a config is read the way an import is written: with its extension, without one, or as the directory whose `index` is the module. A script's argument is read one step tighter, because a command takes directories for a different reason — `eslint src` scans a tree, and calling `src/index.ts` an entry point on the strength of that would publish every export in it.

A bare word is left alone either way. `environment: 'jsdom'` names a package, not a file, and guessing an extension for it would silence every finding in a file that happened to share the name.

An entry point a config names is worth less than one the manifest names, and the difference shows in one place. Nothing evaluates a config, so a path in one is read at face value — and vitest's `coverage.exclude` is a list of paths that are exactly the *opposite* of an entry point. That reading is strong enough to keep a file alive, which costs a finding when it is wrong, and too weak to say the file is what the package ships. So the dependency check leaves a config's entry points out of the shipping path it works from: `src/vitest/` named in a coverage list is not evidence that a test framework belongs in `dependencies`.

What a config *imports* is not an entry point, as long as the program holds the config itself: the import is already an edge in the graph, the config is already a root of it, and naming the target an entry point on top of that would publish that file's exports as API on the strength of one config line. A config the program never holds — `eslint.config.js`, or one the tsconfig does not include — is no root of anything, so what it imports is read as an entry point after all.

Test, spec, stories, bench, and config files are reachability roots too, on their own rule, and so is anything under `test`, `tests`, `__tests__`, `__mocks__`, `bench`, `benchmarks`, `test-d`, or a name that puts a word and a separator before those — `type-tests`, `__performance_tests__`. They are not entry points: nothing outside imports them, so their exports stay open to report.

When nothing resolves, the run says so before it reports anything. No entry point means nothing is public API and no import chain has a root, so every file a test does not reach is about to be called unused — a full report that is as meaningless as the clean one an empty tsconfig gives, and just as easy to believe.

To see what a run decided, and why:

```sh
$ norefs entries
src/boot.tsx    —  <script src> in index.html
src/main.ts     —  index/main/cli beside a tsconfig
src/preload.ts  —  a path named in vite.config.ts
src/server.ts   —  package.json scripts.serve
```

`--entry` is still there for what no config names — a script run straight with `node path/to/script.ts`, a file loaded by a name computed at runtime.

## Monorepos and cross-project scans

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

---

[← All docs](README.md)
