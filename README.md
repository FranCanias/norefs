# noref

Find unused files, exports, and type/object members in a TypeScript project.

Most dead-code tools stop at the declaration boundary: an interface counts as "used" even when half its members are dead. `noref` checks both levels. It finds unused files, unused exports, and unused exported types — and then looks inside the types that *are* used, including objects returned from exported functions and objects used as React component props.

## How it works

`noref` loads your project with [ts-morph](https://ts-morph.com) and runs two passes.

### Module-level checks

- **Unused files** — no other file imports or re-exports the file. Entry points are exempt: paths given with `--entry`, and `index`/`main`/`cli` files in the project root or `src/`. Test, spec, stories, bench, and config files (and anything under a `test`, `tests`, `__tests__`, or `__mocks__` directory) are their own entry points, so they are never reported either.
- **Unused exports** and **unused exported types** — an exported declaration that nothing outside its file uses. Interfaces, type aliases, and enums count as types; functions, classes, variables, and namespaces count as exports. References resolve through re-export chains, so a barrel between the declaration and its consumers does not hide usage. A declaration that is used inside its own file but never imported still gets reported: the `export` keyword is dead even though the code is not. Exports of entry files are the public API and are never reported.
- **Exports in used namespace** and **exported types in used namespace** — the same check, at lower confidence, for two namespace shapes. When a module is consumed through a used `import * as ns` binding, its zero-reference exports are reported this way, because the namespace object may be consumed dynamically. And when a TS `namespace N { … }` is used, its exported members whose references never leave the namespace body are reported this way too.

A finding at a higher level swallows the findings inside it: an unused file hides its exports and members, and an unused export with zero references anywhere hides its members. One line per problem, not fifty.

### Member-level checks

The member pass looks for five kinds of member owners:

- `interface` declarations
- `type` aliases, and any inline object type (parameter types, return types, variable annotations — this covers React props like `function Foo({a}: {a: string})`)
- object literals returned from exported functions whose return type is inferred (not explicitly annotated)
- `enum` declarations
- `class` declarations (properties, methods, accessors, static members, and constructor parameter properties)

For each property it finds, it asks TypeScript's own "find all references" (via `findReferencesAsNodes`) whether anything reads it. No references beyond the declaration itself means the property is unused.

Because the check is reference-based, it follows structural typing correctly — `v.x` resolves back to `interface A { x: number }` even without an explicit cast. See [Limitations](#limitations) for where that breaks down.

## Install

`noref` isn't published yet. From a checkout of this repository:

```sh
pnpm install
pnpm run build
pnpm link --global
```

Then run `noref` from any project with a `tsconfig.json`.

## Usage

```sh
noref [options]
```

| Option | Description |
| --- | --- |
| `-p, --project <path>` | Path to `tsconfig.json` (default: `./tsconfig.json`) |
| `--scope <path>` | Only report findings declared under this path; the whole project still resolves usages |
| `--entry <path>` | Treat this file or directory as an entry point: never reported unused, exports never reported (repeatable) |
| `--json` | Print findings as JSON |
| `--export <md\|json>` | Also write findings to `noref-findings.md` or `noref-findings.json` in the current directory |
| `--fix` | Remove reported members and dead `export` keywords from the source files |
| `--no-anonymous` | Hide findings on unnamed inline types and anonymous functions |
| `-h, --help` | Show the help message |

`noref` exits with code `1` when it finds unused code, `0` otherwise — so it slots into CI the same way a linter does. With `--fix` it exits `0` after it removes what it found.

### Fixing automatically

`noref --fix` prints the findings, then fixes what it safely can and saves the files:

- An unused member is deleted. One case is special: an unused parameter property (`constructor(private readonly dead: number)`) only loses its modifiers and stays a plain parameter, so the constructor signature and every `new` call site keep working.
- An unused export loses its `export` keyword (or its `export { … }` specifier); the declaration stays, because it may still be used inside the file.
- Unused files and namespace findings are never touched. Deleting a file is your call, and a namespace finding is a lower-confidence guess.

Review the diff before you commit — removed code can leave behind code that only it used, so a second run may find more.

### Example

```
src/models/User.ts
  4:3  unused property `legacyId` in interface `User`

src/legacy/formatter.ts
  unused file

src/hooks/useConfig.ts
  8:14  unused export `configDefaults`
  12:5  unused property `debugMode` in the return value of `useConfig`

Unused code (4): 1 file, 1 export, 2 properties
```

### Filtering out anonymous findings

Some findings point at inline types with no name to anchor them — a `{x, y}` parameter type on an anonymous callback, for instance. These are more prone to false positives: TypeScript's reference search loses track of a value forwarded via shorthand into a *differently-declared* structural type, because the read then resolves to the other declaration. Run with `--no-anonymous` to see only findings tied to a named interface, type alias, or function:

```sh
noref --no-anonymous
```

### Cross-project scans

To find unused properties in a library whose only consumer lives in another repo, give noref one tsconfig that sees both sides:

1. Write an umbrella `tsconfig.json` whose `include` covers both projects' source files.
2. Reproduce **every** path alias from both repos in its `paths` — including the library's internal aliases — and map the package specifier (`"my-lib"`) to the library's `src` entry point, not its built `.d.ts`.
3. Run `noref -p umbrella.tsconfig.json --scope path/to/library/src`.

Resolution is everything here: each import that fails to resolve hides all references flowing through it, which turns used properties into "unused" findings. noref checks for this and prints a warning listing the unresolved specifiers — fix those before trusting the results.

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

## When noref stays silent

Some consumption is invisible to static reference search. Rather than guess, noref suppresses those findings entirely:

- **`keyof`-targeted types**: when `keyof T` appears anywhere, code is enumerating or indexing T's keys dynamically. All of T's members are skipped.
- **Key-enumerating and serializing sinks**: a value passed to `Object.keys`/`values`/`entries`/`assign`, `JSON.stringify`, `structuredClone`, or `Reflect.ownKeys`, iterated with `for...in`, or probed with a dynamic `key in v` marks its whole type as dynamically consumed.
- **Escaping values**: when an object leaves local view as a whole — a returned literal passed on as a bare argument, a whole-binding parameter or variable forwarded via shorthand into a differently-declared type, a property whose value flows onward wholesale, an `as`/`satisfies` cast whose value is spread into a combined array or passed bare — its properties may be consumed without any per-property reference. The affected type literal is skipped.
- **Assignability-required members**: a declared relation can make a member load-bearing with zero references. An `extends`/`implements` override (`interface Derived extends Base { items: DerivedItem[] }`) or a type predicate (`v is Derived`) forces one type to stay assignable to another, so the required members of the base shape are kept even when nothing reads them.
- **Parameters of function types**: callback signatures declare parameter types, but implementations bind their own parameters; when callbacks are invoked with variables rather than literals, the signature's members can't be tracked.
- **Structural class implementations**: when an instance escapes into a type that is not the class or its declared heritage — `return new StoreImpl()` from a function typed as interface `Store`, with no `implements` clause — every call goes through the interface and the class members collect zero references while being used at runtime. The whole class is skipped, along with its base classes and any class whose instances only leave through methods of such a class. Declaring `implements` restores tracking.
- **Decorated classes**: a decorator hands the class to a framework that reads members through reflection or metadata. The whole class is skipped.
- **Dynamically consumed enums**: `keyof typeof E`, `Object.values(E)`, `for...in`, and reverse mapping or computed lookup (`E[x]`) all reach members without per-member references. The whole enum is skipped.

## Remaining blind spots

- Dynamic access laundered through a generic helper (`function dump<T>(o: T) { return Object.keys(o) }`) hides the concrete type from the sink detection.
- An exported function with several `return` statements returning different object literals is skipped entirely, rather than guessed at.
- Anonymous default-export classes (`export default class { … }`) are skipped: without a name there are no class references to run the escape checks on.
- Declaration files (`.d.ts`) are not scanned.
- Two unused files that import each other keep each other alive: the unused-file check counts direct references, not reachability from the entry points. Removing one and re-running finds the other.
- Anonymous default exports (`export default { … }`) have no name to search references for, so the export check skips them.
- A file consumed only through a bare `import './x'` for its side effects counts as used, even if nothing else touches it. That is the safe reading.
- An entry point noref cannot guess (a script run directly with `node`, a file named in `package.json`) is a false positive until you pass it with `--entry`.

## Project layout

```
src/
  index.ts      CLI entry point
  engine/       project loading, the module-level checks (files, exports, namespaces), the unused-reference check,
                human-readable labels, orchestration, output formatting
  collectors/   one file per source of candidate members (interfaces, type literals, returned objects, enums, classes)
  filters/      post-collection filters (e.g. --no-anonymous)
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
