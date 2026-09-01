# Dependencies

A `package.json` says two things about every entry: that the project needs it, and when. norefs checks both.

**Nothing uses it.** An entry is reported dead when nothing in the project uses it, and five things count as using it.

An import, first — `require.resolve('pkg')` included, which loads nothing and still says the package has to be installed. A `/// <reference types="bun-types" />` directive counts the same way: it is the file saying it needs that package, written in the one place the import graph never looks. Only the prologue is read, because past the first token TypeScript honours no directive and the same words are prose. Then a script: `"build": "tsc -p tsconfig.json"` is TypeScript being used, and no import will ever say so — norefs reads each script's tokens and matches them against the packages you listed, by name and by the binaries each installed package declares in its own `bin` field. Then a tool config: an ESLint config imports its plugins from a file the TypeScript program never holds, and `environment: 'jsdom'` loads jsdom without naming a file at all, so a listed package written anywhere in a `*.config.*` or an `.eslintrc`-style rc file counts as used. ESLint's short plugin names are expanded on the way through: `plugins: [import]`, `plugin:unicorn/recommended` and `import/no-cycle` all name a package spelled `eslint-plugin-…`. And last, a host: `@vitest/coverage-v8` runs behind `--coverage` and `bufferutil` behind `ws`, and each of them is a peer dependency of a package this project does use — which is how the ecosystem writes down "that one loads me".

A tool's config is not always a file. `"lint-staged": { … }` and `"ava": { … }` sit in `package.json`, and the key is the tool's name — so a top-level key that names a package the manifest lists is that package being configured, and the strings inside the block are read the way a config file's are. A value written as a command-line argument is split the way a script is, which is how ava's `nodeArguments: ["--import=tsx/esm"]` says it loads tsx. Every other manifest key is npm's own and goes unread: `"keywords": ["react"]` is a word about the package, not a package in use.

The tsconfig is read for three more. `extends: "@sindresorhus/tsconfig"` is a package the build needs; `types: ["node", "@withfig/autocomplete-types"]` is the compiler being handed packages to load, the same statement a `/// <reference types>` makes; and `importHelpers` puts a `require('tslib')` in the emitted output, which is not a config naming a tool but the built code importing a package — so it answers the section question the way an import would.

Nothing here guesses which tool owns which command, or which plugin. `tsc` maps to `typescript`, and `bufferutil` to `ws`, because those packages' own manifests say so.

The imports come from every source file the project keeps, not only the ones the tsconfig holds. A package whose only importer sits in a file the config excluded — `lib/*.js` beside a `files: ["index.d.ts"]`, a `test/` directory outside `include`, a `scripts/` nobody compiles — used to read as dead, and the import was one directory listing away. Those files are read as text and count for one thing: the package is used. They can never say a name is *missing* from the manifest, or which section it belongs in — nothing in them was analyzed, so a run that read only them holds both claims back and reports neither. A config that holds no files of its own is read this way too: a solution-style tsconfig with `files: []` and a list of references holds no program, and the sources beside it are still there to read.

A workspace sibling is a different case, and gets a narrower answer. A run pointed at one package reads the other packages for what they take from it, and never for what they name: a sibling importing `lodash` says nothing about *this* package's manifest, and a claim built on a file nobody analyzed, in a package nobody asked about, would be two guesses deep.

That is also the limit. A package that is not installed has no binaries to read, so norefs will not call a devDependency unused — it cannot see what a script might be running. Install first, or the claim goes unmade. And a file no scanner reads hides its imports whatever the config says: a `.vue` or `.svelte` single-file component, a template, anything but the JavaScript and TypeScript extensions.

**It is in the wrong section.** Where an entry sits is a claim about when it is needed, and getting it wrong breaks something either way:

```
package.json
  9:5   `only-in-tests` is in dependencies: only test, spec, story, bench, and config files use it, so it ships for nothing
  15:5  `zod` is in devDependencies: production code imports it, so an install without dev dependencies is missing it
```

The second one is the expensive one — `npm install --omit=dev` and the package is gone at runtime.

Neither claim is made about a `"private": true` package. Nobody installs it and nobody downloads its weight, so both halves of the section question are about an install that never happens. A dependency nothing uses is still worth saying, and still said.

Only an import that survives compilation counts here. `import type { Recipe } from 'shapes'` is erased before anything runs, so a devDependency the shipping code reads for types alone is already in the right section — moving it would ship a package the output never loads. The import still counts as the package being used, so nothing calls it dead. A type query is read the same way: `import('shapes').Recipe`, written where a type goes, is a dynamic import's words and `import type`'s meaning. Where a value goes, the same words load the module, and that one is needed at run time.

A bundled package carries its dependencies inside its output file, and then no install can be missing them. norefs reads the `external` list out of the build files at the package root — `external: ['esbuild', 'drizzle-orm']` is what the bundler is told to leave for the run time — and holds back the misplaced claim for every name the list omits. Several outputs are added up: a name any one bundle keeps external is a name the install still needs. A list built out of something the reader cannot follow, a call or an object, makes the answer unknown, and the check reports as it did before.

A peer dependency listed in `devDependencies` as well is where it belongs, and it is not dead either. That pairing is how a package builds and tests against its own peer — typeorm lists seven database drivers in both sections — and whoever installs the package brings them. The listing is the reason the line is there, so no import has to be.

One package shape is read differently: a module the environment provides. `import { app } from 'electron'` reads a `declare module 'electron'` block in electron's own types. That is what an API the host supplies looks like — the binary that loads the code brings the module with it, and no file in `node_modules` is what the import lands on at run time. Which section such a package belongs in is decided by whatever packages the app; electron-builder wants `electron` in `devDependencies` and reads it from there to pick the runtime it bundles. So an install without dev dependencies is not what would be missing it, and norefs does not make a claim it cannot ground.

Nor does it ask the other direction. `declare module` is also how a library older than ES modules ships its types — `@xterm/headless`, `node-pty` and `toml` all write it, and all three are ordinary packages a product installs and ships. The signal is strong enough to hold a claim back and far too weak to make one, so it is read in the direction that reports nothing.

A config file is a build's file, not the product's, so what it imports is never production usage. That holds for a second target's config: `vite.config.server.ts` beside `vite.config.ts` is read as a config too. Only at the package root, though — the extra segment is also how ordinary code gets named, and `src/form.config.schema.ts` is a schema, not a build.

Neither is a file no chain of imports from an entry point reaches. A name tells you a test — `card.test.ts` — and reachability tells you the helper directory beside it: valibot's `src/vitest/` wraps the test framework, is imported by tests alone, and is named after the tool rather than after the harness. The report used to read that as production code and advise shipping a test framework in `dependencies`. Where the run resolves no entry point there is no reachability to read, so the question goes unanswered rather than answered wrongly, and the name is all that decides.

Two specifier shapes are never packages. A scheme names the host rather than a registry — `node:fs`, `bun:sqlite`, `cloudflare:workers` — and npm resolves none of them, so asking for a manifest entry would ask for a line nobody can write. And a bare specifier that lands on project code is read as the package it names when a manifest lists it — a workspace dependency linked by path (`"seedbox": "workspace:../seedbox/dist"`) resolves straight back into the repo — while one no manifest lists is a `baseUrl` import and never reported unlisted.

**Fixing them.** `--fix-unsafe` removes an unused entry and moves a misplaced one, editing `package.json` as text so the key order and the indentation survive. It needs `--fix-unsafe` rather than `--fix` for an honest reason: the type checker does not read a dependency list, so the probe that guards every other fix has nothing to say here. `--verify-command` is the one that can judge these, and when it fails the manifest edits are held back on their own — the source fixes it did verify still land.

Use the [`ignoreDependencies`](configuration.md) config key for a dependency norefs still cannot see: a binary invoked from somewhere other than a script, a package a runtime injects by a name nothing writes down.

---

[← All docs](README.md)
