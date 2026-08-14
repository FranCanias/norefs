# Dependencies

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

Use the [`ignoreDependencies`](configuration.md) config key for a dependency norefs still cannot see: a binary invoked from somewhere other than a script, a package a runtime injects by a name nothing writes down.
