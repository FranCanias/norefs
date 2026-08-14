# Changelog

norefs follows [semver](https://semver.org). Before 1.0.0, minor versions
(0.x.0) may change output formats, flag semantics, and verdicts; patch
versions (0.x.y) fix bugs without changing what a script or a baseline sees.

## 0.7.0 — 2026-08-14

A release about being wrong. Every change here answers a false positive somebody
hit on a real repository — an Electron app with a headless server build — and
each one had the same shape: norefs knew a rule and applied it one step short of
where the rule reaches.

A filter that names a property one level in was read only at the top level. A
config file was recognized as `vite.config.ts` and not as `vite.config.server.ts`,
so a second target's entry points looked dead and its bundler imports looked like
something the product loads at run time. A package could be used by a config or
loaded by a host, and only imports and scripts counted. And a module the
environment hands you was told to move sections, as if an install were what put
it there.

That repository shape is now part of the release probe, built and run through the
binary a user installs. On it, 0.6.0 reported `10 findings: 9 dead, 1 misplaced
dependency`, and eight of the ten were false. 0.7.0 reports the two that are
real.

The corpus was re-run too, each repo cloned fresh and analyzed by both versions
so the release is the only difference. On Microsoft's inshellisense, two dead
dependencies went away — `jest` and `ts-jest`, both in use, neither imported
anywhere. On hono the two reports are byte-identical: reading config paths more
loosely invented no entry point, which was the risk worth checking. See
[docs/corpus.md](docs/corpus.md).

### Fixed

- **A type-level read counts one level in.** `Extract<Event, { payload: { kind:
  'RENAME' } }>` matches on `kind`, and `kind` was reported dead — on the filter
  and on both payload types the filter has to tell apart. Only the names at the
  top level of a filter were credited; a nested literal was read by nobody.

  A literal written inside a member now descends with that member: it is matched
  against the type the property holds, which is the type its own names are doing
  work on. Arrays shed together, so `{ steps: { done: boolean }[] }` against
  `Step[]` reads `done` on `Step`. The credit stops at four levels down, and the
  members beside the named ones are reported exactly as before.

- **A second target's config is a config.** A build with two outputs writes the
  second one down the same way as the first: `vite.config.server.ts` beside
  `vite.config.ts`. norefs matched only the single-segment name, and the file
  that follows the convention one step further was read as ordinary product
  code. Two false positives came out of that, and neither was small.

  The entry points named in it went unread, so `server/main.ts` and everything
  only it reaches came back as dead files — the highest-confidence verdict there
  is. And the bundler it imports counted as a runtime dependency of the product,
  which reported every build tool in `devDependencies` as misplaced.

  One rule now answers both, shared by the entry-point reader and the
  harness-file check: `<tool>.config.<ext>` anywhere, and the segments a build
  adds for a second target at the package root, beside the manifest they belong
  to. Where the file sits is the whole difference, because the name is not:
  `src/form.config.schema.ts` is a schema, and reading it as a build file would
  take it and everything it imports out of the product.

- **A path in a config is read the way an import is written.** An alias target is
  written `'./src/Routes.web'` or `'./src/api'`, without an extension or as the
  directory whose `index` is the module. Only an exact match landed, so those
  entry points went unfound. Extensions and `index` files are now tried for any
  string shaped like a path.

  A bare word is left alone. `environment: 'jsdom'` names a package, and hunting
  for a `jsdom.ts` beside the config would silence every finding in a file that
  happens to share a name with a tool.

  A script's argument is read one step tighter than a config's: extensions yes,
  `index` files no. A command takes a directory for a different reason — `eslint
  src` and `linter src/lib` name a tree to walk — and reading that as
  `src/lib/index.ts` would publish every export in the file.

- **What a config imports is not an entry point.** This one arrived while fixing
  the one above: a config that imports `'./helpers'` would have made that file an
  entry point, and an entry point's exports are public API — so one line in a
  Vitest config would have hidden every unused export in the file it points at.
  The import is already an edge in the graph, and the config is already a root of
  it, so the file was never at risk of being called dead.

  That holds while the program holds the config. `eslint.config.js` is not a file
  TypeScript compiles, so it is a root of nothing, and the module it imports has
  no importer at all — what such a config names is read as an entry point, which
  is what keeps `tools/rules.ts` off the dead list.

### Added

- **Two more ways a dependency earns its place.** An import and a script were the
  only usage norefs could see, so a package used by neither was reported dead —
  and packages used by neither are ordinary.

  A **tool config** counts now. An ESLint config imports its plugins from a file
  the TypeScript program never holds, so those plugins had no import anywhere;
  `environment: 'jsdom'` loads jsdom while naming no file at all. A listed
  package written as a string in a `*.config.*` is that package being used.

  A **host** counts too. `@vitest/coverage-v8` runs behind `--coverage`,
  `bufferutil` behind `ws`: nothing imports them, no script names them, and all
  of them are in use. Each is a peer dependency of a package this project does
  use, which is how the ecosystem writes down "that one loads me". The evidence
  is the same evidence the binaries came from — an installed package's own
  `package.json` — and the host has to be in use itself for it to count, so a
  peer of a package nothing touches is still reported.

  Neither rule needs a plugin per tool, and neither guesses. `bufferutil` maps to
  `ws` because `ws`'s own manifest says so.

  Both new uses answer the section question too, not just the dead one. A
  `dependencies` entry that only a test config names — `environment: 'dom-shim'`
  — is not dead, and it is not something the product loads either: it comes back
  `misplaced`, where before it fell between the two checks and was reported by
  nothing. The evidence for a dead entry names all four checks now: `no source
  file imports it, no script runs it, and no config or host names it`.

- **A module the environment provides is left out of the section question.**
  `import { app } from 'electron'` reads a `declare module 'electron'` block in
  electron's own types. That is the shape of an API the host supplies: the binary
  that loads the code brings the module with it, and no file in `node_modules` is
  what the import lands on at run time.

  Which section such a package belongs in is decided by whatever packages the
  app — electron-builder wants `electron` in `devDependencies`, and reads it from
  there to pick the runtime it bundles. An install without dev dependencies is
  not what would be missing it, so `misplaced` has nothing to stand on and norefs
  no longer says it.

  The other direction is not asked either, and the corpus is why. `declare
  module` is also how a library older than ES modules ships its types: on
  inshellisense, `@xterm/headless`, `node-pty` and `toml` all write it, and all
  three are ordinary packages that belong exactly where they sit. A signal that
  cannot tell them from `electron` can hold a claim back, and cannot make one.

### Changed

- **`--help` lists every config key.** `boundaries` and `production` were missing
  from it. `boundaries` is the only setting with no flag of its own, which made
  the help text the only place a reader could learn it exists — and it did not
  say. A reader who went looking concluded the feature had never shipped. It
  shipped in 0.6.0; now the help says so.

## 0.6.0 — 2026-08-14

A property can be read by the type system and never touched at runtime. Every
such property was reported `dead`, with the evidence "no references anywhere" —
and there were references. They were type references. This release counts them.

It also stops making you keep two lists your build already keeps — the entry
points and, in a monorepo, the packages — opens the stranded-handler check to
boundaries beyond Electron, starts answering two questions about `package.json`
it used to decline, adds a stricter question to ask of a repository, and fixes a
`dead file` that a side-effect import should always have prevented.

### Fixed

- **A name written in a type-level match counts as a read.** Three positions,
  one rule: the name is doing work, on both sides of the match.

  ```ts
  type OnlyDaily = Extract<Schedule, { type: 'DAILY' }>;      // `type` picks the branch
  function hasId(r: Recipe): r is Recipe & { id: string };    // `id` is what narrows
  pickFirst<Row>(rows);   // Row fits `T extends { key: string }` by having `key`
  ```

  Each of the three reported the named property `dead` on the filter *and* on
  the type the filter matches. Both halves were false, and the second half was
  the dangerous one: delete `type` from `Schedule`'s branches and the filter
  matches nothing; delete `key` from `Row` and the file stops compiling.

  The credit now goes both ways. A property named in a written type literal is
  kept on the literal and on the declarations behind the type it is matched
  against — a conditional type's `extends` clause, an alias whose body is a
  conditional (`Extract` and `Exclude` resolve through their own definitions, so
  any conditional alias works, yours included), a predicate's asserted type, and
  a written type argument against a literal constraint.

  Only the names actually written are credited. The members beside them are
  reported exactly as before: `Weekly.day` is still dead next to a live
  `Weekly.type`, and `Row.deadRank` is still dead next to a constrained
  `Row.key`.

  An inferred type argument — `pickFirst(rows)` — never needed a rule. The value
  goes into the call whole, and the escape check has always stopped tracking
  members there. This is written down because it was checked, not assumed.

- **A write inside a dead file is no longer cited as proof.** A member written
  only from a file the same report calls dead was reported `write-only`, with
  evidence naming that file — `a typed write at fixtures.ts:1 feeds this member
  — proven, never read`. The report had already said that code was going away,
  so the proof pointed at a corpse. Those writes no longer count, and the member
  gets the `dead` verdict it earned. `--production` made this easy to see,
  because it creates dead files where a normal run had none, but the same
  evidence could always be produced.

- **A side-effect import keeps its file alive.** `import './routes'` marked its
  target used only when that target was a *module*. A file with no import and no
  export of its own is a script, and the type system links a specifier only to a
  module — so the file looked unreached and was reported `dead file`, the
  highest-confidence verdict there is. That shape is not exotic: it is how a
  route table, a polyfill, and a registration side effect are written, and `tsc`
  compiles it without a word.

  The two pipelines disagreed about it, which is how it surfaced: `norefs --only
  files` reported nothing while a full `norefs` run called the same file dead.
  The fast path had always resolved specifiers with the compiler's own resolver,
  which holds no opinion about modules. The full run now asks it for the
  specifiers the type system dropped, and the two agree.

  The README already promised this behaviour under "Remaining blind spots". It
  is now true.

### Added

- **The entry points come from the build, not from a list you keep.** Until now
  norefs knew three: `--entry`, `package.json`'s `main`/`bin`/`exports`, and the
  `index`/`main`/`cli` convention. Everything else was yours to remember — the
  Vite input, the Vitest setup file, the HTML the bundler starts from — and a
  hand-kept copy of the build's own list is the copy that goes stale when the
  build changes. On a small Vite-shaped app, 0.5.0 reported four dead files and
  three of them were alive.

  Your build already wrote the list down. norefs now reads it:

  | Declared in | What is read |
  | --- | --- |
  | `package.json` scripts | any argument naming a project file — `tsx src/server.ts`, `--config=playwright.config.ts` |
  | `*.html` | every `<script src>`; a leading `/` means the package root, as bundlers read it |
  | `*.config.*` | every quoted path that lands on a project file |

  No config is executed and no tool is special-cased. A config is read as text,
  and a path string that names a file this project holds is taken at its word.
  One rule covers Vite's `input`, Vitest's `setupFiles`, Playwright's
  `globalSetup` and the same thing in a tool nobody has written a plugin for.
  A string that lands on nothing is dropped, which is what makes the loose
  reading safe: the failure mode is a missed entry point, never an invented one.
  `node_modules` and build output — `dist`, `build`, `out`, `coverage` — are
  never walked, so a stale config in `dist/` cannot silence a finding.

- **`norefs entries` prints every entry point and what named it.**

  ```
  src/boot.tsx    —  <script src> in index.html
  src/main.ts     —  index/main/cli beside a tsconfig
  src/preload.ts  —  a path named in vite.config.ts
  src/server.ts   —  package.json scripts.serve
  ```

  Discovery that cannot be inspected is discovery nobody should trust. An entry
  point makes a file used and its exports public API — a wrong one hides real
  findings and leaves no trace of having done it. This is the trace. It reads
  the text alone, so the audit needs no type checker and costs about a tenth of
  a second.

- **`--production` analyzes the shipping code path alone.** Every finding is
  relative to a question, and the default one — "does anything here use it?" —
  counts the tests. That is why `test-only` exists. `--production` asks the
  stricter one: what is left standing if the tests were not there at all?

  Test, spec, stories, bench and config files, and everything under a test
  directory, are treated as absent. Three things follow, and they are the whole
  definition: they stop keeping code reachable, so a file only a test imports
  becomes a `dead file`; their references stop counting, so `test-only` becomes
  plain `dead`; and they report nothing of their own, because they are not part
  of the question. `devDependencies` and the misplaced-dependency check fall
  outside it too — one exists to build and test, the other needs both halves of
  the code to decide anything.

  The evidence says which question was asked. A `dependencies` entry the tests
  import and the shipping path does not is dead here, and the line reads `no
  file on the shipping path imports it and no script runs it` — the run skipped
  half the source tree and does not claim otherwise.

  It never combines with `--fix`, and that is a refusal rather than an
  oversight: a production finding is dead to the shipping path and may be alive
  in the tests the run ignored. Deleting it breaks them. Exit code 2, for the
  same reason `test-only` findings have never been fixable.

  Available as `--production`, as `"production": true` in the config file, and
  `--no-production` says no to a project that said yes.

- **A script says what a package is for, and norefs reads it.** `"build": "tsc
  -p tsconfig.json"` is TypeScript being used, and no import will ever say so.
  Because of that, devDependencies were counted as listed and never reportable —
  norefs sidestepped the question instead of answering it, and could not tell
  you a devDependency was unused at all.

  Now each script's tokens are matched against the packages the manifest lists:
  by name, and by the binaries each installed package declares in its own `bin`
  field. Nothing guesses which tool owns which command — `tsc` maps to
  `typescript` because TypeScript's manifest says so, and `biome` maps to
  `@biomejs/biome` for the same reason, not because it is the tail of the scoped
  name. Unused devDependencies are reported, and a `dependencies` entry that
  only a script runs stops being a false positive.

  The evidence line grew a clause to match: `no source file imports it and no
  script runs it`. And a package that is not installed has no binaries to read,
  so norefs will not call a devDependency unused — the claim waits for the
  evidence rather than guessing.

- **A dependency in the wrong section is a finding.** Where an entry sits is a
  claim about when it is needed, and both directions break something:

  ```
  package.json
    9:5   `only-in-tests` is in dependencies: only test, spec, story, bench, and
          config files import it, so it ships for nothing
    15:5  `vitest` is in devDependencies: production code imports it, so an
          install without dev dependencies is missing it
  ```

  The second is the expensive one: `npm install --omit=dev` and it is gone at
  run time.

  Only an import that survives compilation is asked the question. `import type
  { Recipe } from 'shapes'` is erased, so a devDependency the shipping code
  reads for types alone is already where it belongs — moving it would ship a
  package the build output never loads. The erased import still counts as the
  package being used, so nothing calls it dead either.

  New kind `misplaced`, reportable on its own with `--only misplaced` — and like
  the other three import-graph kinds, it needs no type checker, so asking for it
  alone stays in the fast path.

- **`--fix-unsafe` edits package.json.** An unused entry is removed, a misplaced
  one is moved, as text — the key order, the indentation, and every line the
  edit does not name survive, because a manifest is a file people read and write
  by hand.

  It needs `--fix-unsafe` rather than `--fix` for an honest reason. The rule
  everywhere else is that nothing reaches disk unless it verified, and the
  probe that does the verifying is a type check — which does not read a
  dependency list. So these edits sit outside the campaign, `--verify-command`
  is the probe that can actually judge them, and a red result holds the manifest
  edits back *on their own*: the source fixes that did verify still land. When
  no command is given, the `Verified:` line says what the type check could not
  see rather than implying cover it never had.

  An entry that does not sit on a line of its own is refused and named. These
  edits move whole lines, and saying "not found" about an entry that is plainly
  there would be a false reason.

- **A workspace names its own packages.** A monorepo meant repeating `--project`
  once per package, which is a copy of a list the package manager already has —
  and the copy is what goes stale when someone adds a package. With no `-p` and
  no `project` key, norefs now reads `pnpm-workspace.yaml` or the `workspaces`
  list in `package.json`, and analyzes every declared package that has a
  `tsconfig.json`:

  ```
  $ norefs
  2 workspace package(s) from pnpm-workspace.yaml; skipped tools/jsonly — no tsconfig.json
  ```

  Negated globs are honoured. A declared package with no tsconfig is named
  rather than dropped quietly: nothing analyzes it, and a run that silently
  covers less than the workspace is a run whose findings mean less than they
  look like they mean. An explicit `-p` is the list you meant, so it turns
  discovery off.

  The reader takes no YAML dependency — `packages:` holds a list of globs in one
  of two documented forms, and one key is what gets read. As with the entry
  points, nothing is executed and a glob that matches no package directory is
  dropped, so the failure mode is a package nobody analyzed rather than a
  project nobody has.

- **`boundaries` pairs senders with handlers across any boundary you name.**
  The stranded-handler check is the most distinctive thing norefs does, and it
  only ever fired for one shape: a callee your project's own `.d.ts` declares.
  That is the Electron preload bridge, and it stays automatic. Everything else
  — an HTTP route, a socket bus, a job queue — belongs to a library, and no
  shape in the source says which library pairs `fetch` with `app.get` rather
  than running the handler itself. Guessing there would invent findings against
  live code, so norefs asks instead:

  ```json
  "boundaries": [
    { "send": "fetch", "handle": ["app.get", "app.post"] },
    { "send": "socket.emit", "handle": "socket.on" }
  ]
  ```

  ```
  src/client.ts
    12:9  dead property `saveLegacy` — deleting it strands the far side of
          `'/api/recipes/legacy'` at src/routes.ts:5
  src/routes.ts
    5:10  stranded handler for `'/api/recipes/legacy'`: its only sender is
          `saveLegacy` at src/client.ts:12, which this report says to delete
  ```

  Each entry pairs only with itself, both sides are required — a boundary with
  one side pairs nothing, and a config that looks like it works is worse than
  none — and a name matches the whole callee or its tail, so `app.get` covers
  `this.app.get` without covering `getApp`. Everything the check already
  guaranteed still holds: one surviving sender and nothing is stranded.

  Routes match by shape, so the holes the two sides fill differently line up:
  ``fetch(`/recipes/${id}/audit`)`` pairs with `app.get('/recipes/:id/audit')`.
  Matching the static head alone would have been simpler and wrong — it folds
  `/recipes` and `/recipes/:id` into one channel, and the live sender of the
  list route then hides the stranded handler of the item route. That is the
  most common pair in any REST API. The report never shows the normalized
  form: a reader goes looking for the channel, so the channel it prints is the
  one they wrote.

### Changed

- **A baseline written before this release no longer matches its dependency
  entries.** A dependency finding now carries the manifest section it was found
  in, so `--fix-unsafe` knows where the entry it moves is written. That section
  is part of the key a baseline matches on, so an entry recorded as `""` and a
  finding reported as `"dependencies"` are two different things to it: every
  baselined dead dependency comes back as new *and* gets reported stale in the
  same run — `--ratchet` drops it. Run `norefs --baseline` once to refresh the
  file. Nothing else about a baseline changed, and no other kind is affected.
- `--entry` is still there and still merges with the config file. It is now for
  what nothing declares in writing — a file loaded by a name the code computes
  at run time. Check `norefs entries` before reaching for it.
- Both pipelines answered "what is an entry point?" with their own copy of the
  same code, and only one copy was ever extended. They now share one.
- A tsconfig that does not exist now exits 2 with `error: no tsconfig at …`. It
  used to arrive as a raw stack trace from inside TypeScript, which the flag
  reference never described and no exit code matched.
- The filesystem the readers share moved out of the entry-point module, and the
  two walks stopped sharing a skip list they never agreed on. Hunting tool
  configs skips build output; hunting workspace packages must not, because a
  package legitimately called `build` is still a package. Its own test caught
  that one.

## 0.5.0 — 2026-08-14

0.4.0 gave the fixer a rule: a fix finishes the finding it acts on, or says
why it can't. Then it shipped a fixer that crashed on the example in these
release notes, a new verdict that called live code stranded, and a
documentation page that was in the repository and not in the package. The
rule was right. Nothing had checked whether the code kept it. This release
fixes all three and adds the check that was missing: **a claim about the
release is tested against the artifact, not against the repository.**

### Fixed

- **`--fix-unsafe` no longer crashes on a comment.** ts-morph removes an
  object literal property without the trivia behind it, so
  ``canvas, // light: #F9F9FA`` left the comment where a property belongs.
  The next removal in that literal was a syntax error the editor threw on,
  and the removals that had gone through left their comments glued to a line
  they never described. The comment beside a deleted property now goes with
  it, on the same rule as the comment above it: same line, after any comma,
  with nothing but the line break behind it. A comment with code after it on
  the line introduces that code and stays. Object literal properties were the
  only shape affected — statements, class members, interface members, and
  enum members already took their trailing comment with them.
- **A fix the editor refuses is held back, not fatal.** A fix that fails the
  type check has always been rolled back, named, and skipped while the rest
  of the run went on. A fix that threw inside the fixer took the whole
  campaign down with it, every other fix included. It now gets the same
  answer: ``Held back `curve` (src/hook.ts:12): the edit could not be applied
  — …``, the campaign restores every file the abandoned fix could have
  reached, and the loop runs again without it. A fix that cannot be applied
  is one finding's problem. It was never the run's.
- **A sender counts as dying only when its own declaration goes.** The
  `stranded` verdict resolved a channel's senders to the enclosing *class*
  and treated any reported verdict as a death sentence. Both are now fixed,
  and they were two false findings out of five on a real codebase:
  - *The method, not the class around it.* A class with five senders and
    three fates is not one fate. The owner of a sender is the innermost
    reported declaration around it, so a dead method strands its own handler
    and its live siblings strand nothing.
  - *Reported is not dying.* An `over-exported` finding's fix removes an
    `export` keyword and deletes nothing — every sender inside it keeps
    sending. It no longer counts toward stranding, and it no longer collects
    a "deleting it strands …" note about a deletion that is not going to
    happen. The `--fix` summary said that in prose too, about a class that
    was still there; that line is gone with the claim behind it.

  The evidence says what it now means: ``its only sender is `oldRecipe` at
  src/service.ts:10, which this report says to delete``, in place of "is
  reported unused".

### Added

- **The config file holds the settings, not just the inputs.** `scope`,
  `reporter`, `anon` and `explain` join `project`, `entry`, `ignore`, `only`
  and `ignoreDependencies` in `norefs.config.json`, so a team that always
  wants `--reporter github --explain` on `src` says it once instead of in
  every script:

  ```json
  { "scope": "src", "reporter": "github", "explain": true }
  ```

  The line the file draws is settings against actions. A setting shapes the
  analysis and the report and is true of the project every run. An action —
  `--fix`, `--fix-unsafe`, `--baseline`, `--ratchet`, `--export`, `--dry-run`,
  `--watch` — writes something or keeps running, and that is a decision per
  run. An action key in the config file is a usage error, not a silent
  surprise. `--no-verify`, `--verify-command` and `--allow-dirty` shape what
  `--fix` does rather than what a run finds, so they stay with the action.

  A flag passed on the run still wins, and `--reporter`, `--anon` and
  `--explain` no longer carry a parser default — an unset flag has to stay
  distinguishable from one passed at its default, or the flag would silently
  outrank the config every run. That is also what makes `--no-anon` and
  `--no-explain` work: a run can say no to a project that said yes. When the
  reporter name is wrong, the error names where it came from — the flag or
  the file.
- **`// norefs-ignore-block` suppresses a declaration and everything inside
  it.** Five flagged members of one wire format were five decisions and five
  comments, when they are one decision. The block mark is one comment:

  ```ts
  // norefs-ignore-block: the shape the desktop app sends, kept in sync by hand
  export interface RecipePayload { … }
  ```

  It reaches the declaration it sits on, its members, and the nested type
  literals under them — an interface, a type alias, a class, a namespace, an
  enum, a producer whose returned object is flagged, an import. It counts on
  the declaration's own line or anywhere in the comments attached above it, so
  it reads the same before or after a doc comment. The two older marks are
  unchanged and still mean what they meant: `norefs-ignore` suppresses one
  finding and keeps looking inside the declaration, which is the right answer
  for an export whose members you still want reported, and the wrong one for
  an interface you have already decided about. `norefs-ignore-file` still
  covers a whole file. The syntax-only pipeline (`--only files,dependencies,
  unlisted`) reads the block mark too: nothing nests inside a file, a
  dependency, or an import, so it reaches one line there and both pipelines
  agree on every line.
- **A release probe.** `tests/exhibit-repo` is a small TypeScript project
  holding the exhibits five reviews have raised — the colour chain, the IPC
  bridge, the imperative handle — and one test builds the binary and runs it
  there, the way a user would. It asserts the report, that
  `--fix-unsafe --dry-run` completes, that its diff carries each comment out
  with the property it described, and that the fixture tree is byte-identical
  afterwards. The reviews are a regression corpus now, not a reading list.
- **A packaging test.** Every relative link in the README, the changelog, and
  the pages under `docs/` must resolve *and* be in what `npm pack` would
  publish. `docs/flags.md` was linked from 0.4.0's changelog and stripped from
  the tarball by the `files` allowlist, so the page every installed copy
  pointed at existed on no machine that installed the tool. `docs` is in
  `files` now, and the test fails the build if a link ever outruns the
  package again.

### Unchanged, and checked

- **Exit codes.** The 0.4.0 review reported that a findings-laden run exited 0
  in 0.3.0 and 1 in 0.4.0. Both versions were rebuilt and run against the same
  project — plain, `--explain`, `--reporter json`, `--fix --dry-run`,
  `--fix-unsafe --dry-run`, with and without a baseline — and every pair
  matched. No exit code changed. They are 1 for findings, 0 for a clean run or
  a written baseline, 2 for a usage error; they are documented in
  [docs/flags.md](docs/flags.md), which now ships, and a test pins all three so
  the next change cannot be a silent one.

## 0.4.0 — 2026-08-14

0.3.0 taught the evidence layer to say "proven", "discarded", "unverified".
The action layer had not learned the same vocabulary: `--fix-unsafe` acted on
a proven write-only member by deleting the declaration and leaving the write
that proved it running — the half that destroys information, not the half
that removes code. This release gives the fixer the rule the evidence already
follows: **a fix finishes the finding it acts on, or says why it can't.**

### Fixed

- **`--fix-unsafe` retires the value chain, not the paperwork.** A proven
  write-only member is now removed together with the writes the evidence
  cites, with any local whose last reader those writes were — the comment
  above it included — and with the dependency entries that named that local.
  `useMemo(() => ({ track }), [track])` needs all three: stop at the write and
  the dependency array still names `track`, which keeps the computation alive
  for norefs and for `noUnusedLocals` alike. A dependency array does not read
  a value, it decides when to recompute one, so an entry left behind by a
  removed write is stale, not a reader. Deleting the declaration alone left the producer
  computing into a literal no named type describes, which is the *anonymous
  member* class norefs hides by default: the fix used to convert detectable
  dead code into undetectable dead code and call it verified. When one of the
  proven writes cannot be removed on its own — a spread carries members
  beyond this one — the whole finding is kept and the write is named:
  ``Kept `extra` (src/payload.ts:2): the write at src/payload.ts:9 is why
  this isn't safe``. Half a fix is no longer one of the options.
- **The flow proof reads two positions it used to miss.** 0.3.0 promised
  "three uncalled siblings written the same way now get the same verdict,
  whatever their names collide with elsewhere", and delivered it only where
  the colliding literal flowed through a variable. Two more positions now:
  - *A declared return type ends the walk.* A hook whose
    `useMemo(() => ({ set, clear }))` is returned from a function annotated
    with the flagged type reads "a typed write at src/x.ts:9 feeds this
    member — proven, never read". The annotation is the whole answer: no
    caller can read the result as anything else, so no call site needs
    following.
  - *An argument position the callee types from the value itself.* In
    `useImperativeHandle(ref, () => ({ … }))` the checker infers that
    position from the literal, so asking it for a type is circular. What the
    position does prove is that the callee holds this literal's own shape and
    nothing wider — and when the checker would reject that shape where the
    member's owner is expected, the write cannot reach the member. The site
    is discarded as feeding another type, and the sibling stops being
    protected by a collision.

  The claim, scoped this time: a write is *proven* only when a destination
  type the analysis can name declares the member, and *discarded* only when a
  known type, a read of the literal's own property, an exhausted set of
  concrete uses, or an impossible shape rules it out. A generic argument
  position whose type parameter is inferred from some *other* argument is
  still not resolved to a name — where the shape could be the owner after
  all, the site stays a labeled "unverified name match".

### Added

- **A stranded handler is a finding, not just a note.** 0.3.0 reported that
  deleting a bridge wrapper would strand its far side, then let that far side
  become permanently invisible. The handler now gets a finding of its own —
  its file, its line, its evidence — while it can still be seen: "stranded
  handler for `'recipeBox:loadRecipe'`: every sender is reported unused
  — `loadRecipe` at src/recipeBox.ts:2". It filters as `stranded`, rides
  every reporter, and folds away when a dead file, a dead declaration, or a
  suppression comment already tells the story. It answers `--scope` too: a
  handler outside the path a run was asked about is not that run's finding,
  and the note on the in-scope wrapper still names its file and line.
- **[docs/flags.md](docs/flags.md)** — one page on what each flag and each
  combination does to a working tree: the order a fixing run happens in, what
  a fix may leave behind, the combinations worth knowing, the exit codes, and
  which stream every line goes to.

### Changed

- **A strand note needs every sender to be dying.** The note used to appear
  whenever one reported wrapper shared a channel string with a registration,
  even while another live wrapper still sent that channel — a false claim of
  stranding. Now every sender of the channel must sit inside a reported
  declaration, or nothing is stranded and nothing is said.
- **Strand notes ride any verdict, not only `dead`.** A wrapper the analysis
  could not call dead is still a wrapper a human may delete, and the far side
  is the same far side.
- **The "Verified" line names its second blind spot.** It already said a type
  check cannot see runtime-only reads of a deleted member. Now that a fix also
  deletes the writes behind one, it says that too: a type check does not weigh
  what those writes were doing. Same rule as ever — the claim may not outrun
  the probe.

## 0.3.0 — 2026-08-13

0.2.0 named write sites but matched them by name alone, project-wide. A
member could be protected from deletion because an unrelated function
elsewhere shared its name, and the reader was sent to that stranger with
confident coordinates. This release adds the missing rule: every name match
is validated against the type its write feeds, at the point where the match
becomes a claim.

### Fixed

- **A name match must survive the type its write feeds.** Three outcomes,
  each labeled as what it is:
  - *Known and same* — the write's value provably flows into a use whose
    type declares this very member (followed through parentheses, a factory
    like `useMemo(() => ({ … }))`, and the variable holding the result, with
    the hop verified by symbol identity). The evidence now says "a typed
    write at src/x.ts:12 feeds this member — proven, never read".
  - *Known and different* — the write's contextual type was known and does
    not declare the member, or its own literal property is read as itself,
    or every use of the value lands on concrete types unrelated to the
    member. The site is discarded; it is no evidence against `dead`, and
    the dead evidence says so: "every write of the name feeds another type
    (src/x.ts:12)".
  - *Genuinely untypeable* — the value escapes into `any`/`unknown` or a
    place the checker cannot type. The site is kept and labeled "an
    unverified name match", so the reader knows which kind of evidence they
    are holding.
  Verdicts no longer depend on how popular an identifier is: three uncalled
  siblings written the same way now get the same verdict, whatever their
  names collide with elsewhere. Only true reads — a property access, a
  destructuring binding, an element access — count as "read as itself";
  declarations and other writes of the name do not. The value flow follows
  named factories to their call sites and across `const b = a` aliases, so
  equivalent shapes converge. A member's own declaration site is never
  evidence about the member.
- **Write-site lists are spelled out and pluralized honestly.** Up to three
  sites are listed in full; past that, "and N more sites". No "(s)" on a
  count the code just computed, and no relevant site hidden behind an
  arbitrary first match.

### Added

- **Stranded far sides are reported.** A dead wrapper around a
  project-declared bridge carries the channel string it passes. When the
  same string reappears in a registration in another file — the
  `ipcMain.handle` call in an entry file no reference-based analysis will
  ever flag — the finding says so: "deleting it strands the far side of
  `'recipeBox:loadRecipe'` at electron/main.ts:164". The claim stays
  honest by shape: a channel is only the first argument of a bridge call,
  never a payload; a far side must be the same string first in a call that
  also takes a handler; and a bridge call never counts as a far side — a
  second dead wrapper is not anyone's handler. The note rides in every
  reporter, survives the empty-type fold when the whole wrapper dies, and
  prints again in the `--fix` summary for the fixes that actually applied.
- **`--fix` points at the comments it had to keep.** A leading comment on a
  statement a fix trimmed without removing (a barrel that lost one
  specifier), or a comment one blank line above a deletion, may now be
  half false — and no heuristic fixes prose. The fix summary lists each
  location to reread.

### Changed

- **Contract and shadowed merge across a boundary.** When twin detection
  links two declarations and one of them crosses a serialization boundary,
  the near side is a `contract` too — "its same-named twin (electron.ts:1)
  is the far side of a serialization boundary" — instead of a competing
  `shadowed` verdict. The far side names its twin in return. One conceptual
  fact, one story, told from both ends.

## 0.2.0 — 2026-08-13

The dead verdict now earns its evidence chain. 0.1.1 could call a member
"dead — no untracked write of the name" while a shorthand property in an
inference-typed object literal wrote it three files away. That axiom is
fixed, and everything downstream of it is more honest.

### Fixed

- **The write scan sees writes it used to miss.** Shorthand properties,
  spreads, and string-literal computed keys in object literals now count as
  writes, including literals typed only by inference (`useMemo(() => ({ … }))`
  feeding a provider). A contextual type that resolves to the literal's own
  inferred type is circular evidence and no longer counts as attribution.
  Any such write downgrades `dead` to `write-only` and disqualifies the
  member from `--fix`.
- **`--anon` keeps its promise.** Members of an inline type literal nested
  inside another type's member (`{ target: { value: T } }`) are anonymous
  and hidden by default, even when a named alias sits above them.
- **`--fix` removes the comments a deletion orphans.** Freestanding comment
  lines directly above a removed declaration or member go with it. A comment
  set apart by a blank line stays.

### Changed

- **`write-only` findings name their write sites.** The evidence now reads
  "assigned at src/x.ts:12, where the analysis lost the type it feeds"
  instead of "something assigns it somewhere", and `--explain` shows it.
- **Contract detection covers more than `JSON.*`.** Two new boundary edges:
  calls on values a project `.d.ts` declares (an IPC bridge, a preload
  global) mark both their argument types and their asserted result types as
  contracts; and any call whose result the types do not trace (`any`,
  `unknown`, or a promise of them) pinned to a named type by assertion or
  annotation gets the `JSON.parse` treatment — `res.json() as Config`
  included.
- **Twin detection matches drifted copies.** Two types with the same name
  and at least half the smaller shape in common are twins even when their
  shapes differ; their unread members get `shadowed` with the duplication
  as evidence.
- **The `--fix` "Verified" line says what it can see.** When member
  deletions were verified by the type check alone, the line says a type
  check cannot see runtime-only reads and points to `--verify-command`.

## 0.1.1 — 2026-08-13

This release changed the output format and `--fix` semantics; by the rules
above it should have been 0.2.0. Recorded here for the record.

### Added

- A verdict per finding — `dead`, `over-exported`, `write-only`, `contract`,
  `shadowed`, `test-only` — instead of one flat "unused" label, with
  `--explain` for the evidence chains.
- Structural twin detection: an unread member whose duplicate type is read
  elsewhere reports the duplication.
- Contract detection: types crossing `JSON.parse`/`JSON.stringify`/
  `structuredClone`/`postMessage` soften to `contract`.
- `test-only`: exports and members only their own tests keep alive.
- Verified fixing: `--fix` type-checks in memory, bisects and holds back
  fixes that break the build; `--verify-command` chains the test suite.
- A content-addressed baseline and `--ratchet`.
- `--allow-dirty` (by default `--fix` refuses a dirty tree), `--export`,
  `--watch`, `--scope`.
- Dead-slice detection for non-exported functions; empty-type folding.

### Fixed

- Path-alias resolution no longer needs a suppression for `@/*` imports;
  Vite `?suffix` imports resolve.

## 0.1.0 — 2026-08-13

First npm release: unused files, exports, types, members, and dependencies
for TypeScript projects, with `--fix`, baselines, and github/sarif
reporters.
