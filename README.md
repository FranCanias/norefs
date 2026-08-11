# noref

Find unused members of TypeScript interfaces, type aliases, object literals, enums, and classes.

Most dead-code tools find unused files, exports, and dependencies. They stop at the declaration boundary: an interface counts as "used" even when half its members are dead. `noref` looks inside — including objects returned from exported functions and objects used as React component props.

## How it works

`noref` loads your project with [ts-morph](https://ts-morph.com) and looks for five kinds of member owners:

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
| `--scope <path>` | Only report properties declared under this path; the whole project still resolves usages |
| `--json` | Print findings as JSON |
| `--export <md\|json>` | Also write findings to `noref-findings.md` or `noref-findings.json` in the current directory |
| `--no-anonymous` | Hide findings on unnamed inline types and anonymous functions |
| `-h, --help` | Show the help message |

`noref` exits with code `1` when it finds unused properties, `0` otherwise — so it slots into CI the same way a linter does.

### Example

```
src/models/User.ts
  4:3  unused property `legacyId` in interface `User`

src/hooks/useConfig.ts
  12:5  unused property `debugMode` in the return value of `useConfig`

Unused properties (2)
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
- **Escaping values**: when an object leaves local view as a whole — a returned literal passed on as a bare argument, a whole-binding parameter or variable forwarded via shorthand into a differently-declared type, a property whose value flows onward wholesale — its properties may be consumed without any per-property reference. The affected type literal is skipped.
- **Parameters of function types**: callback signatures declare parameter types, but implementations bind their own parameters; when callbacks are invoked with variables rather than literals, the signature's members can't be tracked.
- **Structural class implementations**: when an instance escapes into a type that is not the class or its declared heritage — `return new DeviceImpl()` from a function typed as interface `Device`, with no `implements` clause — every call goes through the interface and the class members collect zero references while being used at runtime. The whole class is skipped, along with its base classes and any class whose instances only leave through methods of such a class. Declaring `implements` restores tracking.
- **Decorated classes**: a decorator hands the class to a framework that reads members through reflection or metadata. The whole class is skipped.
- **Dynamically consumed enums**: `keyof typeof E`, `Object.values(E)`, `for...in`, and reverse mapping or computed lookup (`E[x]`) all reach members without per-member references. The whole enum is skipped.

## Remaining blind spots

- Dynamic access laundered through a generic helper (`function dump<T>(o: T) { return Object.keys(o) }`) hides the concrete type from the sink detection.
- An exported function with several `return` statements returning different object literals is skipped entirely, rather than guessed at.
- Anonymous default-export classes (`export default class { … }`) are skipped: without a name there are no class references to run the escape checks on.
- Declaration files (`.d.ts`) are not scanned.

## Project layout

```
src/
  index.ts      CLI entry point
  engine/       project loading, the unused-reference check, human-readable labels, orchestration, output formatting
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
