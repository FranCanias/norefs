# noref

Find unused properties on TypeScript interfaces, type aliases, and object literals.

Most dead-code tools find unused files, exports, and dependencies. Some also find unused members of enums and classes. None yet find unused members of **types, interfaces, and object literals** — including objects returned from exported functions and objects used as React component props. `noref` fills that one gap.

## How it works

`noref` loads your project with [ts-morph](https://ts-morph.com) and looks for three kinds of property owners:

- `interface` declarations
- `type` aliases, and any inline object type (parameter types, return types, variable annotations — this covers React props like `function Foo({a}: {a: string})`)
- object literals returned from exported functions whose return type is inferred (not explicitly annotated)

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
| `--json` | Print findings as JSON |
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

Some findings point at inline types with no name to anchor them — a `{x, y}` parameter type on an anonymous callback, for instance. These are more prone to false positives: TypeScript's reference search can't follow a value once it's passed into a *different*, structurally-compatible type (e.g. spread into a differently-typed object). Run with `--no-anonymous` to see only findings tied to a named interface, type alias, or function:

```sh
noref --no-anonymous
```

## Limitations

- **Pass-through properties**: a property read only after being spread (`{...obj}`) or reassigned into a differently-typed object won't be seen as used. This is the main source of false positives; `--no-anonymous` filters out most of them.
- **Dynamic access**: `obj['key']` through a variable, `Object.keys(obj)`, and `in` checks don't count as a reference.
- **Multiple return shapes**: an exported function with several `return` statements returning different object literals is skipped entirely, rather than guessed at.
- **Declaration files** (`.d.ts`) are not scanned.

When in doubt, treat a finding as a lead worth checking, not a guaranteed dead property.

## Project layout

```
src/
  index.ts      CLI entry point
  engine/       project loading, the unused-reference check, human-readable labels, orchestration, output formatting
  collectors/   one file per source of candidate properties (interfaces, type literals, returned objects)
  filters/      post-collection filters (e.g. --no-anonymous)
  types/        shared types
```

Adding a new source of candidates (classes, enums, JSX-spread props, …) means adding one file to `src/collectors/` and registering it in `src/collectors/index.ts`. Adding a new filter means extending `src/filters/index.ts`.

## Development

```sh
pnpm install
pnpm run build   # compile to dist/
pnpm run lint    # biome lint
pnpm run format  # biome format --write
```

## License

ISC
