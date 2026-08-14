# What norefs finds

`norefs` loads your project with [ts-morph](https://ts-morph.com) and runs two passes.

## Module-level checks

- **Unused files** — no chain of imports from any entry point reaches the file. Because the check is reachability, not a count of direct importers, a whole dead cluster gets reported — including two unused files that only import each other. Entry points are read from what the build already declares — see [Entry points](configuration.md#entry-points) — and `--entry` adds any the build does not name. Test, spec, stories, bench, and config files (and anything under a `test`, `tests`, `__tests__`, or `__mocks__` directory) are their own entry points, so they are never reported either — and their members are not analyzed: a fixture type with an unread field is noise, not dead code.
- **Unused exports** and **unused exported types** — an exported declaration that nothing outside its file uses. Interfaces, type aliases, and enums count as types; functions, classes, variables, and namespaces count as exports. References resolve through re-export chains, so a barrel between the declaration and its consumers does not hide usage. A declaration that is used inside its own file but never imported is reported as **over-exported**: the `export` keyword is dead even though the code is not, so the fix is to drop the keyword, not to delete the declaration. The public API is never reported: every declaration an entry file exports — resolved through re-export chains, `export *` and `export * as ns` included — is exempt, members and all, because its consumers live outside this program.
- **Exports in used namespace** and **exported types in used namespace** — the same check, at lower confidence, for two namespace shapes. When a module is consumed through a used `import * as ns` binding, its zero-reference exports are reported this way, because the namespace object may be consumed dynamically. And when a TS `namespace N { … }` is used, its exported members whose references never leave the namespace body are reported this way too.
- **Stranded handlers** — a handler registered under a channel string (`ipcMain.handle('recipeBox:load', …)`) whose every sender this report deletes. norefs finds the bridge your own `.d.ts` declares without being told; name any other boundary — HTTP routes, a socket bus — with the [`boundaries`](configuration.md#boundaries) config key. The registration keeps the handler "used", so no reference-based analysis will ever flag it — including the next norefs run, once you remove the wrapper that sends to it. The finding lands on the handler's own file and line, while it is still visible. A sender counts as dying only when its own declaration goes: the method that holds the channel string, not the class around it, and never an over-exported declaration, whose fix drops a keyword and deletes nothing. It obeys `--scope` and the suppression comments like any other finding; the note on the wrapper names the far side either way.
- **Unused dependencies**, **unlisted dependencies**, and **misplaced dependencies** — see [Dependencies](dependencies.md). An entry nothing imports and no script runs; an imported package no scanned `package.json` lists; and an entry whose section does not match how it is used. Peer and optional dependencies exist for consumers and are never reported. `@types/*` packages are consumed by the compiler and pair with their base package. Path aliases, node builtins, and relative imports never count as packages.

A finding at a higher level swallows the findings inside it: an unused file hides its exports and members, an unused export with zero references anywhere hides its members, and a type losing every member folds them into its one `becomes empty` finding. One line per problem, not fifty.

## Verdicts

Every finding carries a verdict: the claim it makes, with its safety profile. "Unused" is not one claim — it is six:

- **dead** — no references, no structural twin, no boundary crossing, and every write of the name accounted for. Safe to delete, and `--fix` does.
- **over-exported** — used in its own file only. Safe to de-export, and `--fix` does.
- **write-only** — a write of the member's name exists, and it survived validation against the type it feeds. The evidence says which kind you are holding: a *typed write* is proven — the value flows into a use whose type declares this very member, and nothing reads it; an *unverified name match* is a write the analysis could not type either way. A name match that provably feeds a *different* type is discarded instead of reported, so a member is never protected by how popular its name is elsewhere. `--fix-unsafe` retires a proven write-only member together with the writes that prove it.
- **contract** — the type's values cross a boundary the types cannot follow: a serialization call (`JSON.parse`, `JSON.stringify`, `structuredClone`, `postMessage`), a call on something a project `.d.ts` declares (an IPC bridge, a preload global), or any untraced result (`any`/`unknown`) pinned to the type by assertion — directly or through a containing type. The members document a wire format; deleting them destroys the documentation, not the data. When a twin of the type sits across the boundary, the two findings merge into one contract and each names the other side.
- **shadowed** — a duplicate of the type elsewhere *is* read: a structurally identical twin, or a same-named type whose shape overlaps enough to be a drifted copy. The member is probably alive through the duplicate, and the real finding is the duplication: merge the twins, don't delete the member.
- **test-only** — production code never touches it; only test files keep it alive. A real and common category of dead code, and never auto-fixed: the fix is deleting the code together with its tests, and only a human deletes tests. [`--production`](#production-mode) is the stricter cut, where the tests are not there at all.

Each soft verdict prints its evidence — the twin that reads the member, the boundary the type crosses. `--fix` only applies `dead` and `over-exported` findings; the rest wait for `--fix-unsafe` or your judgment.

## Member-level checks

The member pass looks for six kinds of member owners:

- `interface` declarations
- `type` aliases, and any inline object type (parameter types, return types, variable annotations — this covers React props like `function Foo({a}: {a: string})`)
- object literals returned from functions whose return type is inferred (not explicitly annotated) — exported or not, so a local producer whose output nobody reads is one finding: the computation is dead weight
- `enum` declarations
- **const object literals** — `const Timeouts = { … } as const`, the enum modern TypeScript writes. `Timeouts.SAVE_DEBOUNCE` reads a member the way an enum member is read, so a member nothing reads is dead the same way. Plain `const x = { … }` counts too, and a property written the short way (`{ spareJar }`) is a property like any other; a declared shape does not, because the type that declares it is what gets reported (see below)
- `class` declarations (properties, methods, accessors, static members, and constructor parameter properties)

For each property it finds, it asks TypeScript's own "find all references" (via `findReferencesAsNodes`) whether anything reads it. No references beyond the declaration itself means the property is unused.

Because the check is reference-based, it follows structural typing correctly — `v.x` resolves back to `interface A { x: number }` even without an explicit cast. See [Limitations](limitations.md) for where that breaks down.

When every member of a named interface or type alias is unused while the type itself is still referenced, the member findings fold into one: ``interface `X` becomes empty: all 6 members are dead``. That is one logical fact, so it is one finding, carrying the most cautious verdict of the members it swallowed. Removing the members would leave an empty `interface X {}` behind, and only you know whether its consumers should go too — `--fix` never touches these. An interface that extends another is exempt — empty, it still works as an alias.

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
