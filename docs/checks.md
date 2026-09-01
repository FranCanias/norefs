# What norefs finds

`norefs` loads your project with [ts-morph](https://ts-morph.com) and runs two passes.

## Module-level checks

- **Unused files** — no chain of imports from any entry point reaches the file. Because the check is reachability, not a count of direct importers, a whole dead cluster gets reported — including two unused files that only import each other. Entry points are read from what the build already declares — see [Entry points](configuration.md#entry-points) — and `--entry` adds any the build does not name. Test, spec, stories, bench, and config files (and anything under a harness directory — `__tests__`, `__mocks__`, `benchmarks`, and any name that is `test` or `tests` beside a word and a separator, on either side: `tests`, `type-tests`, `test-d`) are their own entry points, so they are never reported either — and their members are not analyzed: a fixture type with an unread field is noise, not dead code.
- **Unused exports** and **unused exported types** — an exported declaration that nothing outside its file uses. Interfaces, type aliases, and enums count as types; functions, classes, variables, and namespaces count as exports. References resolve through re-export chains, so a barrel between the declaration and its consumers does not hide usage. A default export with no name of its own — `export default { … }`, `export default class { … }` — is checked too, and reads ``dead default export``: nothing local can use it, since there is no name to use, so it is imported or it is dead. The exception is a harness file, where the default export is how a tool takes its input — a vitest config, a storybook story — and no import will ever name it. A declaration that is used inside its own file but never imported is reported as **over-exported**: the `export` keyword is dead even though the code is not, so the fix is to drop the keyword, not to delete the declaration. Declaration files the project wrote are scanned too: an exported type in `src/api.d.ts` that nothing imports is as dead as one in `src/api.ts`, and its members answer the same way. A `.d.ts` a package ships is never scanned, and neither is one nothing imports. The public API is never reported: every declaration an entry file exports — resolved through re-export chains, `export *` and `export * as ns` included — is exempt, members and all, because its consumers live outside this program.
- **Exports in used namespace** and **exported types in used namespace** — the same check, at lower confidence, for two namespace shapes. When a module is consumed through a used `import * as ns` binding whose every use is a property read, its zero-reference exports are reported this way, because the namespace object may still be consumed dynamically. And when a TS `namespace N { … }` is used, its exported members whose references never leave the namespace body are reported this way too. A namespace object that leaves as a whole — `import * as schema from './schema'` then `orm(db, { schema })` — is a different story: the consumer walks its keys and no reference search can see it, so that module is exempt down to its last member, exactly like public API.
- **Stranded handlers** — a handler registered under a channel string (`ipcMain.handle('recipeBox:load', …)`) whose every sender this report deletes. norefs finds the bridge your own `.d.ts` declares without being told; name any other boundary — HTTP routes, a socket bus — with the [`boundaries`](configuration.md#boundaries) config key. The registration keeps the handler "used", so no reference-based analysis will ever flag it — including the next norefs run, once you remove the wrapper that sends to it. The finding lands on the handler's own file and line, while it is still visible. A sender counts as dying only when its own declaration goes: the method that holds the channel string, not the class around it, and never an over-exported declaration, whose fix drops a keyword and deletes nothing. It obeys `--scope` and the suppression comments like any other finding; the note on the wrapper names the far side either way.
- **Unused dependencies**, **unlisted dependencies**, and **misplaced dependencies** — see [Dependencies](dependencies.md). An entry nothing imports, no script runs, no tool config names, and no package this project uses declares as its own optional peer; an imported package no scanned `package.json` lists; and an entry whose section does not match how it is used. Peer and optional dependencies exist for consumers and are never reported. `@types/*` packages are consumed by the compiler and pair with their base package. Path aliases, node builtins, and relative imports never count as packages.

A finding at a higher level swallows the findings inside it: an unused file hides its exports and members, an unused export with zero references anywhere hides its members, and a type losing every member folds them into its one `becomes empty` finding. One line per problem, not fifty.

## Verdicts

Every finding carries a verdict: the claim it makes, with its safety profile. "Unused" is not one claim — it is six:

- **dead** — no references, no structural twin, no boundary crossing, and every write of the name accounted for. Safe to delete, and `--fix` does.
- **over-exported** — used in its own file only. Safe to de-export, and `--fix` does.
- **write-only** — the code fills the member in and never reads it back. The evidence says which kind you are holding, strongest first: *every reference is a write* — the literals, JSX attributes, and assignments that set it resolve to this very member, and not one read does. An update whose old value goes straight back in (`count += 1`, or `count++` on a line of its own) writes; one whose value is handed on (`const n = count++`) reads; a key the source computes writes too when it is assigned through — `shelf[slot] = 4` names its members as surely as writing them out would, and the key's type says which; a *typed write* — the member has no references at all, but a write elsewhere flows into a use whose type declares it; an *unverified name match* — a write the analysis could not type either way, and only while the matches are few enough to be a lead worth walking. Past a handful the count is all it means, and the verdict falls back to `dead` with that count in the evidence. A name match that provably feeds a *different* type is discarded instead of reported, so a member is never protected by how popular its name is elsewhere. A read that reaches the value through another declaration — what `satisfies` and `as const` leave behind — is a read, and keeps the member off this list. So is a write this run cannot follow: a literal handed to a body norefs does not hold — a package, an ambient declaration, an overload with no implementation — is read at the far end, and the member keeps the answer it had before. `--fix-unsafe` retires a proven write-only member together with the writes that prove it, where each of them is one edit — an object-literal property, a JSX attribute. An assignment statement is not: its right-hand side may be doing work that has to stay. A member written that way is reported and left for you.
- **contract** — the type's values cross a boundary the types cannot follow: a serialization call (`JSON.parse`, `JSON.stringify`, `structuredClone`, `postMessage`), a call on something a project `.d.ts` declares (an IPC bridge, a preload global), or any untraced result (`any`/`unknown`) pinned to the type by assertion — directly or through a containing type. The members document a wire format; deleting them destroys the documentation, not the data. When a twin of the type sits across the boundary, the two findings merge into one contract and each names the other side.
- **shadowed** — a duplicate of the type elsewhere *is* read: a structurally identical twin, or a same-named type whose shape overlaps enough to be a drifted copy. A reference is not a read — two copies whose builders both only fill the member in shadow nobody, and the evidence says which of the two it found. The member is probably alive through the duplicate, and the real finding is the duplication: merge the twins, don't delete the member.
- **test-only** — production code never touches it; only test files keep it alive. The verdict is about shipping code, so it is never said of the harness itself: a fixture under `tests/` that only tests import is a fixture doing its job. A real and common category of dead code, and never auto-fixed: the fix is deleting the code together with its tests, and only a human deletes tests. [`--production`](#production-mode) is the stricter cut, where the tests are not there at all.

Each soft verdict prints its evidence — the twin that reads the member, the boundary the type crosses. `--fix` only applies `dead` and `over-exported` findings; the rest wait for `--fix-unsafe` or your judgment.

## Member-level checks

The member pass looks for six kinds of member owners:

- `interface` declarations
- `type` aliases, and any inline object type (parameter types, return types, variable annotations — this covers React props like `function Foo({a}: {a: string})`)
- object literals returned from functions whose return type is inferred (not explicitly annotated) — exported or not, so a local producer whose output nobody reads is one finding: the computation is dead weight
- `enum` declarations
- **const object literals** — `const Timeouts = { … } as const`, the enum modern TypeScript writes. `Timeouts.SAVE_DEBOUNCE` reads a member the way an enum member is read, so a member nothing reads is dead the same way. Plain `const x = { … }` counts too, and a property written the short way (`{ spareJar }`) is a property like any other; a declared shape does not, because the type that declares it is what gets reported (see below)
- `class` declarations (properties, methods, accessors, static members, and constructor parameter properties)

A function is read through every `return` it has. Each literal it hands back is a shape of its own, so `if (wide) return { handle, deadWide }; return { handle, deadNarrow }` reports both dead keys — and a key more than one branch writes is reported only when every one of those branches is unread, because two branches of one shape share a single set of declarations. A `return` of anything but a literal leaves the function alone.

Both object-literal owners are read to their full depth. A literal nested inside another is a shape of its own, so `const cfg = { oven: { tray: 'steel', deadRack: 'wire' } }` reports `deadRack` in ``const `cfg.oven` `` — but only where every read of `oven` keeps the value local. A property can hold one shape per element too: `{ cards: [{ title, deadNote }, { title, deadNote }] }` reports `deadNote` on both cards, as long as every element stays local — read through a callback written on the spot, a `for…of` binding, or an index. The elements answer together, so a name any one of them holds a read on is alive on all of them. A read that hands the whole inner shape onward stops the descent there, and so does a property nothing reads: that property is the finding, and the members under it would tell one death twice. [Limitations](limitations.md) has the full rule.

For each property it finds, it asks norefs' own project-wide reference index (via `findReferencesAsNodes`) whether anything reads it — one pass over every identifier, rather than a language-service query per declaration; see [Speed](speed.md). No references beyond the declaration itself means the property is unused.

Because the check is reference-based, it follows structural typing correctly — `v.x` resolves back to `interface A { x: number }` even without an explicit cast. See [Limitations](limitations.md) for where that breaks down.

When every member of a named interface or type alias is unused while the type itself is still referenced, the member findings fold into one: ``interface `X` becomes empty: all 6 members are dead``. That is one logical fact, so it is one finding, carrying the most cautious verdict of the members it swallowed. Removing the members would leave an empty `interface X {}` behind, and only you know whether its consumers should go too — `--fix` never touches these. An interface that extends another is exempt — empty, it still works as an alias.

A shape written inline on a property or on a binding folds the same way, and reads ``property `labels` becomes empty: all 2 members are dead``. `{ labels: { deadColor, deadFont } }` has no declaration to answer for the inner shape — the property is what a reader would delete, so the property is the finding, whether the shape is written as a value or as a type. The property itself is still read: that is the only reason norefs looked inside it, since a nested shape is only read member by member where every read of the holding property keeps the value local. So the fold always leaves a read behind that now reaches nothing, and removing the property means removing that read too — a human's call, exactly like an emptied interface's consumers. Without the fold, `--fix` would delete the members and leave `labels: {}` sitting there: dead, and invisible to the next run.

A `const box = { … }` that loses every member folds onto the binding for the same reason — ``const `box` becomes empty: all 2 members are dead`` — but only while something still reads `box`. A binding nothing reads is not a fold: the members are reported one by one, and the cleanup pass takes the whole declaration with them. Nothing outlives that removal, so nothing needs your judgment.

## Three kinds by their `--only` names

Most `--only` names read as the checks above: `files`, `exports`, `types`, `members`, `dependencies`, `unlisted`, `misplaced`, `stranded`. Three are less obvious, so here they are defined:

| `--only` name | What it reports |
| --- | --- |
| `ns-exports` | An unused export whose namespace — a TS `namespace` or an `import * as` binding — is used, so the export may still be consumed dynamically |
| `ns-types` | The same, for an exported type |
| `empty-types` | A still-referenced type — or a property or binding holding an inline shape — that becomes empty once its unused members go: the folded `becomes empty` finding above |

## Production mode

Every finding norefs makes is relative to a question. The default question is "does anything in this repository use it?", and the tests count — a member only a test reads is labelled `test-only`, not dead, because deleting it breaks something real.

`--production` asks the stricter question: **what is left standing if the tests were not there at all?**

```sh
norefs --production
```

Test, spec, stories, bench and config files — and everything under a harness directory — are treated as absent. Three things follow, and they are the whole definition:

- They stop keeping code reachable. A file only a test imports becomes a **dead file**, where a normal run would only label its exports `test-only`.
- Their references stop counting. What was `test-only` becomes plain **dead**.
- They report nothing of their own. A dead export inside a test file is not a finding, because that file is not part of the question.

`devDependencies` fall outside it too: they exist to build and test. So does the misplaced-dependency check, which needs both halves of the code to decide anything. A `dependencies` entry only the tests import is simply unused here.

**It never combines with `--fix`.** A production finding is dead to the shipping path and may be perfectly alive in the tests this run ignored — deleting it breaks them. That is the same reason `test-only` findings are never fixed either: the fix is deleting the tests too, and only you do that. `norefs --production --fix` is a usage error, exit code 2.

The two modes answer different questions, so run both: the default one to find what nothing uses, `--production` to find what only the scaffolding is holding up.

---

[← All docs](README.md)
