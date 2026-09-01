# Changelog

norefs follows [semver](https://semver.org). Before 1.0.0, minor versions
(0.x.0) may change output formats, flag semantics, and verdicts; patch
versions (0.x.y) fix bugs without changing what a script or a baseline sees.

A user-visible change lands with its entry here, under **Unreleased**. A release
renames the section and dates it — the writing is already done.

## Unreleased

**A type query is erased, so it does not decide a manifest section.**
`import('undici').Dispatcher`, written where a type goes, is a dynamic
import's words and `import type`'s meaning: nothing is emitted, and an
install without dev dependencies is missing nothing. It was read as a runtime
import, so ofetch was told to ship `undici` in `dependencies` — weight for a
type that is gone before anything runs. Written where a value goes, the same
words still load the module, and that one is still needed at run time.

**A wildcard export pattern no longer decides what production code is.** A
`"./*"` subpath says every module in the package is reachable and names none
of them, so a `gulpfile.ts` beside the sources answers to it as readily as the
sources do. typeorm's build tools came back as things the install needs. A
pattern still keeps a file from being called dead — it just never puts one on
the shipping path, which is the claim about somebody's install.

**Public API is closed over the types it names.** The exemption stopped at
the declarations an entry file exports, and a consumer does not stop there.
ts-pattern's entry exports `match()`, whose return type is a `Match`
interface three files away; nothing imports that interface by name, and every
method on it is the API the package exists to provide. norefs reported all
six as dead, `--fix` deleted 119 lines of `src/types/Match.ts`, printed
`Verified: tsc reports no new errors after the fixes`, and left 439 errors in
a test suite the tsconfig excluded. An exported union is the same story one
step shorter: the alias is public, its arms are local interfaces, and a
consumer holds one of the arms. So the public surface now follows the types
written on it, and the types those name, until nothing new turns up. Only the
surface counts — a type named inside a function body is one no caller can
hold. Across nineteen public repositories this silences 79 member and emptied-type
findings, hono's aws-lambda event shapes and remeda's `debounce` result
among them.

**`--fix` stops deleting a member whose readers this run cannot hold.** An
import clause carries names, never members, so the scan of the code beside
the program proves nothing about a member either way — and the type check
that vouches for a fix never held those files. The finding still stands and
the fix now waits for `--fix-unsafe`, because `Verified` over a deletion no
probe could witness is the one green line this tool must not print.

**A member that carries a type rather than a value stays.** Two shapes, both
load-bearing and both invisible to a reference search. A shape named inside a
conditional type's `extends` clause is a pattern, and every name in it is
what the match reads: `Box extends { portions: Portions<unknown, infer C> }`
finds `C` through `Portions`' own members, one alias in from where the old
rule looked. And a member declared `never` is the whole of a nominal brand —
no value can be given to a `never`, so no plain object passes as the type by
accident, and an emptied brand is a `{}` that everything matches.

**A config that holds no files still reads the code beside it.** The outside
scan began with a guard: if no path the program holds exists on disk, there
is nothing beside it. A solution-style tsconfig — `files: []` and a list of
references — holds no paths at all, so the check was switched off in exactly
the case it was built for, and every package the sources import read as dead.
The walk now uses the run's own filesystem, which answers the question the
guard was asking, correctly and by construction: a project built in memory
finds only the files it holds.

**Six more ways a package is named without an import.** A tool configured by
its own key in `package.json` — `"lint-staged": { … }`, `"ava": { … }` — is
that tool in use, and the strings inside the block are read the way a config
file's are, command-line arguments split like a script's. The tsconfig
answers for three more: `types: [ … ]` names packages the compiler loads, and
`importHelpers` puts a `require('tslib')` in the emitted output. A
devDependency the peer list names too is not dead — typeorm lists twelve
packages in both sections, nine of them database drivers, and each was
reported. And ESLint's
short names now expand to shareable configs as well as plugins, so
`extends: "prettier"` finds `eslint-config-prettier`.

**`test-only` survives a test the tsconfig excluded.** The outside scan read
an excluded test's import as plain usage, so whether the reader heard about
an export depended on a config setting rather than on the code. A harness
file beside the program is a harness file, and the same run now says what it
says of a test inside it.

**A run pointed at one package reads the rest of the workspace.** A tsconfig
names one package and the repository is the project, so where a tsconfig sits
is a layout decision rather than a boundary of the code. trpc's
`packages/tests` imports helpers out of `packages/server/src/__tests__/`, and
`--fix` deleted every one of them. A sibling is read for what it takes from the
package under analysis and never for what it names: its own imports say
nothing about this package's manifest.

**A build directory the manifest names is left out of the walk.** `outDir`
covers a `tsc` build; tsup, rollup and vite say where the output goes in
`main`, `module`, `browser` and `exports`, and nowhere the compiler reads.
Yesterday's bundle was keeping today's dead dependencies alive. A directory
holding a file the program holds is source by demonstration, whatever the
manifest calls it.

**The shipping path is read from reachability, not only from a name.** A name
tells you `card.test.ts`; reachability tells you the helper directory beside
it. valibot's `src/vitest/` wraps the test framework, is imported by tests
alone, and the report advised shipping vitest in `dependencies` on the
strength of it. Two things fed that: no chain of imports from an entry point
reaches the directory, and `vitest.config.ts` named it — in a
`coverage.exclude` list, which is paths that are the opposite of an entry
point. A path in a config is strong enough to keep a file alive and too weak
to say the package ships it, so the dependency check now leaves a config's
entry points out of the shipping path it works from.

**A build's own configuration is no longer offered as a place to look.** An
unverified name match is a lead, and `{ type: "feat" }` in a semantic-release
config shares a word with the type and nothing else. The evidence sent
readers to a file with no bearing on the finding.

**The code beside the program is read for what it imports.** A tsconfig
decides which files a run holds, and projects leave real code out of it all
the time: an `exclude` that names the tests, a `files` list of one declaration
file whose implementation is JavaScript, a `scripts` directory nobody
compiles. Every claim norefs made was stated in absolute terms — *every*
reference sits in this file, *no* source file imports this package — and each
was wrong by the width of the exclusion. On superjson `--fix` removed
thirteen `export` keywords, reported `Verified: tsc reports no new errors`,
and left `src/is.test.ts` importing six names that were no longer exported.
The references it missed were one directory listing away. Those files are now
read as text for three things and nothing else: which project files they
import, which names they take, and which packages they name. Nothing in them
is analyzed or reported — a scan can say a package is used and never which
section it belongs in, and a property read still needs a type checker.
`node_modules`, the dot-directories and each package's `outDir` stay out of
the reading.

**A run says when it resolves no entry point.** Nothing is public API, no
import chain has a root, and the whole project is about to be reported
unused. `norefs entries` has always printed that line; an ordinary run never
reached it, and swr's 65 dead files arrived with no explanation.

**A member declared twice, read through the other declaration.** Two shapes
made this finding, and both ended in `--fix` deleting load-bearing code. An
exclusive union writes each arm with the other arm's member set to
`undefined` — `{value: T; issues?: undefined} | {issues: Issue[]; value?:
undefined}` — so a guard narrows to one arm and the placeholder beside it
collects nothing, while deleting it changes what the type accepts. A name two
arms of one union both declare is now kept on both, the way an `extends`
clause already kept one. And a cast off a value the types do not follow —
`(api as WithDispatch).dispatchFromDevtools`, where `api` is `unknown` —
lands the read on the shape the cast names and never on the declaration the
value came from. That declaration is `shadowed` now, evidence and all,
instead of dead.

**A run says when its tsconfig makes the answer meaningless.** Two shapes used
to end in a cheerful `No unused code found.` that nobody should believe. A
solution-style config — `"files": []` beside `"references"` — holds no files
at all, and now names the configs to point norefs at instead. It says what
the run scanned rather than what the config did: on a monorepo whose packages
hold plenty, `Nothing was scanned` above two hundred findings taught the
reader to distrust the findings. A config whose
`extends` target is not installed loses every option it meant to inherit, so
`outDir` never resolves and every file in the project reads as dead; that says
so too, before the run.

**Two more ways a package is named without an import.** A script that runs a
binary by its path (`node ./node_modules/.bin/tsd`) names the package that
owns it, and so does the config a tsconfig `extends`.

**A harness is read by the name its tool writes.** `pick.test-d.ts` is tsd's,
`groupBy.test-prop.ts` is fast-check's, and `benchmark.js` is the whole name
rather than a suffix on one: all three used to count as shipped source, which
put 383 of valibot's and remeda's files in the report and called `vitest` a
misplaced dependency in both. A directory is read the same way — `bench`
joins `benchmarks`, and the double underscores of `__performance_tests__` are
read for what they are. A word *before* the separator still counts
(`type-tests`), and a word after it no longer does: the shape that admitted
`test-d` admitted `test-utils` and `tests-e2e` too, which are names products
give to code they ship, so `test-d` is now named on its own.

**A subpath pattern publishes what it matches.** `"exports": { "./*":
"./dist/*.js" }` says every module in the package is reachable from outside
it, and names none of them — so norefs used to drop the pattern and call the
whole library internal. zustand and jotai both publish that way, and both had
most of their public API reported as dead or test-only. The pattern is now
matched against the files a run holds, through the same `outDir` and `rootDir`
mapping a written path goes through. A harness file is never published,
whatever shape the pattern takes. `types` is read beside `main` and `bin`
while we are here.

**A declaration file is source the whole way through.** The release that made
a project's own `.d.ts` answer for its exports stopped short of the rest: a
package whose published entry is `types: './index.d.ts'` had no entry point at
all, so its whole public API read as dead, and a package imported only from a
declaration file was called an unused dependency. Both are fixed. So is the
other side of the same coin — an implementation a declaration file describes,
`atom/index.js` beside `atom/index.d.ts`, now answers through that declaration
instead of for itself. Every import resolves to the declaration, so the names
in the file beside it could never collect a reference, and `--fix` was willing
to delete a library's whole public API on the strength of it.

**A type argument keeps its members under a constraint nothing can read.**
`ApplyDefaultOptions<Options, Defaults, Given>`, where `Defaults extends
Omit<Required<Options>, …>`, requires members the constraint never writes
down. Reporting them named what the compiler checks on every build.

**The project's own declaration files are source.** A `.d.ts` used to be
skipped whole, so an exported type in `src/api.d.ts` that nothing imports was
invisible, and so were its members. They are scanned now, on the same terms as
any module — a package's own `.d.ts` still is not, and neither is one nothing
imports, which is how a global shim like `vite-env.d.ts` stays out of it. Two
claims are held back: a declaration is never called over-exported, and no fix
edits one, because the `export` keywords there are what make the file a module
rather than a script of globals and the compiler does not object when the last
one goes. A module only a `.d.ts` imports is no longer called dead either: the
files a declaration names are reached through it.

**A key the source computes can write, not only read.** `shelf[slot] = 4`
used to mark every member `slot` can name as used, exactly as `shelf[slot]`
does — so a member the code only ever assigns through a computed key was
invisible. The key's type already says which members it reaches, and now the
site is filed as a reference to each of them, which leaves the ordinary
read-or-write rules to sort it out: a member nothing reads back earns
`write-only`, one that a read reaches under any name stays where it was, and
`delete shelf[slot]` is called a `delete`. `--fix` reports and stops — the key
stands for more than one member, so no single edit retires the write.

**A default export with no name is checked like any other.** `export default
{ … }`, `export default class { … }`, an arrow, a bare value — none of them
were ever reported, because the export check searches for an identifier and
these have none. They are found now, through the symbol the binder leaves on
the declaration and the one name the module system gives it, so a default
import and a barrel's `export { default as … }` both count as usage. The
report says ``dead default export`` rather than quoting a name nobody wrote,
and `--fix` removes the statement together with the default imports left
pointing at it. A harness file is exempt: a vitest config or a storybook story
takes its input through the default export, and no import will ever name it.

**And so are its members.** `export default class { … }` used to be skipped
whole: the escape checks need the class's references, and a class with no name
was thought to have none. It answers to `default` like everything else, so its
members are now checked on exactly the terms a named class lives by — silent
when an instance escapes into an interface it never declared, when a subclass
lets one out, or when something enumerates its keys. The report names the file
rather than a class: ``dead property `deadLatch` in the default-exported
class``.

**A relay answers to every name it is given.** A function that hands its
parameter to `Object.keys` makes that type untrackable at every call site, and
norefs goes quiet about it. `const scan = dump` used to end the trail: the
calls behind the second name were never read, so a type only ever dumped
through `scan` had its members reported — a false positive, and the tool's
worst kind. A renaming binding is now followed, and so is a relay held on a
property (`const pantry = { sift: dump }`), across files and through as many
renames as there are. The old advice to annotate the binding is gone with the
bug; it never worked, because a relay's declared parameter is wide by
construction and it is the call sites that say what arrives.

**A destructuring assignment reads on one side and writes on the other.**
`({ starred: card.starred } = wanted)` used to read as a read of
`card.starred`, which is the opposite of what it does — the value lands there.
Meanwhile the key beside it, which really does read `wanted.starred`, resolved
to nothing at all: a pattern is written as a literal and sits where nothing
gives it a type to be read against. So a member a pattern was the only reader
of came back `write-only (unverified name match)` — a false positive, in four
shapes: `({ starred } = card)`, the nested `({ badge: { starred } } = card)`,
the array `[{ starred }] = cards`, and the pattern a `for…of` binds. Both
halves are now read the way the code means them. The key names a member of the
value on the other side of the `=` and reads it, and the far side is a write:
a member nothing else touches earns `write-only`, reported and left for you,
because no single edit takes an expression out of a pattern.

**A `delete` is not a read.** `delete card.draft` used to keep `draft` alive:
the reference search found the member and stopped there. A `delete` fills
nothing in and asks for nothing back, so it now counts the way a write does,
and a member nothing else touches earns the `write-only` verdict — worded for
what it is: ``the `delete` at src/card.ts:7 is all that reaches this member``.
`--fix` reports it and stops. Removing the member alone would leave the
`delete` naming nothing, and no single edit retires a statement, so the finding
says which `delete` is holding it back and leaves both to you.

**A top-level array binding is read for its elements.** `const cards = [{ title,
deadNote }]` reported nothing: nesting reached an array through the property
holding it, and this array had no holding property. A binding now holds one
shape per element on the same terms a property does — the elements answer
together, and an element that leaves takes the whole array's answer with it.

**A const binding whose shape empties is one finding, and `--fix` leaves it.**
`const box = { deadA, deadB }` that something still reads used to report both
members, and `--fix` obliged: it deleted them and left `const box = { }`
sitting there, dead and now invisible to the next run. It folds onto the
binding instead — ``const `box` becomes empty: all 2 members are dead`` — the
way an emptied interface or property already does. A binding nothing reads is
untouched by this: nothing outlives the removal, so the members stay one
finding each and `--fix` takes the whole declaration.

**Nesting goes through an array of literals.** `{ cards: [{ title, deadNote },
{ title, deadNote }] }` reported nothing before: nesting followed a single
literal only, so every member of every element was invisible. A property now
holds one shape per element, and the elements answer together — the checker
keeps one declaration per name across identical shapes, so a name any element
holds a read on is alive on all of them, and a name none of them holds is dead
on each. Reads count through a callback written on the spot (`map`, `forEach`,
`filter`, `find` and their kin), a `for…of` binding, an index, or `.length`. An
element that leaves — `cards.map(send)`, `save(cards)`, `[...cards]`,
`cards.sort()` — takes the whole array's answer with it, because an element is
the shape in question and no reference search follows it out. Sibling elements
writing the same key are no longer read as writes of each other, which was
softening a proven `dead` verdict into a hedged name match.

**A property whose shape empties is one finding, and `--fix` leaves it.** A
shape written inline on a property — `{ labels: { deadColor, deadFont } }`,
as a value or as a type — has no declaration to answer for it. Losing every
member used to report every member, and `--fix` obliged: it deleted them and
left `labels: {}` sitting there, dead and now invisible to the next run. The
member findings now fold into one on the property that holds them, worded like
the fold an emptied interface already gets: ``property `labels` becomes empty:
all 2 members are dead``. It reports and stops. norefs only ever looked inside
that shape because something reads the property, so the fold always leaves a
read behind that now reaches nothing — removing the property means removing
that read, and only you know what it was for. A shape keeping one live member
is untouched, and so is one holding a spread, which carries members no fold can
account for.

## [0.11.0](https://github.com/FranCanias/norefs/releases/tag/v0.11.0) — 2026-08-21

Two runs against a 3,700-file monorepo (drizzle-orm), each followed by a hand
audit of every finding, drove this round. 41% of the first report was noise;
the second audit found what the fixes had uncovered underneath. The same tree
now reports 448 findings against the first run's 808, no true positive was
lost, and the hedged `write-only (unverified name match)` verdicts went from 41
to 15. [Corpus validation](docs/corpus.md) has the run and the counts.

**A module a consumer takes whole is exempt, member and all.** `import * as
schema from './schema'` followed by `orm(db, { schema })` hands the whole
module over, and the far side walks its keys — `Object.keys`, an `is()` filter,
a `for…in`. No reference search sees any of that, so every export in the module
was reported dead and the advice was to delete the thing the consumer
iterates. A namespace binding that leaves as a value now makes its module
exempt on the same terms as public API. A binding whose every use is a property
read is unchanged: those exports are still reported, at the same lower
confidence as before.

**A test helper is no longer reported for helping tests.** `test-only` says
production code never touches this and only the tests keep it alive. Said of a
fixture that lives under `tests/` itself, it says nothing at all — and on the
monorepo that was 232 of the 808 findings. The verdict is now withheld when the
declaration sits in the harness. A harness declaration nothing references at
all is still `dead`.

**A harness directory is known by its shape.** Projects name them `tests`,
`type-tests`, `js-tests`, `__tests__`. Matching a fixed list of words meant
every project that picked a different name had its whole harness read as
shipping code. The rule is now the shape: `test` or `tests`, alone or behind a
prefix and a separator — which is also what keeps `latest` out. `__mocks__` and
`benchmarks` count too.

**The JavaScript behind a hand-written `.d.ts` is not a dead file.** `import
'./grammar'` beside a `grammar.d.ts` resolves to the declaration, and the type
graph stops there — while the run loads `grammar.js`. The implementation looked
like a file nothing imports, and deleting it broke the build. A resolved
declaration file now keeps its runtime sibling alive, in both pipelines.

**A reference is not a read.** The `shadowed` verdict claimed a twin *reads*
the member on the strength of any reference to it. Two copies of a type whose
builders both only fill the member in each pointed at the other and called it
the reader, so the pair shadowed each other and the report never said the true
thing: nobody reads it. The test is now the one the member analysis uses.

**A name written everywhere stops being evidence.** `write-only (unverified
name match)` cited `name` "assigned at … and 2,405 more sites". Past ten
matches the count is all the match means, so the verdict falls back to `dead`
and the count goes in the evidence instead. And a `.json` file the program
holds is data: `"test"` in a package.json script block is no longer cited as
the assignment behind a member.

**Three more things count as a dependency being used.**

- `require.resolve('pkg')`, which loads nothing and still says the package has
  to be installed.
- An `.eslintrc`-style rc file, in YAML or JSON. Only `*.config.*` was read
  before, so every plugin an older ESLint config named came back dead. Short
  plugin names expand on the way through: `plugins: [import]`,
  `plugin:unicorn/recommended` and `import/no-cycle` all name
  `eslint-plugin-…`.
- A bare specifier that lands on project code, when a manifest lists it — a
  workspace dependency linked by path (`"seedbox": "workspace:../seedbox/dist"`)
  resolves straight back into the repo. One no manifest lists is a `baseUrl`
  import, and is never reported unlisted either.

**A dependency the build inlines is where it belongs.** A bundled CLI carries
its dependencies inside its output file. `external: ['esbuild', 'drizzle-orm']`
is the list of what it does not carry, and everything else is compiled in — so
`npm install --omit=dev` is missing none of it. norefs now reads the `external`
list out of the package's own build files, and withholds the misplaced claim
for every name they leave out. A list built from something it cannot read — a
call, an object — makes the answer unknown, and the check reports as before.
On drizzle-kit this was 17 findings, every one of them wrong.

**A peer dependency is the consumer's to install.** Listing it in
`devDependencies` as well is how a package builds and tests against its own
peer. Whoever installs the package brings it, so the install-is-missing-it
claim was never true of one.

**A `/// <reference types="…" />` directive is the package being used.** It is
a file saying it needs that package installed, written in the one place the
import graph never looks. Every types package a project reaches this way came
back dead. Only the prologue is read — past the first token TypeScript honours
nothing, and the same words are prose.

**A value read as itself is not an escape.** Proving a member dead means
following every same-named write to somewhere it cannot be read from. The walk
gave up on two shapes it should have kept: `card.label`, which reads `card` at
that value's own type, and `return { schema, card }`, where the checker takes
the outer property's type straight from the value. Both now count as
destinations. Twelve members of drizzle-kit's `schemaToTypeScript` results were
hedged as `write-only (unverified name match)` on the strength of four sibling
dialects writing the same names; all twelve are now `dead`, which is what they
are.

**A scheme names the host, not a package.** `bun:sqlite` and
`cloudflare:workers` were reported unlisted, the way `node:fs` never was. npm
resolves none of them, so the finding asked for a line nobody can write.

**A private package has no section to get wrong.** `"private": true` is npm
refusing to publish it: nobody runs `install --omit=dev` against it and nobody
downloads its weight, so both halves of the misplaced-dependency claim are
about an install that never happens. A dependency nothing uses is still
reported.

**A function with several `return` statements is finally read.** One returned
object literal was the only shape the check would look at. Two meant the whole
function was skipped, dead keys and all:

```ts
export const ormCoreVersions = async () => {
  try {
    const { compatibilityVersion, npmVersion } = await import('drizzle-orm/version');
    return { compatibilityVersion, npmVersion };   // only `npmVersion` is ever read
  } catch (e) {
    return {};
  }
}
```

Each branch is a shape of its own, and now each one answers for its own
members. The example is real — that finding is new on drizzle-kit, and it is
the only thing that changed across five repositories checked before and after.

A key more than one branch writes is the part that needed care. Two branches
returning the *same* shape collapse to a single set of declarations, so every
read lands on the one the checker kept and the others hold no references at
all. Reporting those would be a false positive, so a shared key is reported
only when every branch that writes it is unread — and then at each line that
writes it, because each is a separate edit. `--fix` retires them together.

A `return` of anything but a literal still stops the check. A read of the value
could land on that other shape, and the literal's own keys would prove nothing.

**Two branches losing everything is one finding, not two.** "Nobody reads what
`f` returns" now needs every branch to be empty, and counts the keys the return
value offers rather than the lines that write them.

**A sibling branch is no longer read as a name match.** A key written in two
branches used to soften its own verdict to `write-only (unverified name match)`,
citing the other branch as the write. That is the same property written twice,
not a name that happens to match, so the verdict stays `dead`. This can change
a verdict in a baseline.

The check does work it used to decline, so a codebase full of multi-return
producers has more to analyze. Measured against the same volume of
single-return literals, the new path is slightly cheaper per member — 2.07 ms
against 2.33 ms, on the two shapes `bench/synthetic.mjs` builds for exactly
this comparison. The cost is the work, not the reading of it. On real
repositories the wall clock did not move.

**Object literals are read to their full depth.** The const-object and
returned-object checks stopped at the top level: `const cfg = { oven: { tray:
'steel', deadRack: 'wire' } }` said nothing about `deadRack`. A literal nested
inside another is a shape of its own, and now it answers for itself — as deep
as the nesting goes, with the property path in the finding: ``dead property
`deadRack` in const `cfg.oven` ``.

The descent is only as safe as the reads that lead to it, so it follows the
same rule the top level already lived by: every read of the holding property
must keep the value local. `cfg.oven` passed bare, serialized, enumerated, or
indexed with a computed key carries the whole inner shape with it, and the
check stops there. A read reaches one level in through a path (`cfg.oven.tray`),
a string index (`cfg['oven'].tray`), or a destructuring whose binding stays
local — the last two are new, and the type-level checks gained them too.

**A relay handed on as a value is followed too.** `Object.keys` one function
away already silenced the types flowing through it, but only where that
function was called with an argument to read:

```ts
function dump<T extends object>(o: T) { return Object.keys(o) }
rows.forEach(dump)              // `Row`'s members were reported dead
rows.forEach(row => dump(row))  // these were not
```

A wrapper nobody needs was the only thing between a user and a `--fix` that
deletes members their code reads at run time. `rows.forEach(dump)` writes no
argument down, so the position now answers instead: the type that position
expects at the relaying parameter is what will arrive. That reading is not
about arrays — a declared callback option or an annotated binding says the
same thing, and each is followed.

What is left is a relay renamed through a binding that declares no type
(`const relay = dump`) or handed to a parameter typed only `Function`. Neither
has a position to read. Annotating the binding restores it.

**A property the code assigns and never reads back is write-only too.** An
assignment target is a property access, so `t.misses = 0` looked exactly like
a read and kept the member off the report:

```ts
interface Tally { hits: number; misses: number }
function count(t: Tally) { t.misses = 0; t.misses += 1; return t.hits }
```

`misses` now reports. An update whose old value goes straight back in —
`+= 1`, or `count++` on a line of its own — writes; one whose value is handed
on, `const n = count++`, reads. Neither `--fix` nor `--fix-unsafe` touches
these: no single edit retires an assignment, because the right-hand side may
be doing work that has to stay. The finding is reported and left for you.

Telling the two apart also settled a question the analysis had been answering
by luck. A name match was discarded when *something* read the same property on
another literal, and an in-place write counted as that read. It no longer does,
so a member in that position reports as an unverified name match — which is
what the analysis actually knows — rather than as dead.

**A member the code only fills in is now write-only, not used.** A write is a
reference, and a check that stops at "found one" called this member alive:

```ts
interface LarderStock { crateCount: number; spareCrates: number }
const small: LarderStock = { crateCount: 12, spareCrates: 0 };   // `spareCrates` was silent
```

Nothing reads `spareCrates`. It now reports as `write-only`, naming the
literals that set it, and `--fix-unsafe` retires the member together with
every one of them. The verdict already existed for the writes the reference
check could not see; this is the case where the reference is right there.

A read through *any* declaration still counts as a read. `satisfies` and
`as const` leave the literal holding its own type, so `shelves.trivetCount`
lands on the property written there rather than on the member it was checked
against — both stay.

**A write only counts where the value stays readable.** Saying nothing reads a
member means having looked everywhere a read could be, and a literal handed to
a call is read by whatever the callee does with it:

```ts
const visitor: EnterLeaveVisitor<FragmentSpreadNode> = {
  enter(node) { … },              // `enter` was reported write-only
};
visit(doc, { FragmentSpread: visitor });   // graphql calls it on every node
```

The verdict now asks whether this run holds that callee's body. A function the
project declares *and* implements is read where the reference search already
looks, and the verdict stands. A body norefs does not hold — a package, an
ambient declaration, an overload with no implementation — is not, and the
member keeps the answer it had before. `expect(result).toEqual({ greeting:
'Hello' })` is the same shape wearing test clothes: the matcher reads
`greeting` in order to compare it, and 138 of those assertions were being read
as 138 writes and no reads.

Everywhere else the value stays accountable, and the verdict is unchanged. A
literal assigned into a stored slot, held in a local binding, or returned is
read back through the type that declares the member. The `test-only` verdict is
unchanged too: it says who touches the member, not whether anybody reads it.

**A twin cluster grew.** `shadowed` went from 7 findings to 33 on the monorepo,
almost all of them in sibling dialect files — `pg-core`, `gel-core`,
`mysql-core` and `singlestore-core` each declare the same index config. They
are new members reaching the report through the work above, and the twin they
name is real. The reading to have is the verdict's own: the finding is the
duplication, not the member.

**A key the source computes credits the members it can reach.**
`manifest[section]` names a member without writing it down, and until now the
reference check saw nothing there. The key's type says how much is in reach: a
union of string literals marks exactly those members used and leaves the rest
of the type answerable, the way a `'name' in v` probe does; a string the type
cannot pin down reaches every member, and the whole type goes quiet. This was
a false-positive source on its own — it is what the new verdict ran into
first, dogfooding norefs over norefs. Indexing costs one type lookup per
computed key: unmeasurable on real code, and 0.69 s to 0.72 s on
`bench/synthetic.mjs computed-key`, a project that is nothing but indexing.

**A sink reached through a helper counts as a sink.** `Object.keys(recipe)`
had always silenced `Recipe` — its keys are read without naming one, so its
members cannot be counted. The same call one function away did not:

```ts
function dump<T extends object>(o: T) { return Object.keys(o) }
render(r: Recipe) { return r.title + dump(r).length }   // `label` reported dead
```

`label` is read at runtime, and the report was wrong about it. The sink
standing inside `dump` sees only `T`; the concrete type is back at the call
site. The index now follows a relaying parameter out to its callers and skips
what it finds there, through as many hops as the forwarding goes — a plain
function, an arrow bound to a const, a method, across files, and a relay that
calls itself. Only the parameter carrying the value relays; the ones beside it
answer for their members as before.

This costs nothing and often saves: a type it silences drops out of the member
check entirely. On `bench/synthetic.mjs relay`, a project built to be nothing
else, the run went from 2.07 s to 0.36 s and from 3,300 false positives to
none — the 300 findings left are the dead exports that were always there.

**A `'name' in box` probe no longer kills the key it names.** The returned-object
check counted every member of `makeBox()` against the reference index alone,
where the const-object check had always credited the probed key. A member only
a probe reached was reported dead. Both checks now read the same index.

**One death is reported once.** A property nothing reads no longer has its
members reported underneath it. The property itself was already the finding;
listing what it holds said the same thing twice and handed `--fix` two edits
for one deletion. This also cleans up a case that predates the nesting work,
where an interface member holding an inline object type reported both.

## [0.10.0](https://github.com/FranCanias/norefs/releases/tag/v0.10.0) — 2026-08-20

A performance pass, checked the honest way: every change ran A/B against
0.9.0 on real repositories, and the findings — and the fix patches — came out
byte-identical. The speed is the release; two smaller edges came with it.

**Full runs are 40–50% faster.** The reference index no longer resolves every
occurrence up front. A name resolves when the first query targets it — closed
over its import renames — and a name no query ever targets, most occurrences
of a big project, never resolves at all. Module resolution now keeps a cache
instead of re-walking `node_modules` per specifier, descendant walks run over
raw compiler nodes, and line numbers come off the compiler's cached line
table. On the two repositories that drove the work, full runs went from
29.4 s to 17.3 s and from 5.3 s to 2.7 s.

**`--fix` cleans up orphans without rebuilding the program.** After a
removal, the search for imports and locals that nothing uses anymore answered
through the type checker, and each cleanup round rebuilt the whole program.
It now answers from the syntax alone, which can only err by keeping code —
never by removing it. A fix dry-run on one corpus went from 21.9 s to 9.1 s,
at 0.6 GB less memory.

**A pre-existing type error no longer aborts a `--fix` campaign.** The
verifier keys each error to compare before against after, and the key
included the compiler's narration — "the file is in the program because:
imported via …" — which shifts whenever an edit touches an unrelated import.
A pre-existing error would re-key as new, fail every bisection step, and
abort the campaign over an error the fixes never caused. The key now stops at
the head of the message. On one real repository this was the difference
between an aborted campaign and 453 verified fixes.

**norefs warns before it runs out of memory.** Running out of heap arrives as
a V8 crash the CLI cannot catch or soften, so the only place to speak is
before the work starts. norefs now estimates the run's cost from the
project's source size, and when the estimate does not fit the heap it says so
and names the two ways out: give Node more with
`NODE_OPTIONS=--max-old-space-size=8192`, or ask for less with `--only`.

## [0.9.0](https://github.com/FranCanias/norefs/releases/tag/v0.9.0) — 2026-08-19

A repository audit went over everything again, and most of what it found lives
behind the scenes: stricter compiler flags, a `Finding` type that says which
fields each kind carries, a `main()` split into parts a test can reach. The
user-visible edges:

**Any failure is reported in the CLI's voice.** A malformed tsconfig or an
analysis error mid-run used to escape as a raw stack trace. One boundary now
catches whatever is thrown, prints `error: …`, and exits 2 — the same answer a
usage error gets.

**`--help` states the exit codes.** 0, 1, and 2 are the CLI's contract with CI,
and the help text never said so.

**`--fix` warns when git cannot vouch for the tree.** The dirty-tree guard
returned clean when git was absent, so fixes wrote into an unversioned tree
with no way to revert them separately. The guard still lets the run proceed —
there is no tree state to protect — but it now says so first.

**`--export` validates like `--reporter`.** A bad format now answers
`--export must be one of md, json`, in the same voice as every other
pick-from-a-list flag.

**Stack traces name `src/` lines.** The package ships sourcemaps and turns
them on, so the line numbers in a bug report point at code someone can read.

**`require('norefs')` fails honestly.** The manifest now declares an `exports`
map with no library entry, so importing the CLI as a library answers with the
manifest's own error instead of an opaque resolution failure — and deep imports
into `dist/` are refused. `CONTRIBUTING.md` no longer ships in the tarball.

## [0.8.0](https://github.com/FranCanias/norefs/releases/tag/v0.8.0) — 2026-08-17

A release about the machinery around the analysis. An audit went over the
repository — CI, packaging, lint configuration, the layering — and found the
gaps were not in what norefs decides but in what nothing was checking. The test
suite had no type gate. The formatter never ran in CI. Four fixture trees were
linted under the very rule they exist to break.

None of that would reach a user, except that the same pass produced this
release's one real fix. Giving the speed page a source anyone can re-run meant
running two configurations of norefs over a 541-file repository and diffing the
reports. They disagreed by one finding, and the finding was false: a dynamic
import destructured on the spot leaves no reference on the export, so norefs
called it dead. Both configurations were blind to it. The full one had stayed
quiet by accident, which is not the same as being right.

That is what a guard rail is for, and it is the argument for every other change
here. The rest of the release answers bad input: three paths that used to end in
a stack trace or a silent success now say what is wrong and exit 2.

**Node 22.4 is the floor.** `engines` said `>=20` and the CLI passed
`allowNegative: true` to `parseArgs`, an option that landed in 22.4 — so on
Node 20 every documented `--no-*` flag was an unknown option, and an unknown
option was a stack trace. Both halves are fixed: the floor now says what the
code needs, and CI runs the floor and the current release rather than one
version nobody promised.

**An unknown flag is a usage error, not a crash.** `norefs --bogus` printed a
Node stack trace and exited 1, while every other bad input got a tidy `error: …`
and exit 2. It now gets the tidy line and exit 2.

**A `--scope` or `--entry` path that does not exist stops the run.** A typo
filtered every finding out and the run reported success with nothing to show —
the same silent-success failure the unreadable-tsconfig check was added to
close.

**Side-effect imports resolve with their own package's options.** In a run
spanning several tsconfigs, the fallback resolver for `import './x'` used the
first tsconfig's compiler options, so a file reached only through a package's
own `paths` alias could be reported dead. It uses the options of the package
that owns the importing file, exactly as the project did when it loaded.

**A dynamic import destructured on the spot counts as usage.**
`const { plate } = await import('./recipes')` uses `plate`, and nothing about
the occurrence said so: the pattern creates a symbol of its own, and no
reference ever landed on the export. norefs reported it dead — a false
positive, the one mistake this analysis does not make. The same held for the
callback `import('./recipes').then(({ plate }) => …)` hands the module to.
Binding the module first was always read correctly, and still is.

The link is the module the pattern reads, and it sits right there in the
expression. The index asks the syntax first and only then the checker, so this
costs a run that wants no member findings nothing at all — which is why it is
not behind the member gate, where the answer would have been unavailable to the
runs that need it most.

It was found by running two configurations of the same release over Apollo
Client and diffing them: the member-less run reported 89 module-level findings
where the full run reported 88, and the extra one was the true answer arriving
by accident. Both report 88 now. [docs/corpus.md](docs/corpus.md) has the run.

**`--watch` is watching before it says it is.** The first report ended with
`Watching for file changes`, and the watcher was installed after it. A save
landing in that gap was lost for good: the run sat silent over the file it had
just been asked to follow, and only a second save woke it. The window is
sub-millisecond on an idle laptop, which is why it went unseen — and wide enough
on a loaded machine that CI hit it on every run. The order is reversed now, so
an edit during the first analysis queues a re-run instead of vanishing.

CI is what found it, on the first day CI ran. It took a widened gap and a
container to prove: with the old order and 1.5 seconds inserted before the
watcher, the edit is lost every time; with the new order and the same 1.5
seconds, it is caught every time.

**A hand-edited baseline says what is wrong with it.** An entry missing a field
used to fold into a key containing `undefined` and quietly match nothing. It is
now the same loud error an unparseable baseline gets.

**The `--verify-command` probe leaves a way back.** The probe writes candidate
text into the real files for the length of one command and restores it in a
`finally`. The pre-probe contents now go to `norefs-restore-<pid>.json` in the
temp directory first, so a run killed inside that window can still be undone.
`docs/flags.md` documents the window.

Internal, with no change to any output: the fix campaign moved out of `main()`
into `engine/fix-campaign.ts`, the reference index moved to its own `lookup/`
layer under both `engine/` and `collectors/`, and the suppression marks both
pipelines read are now one implementation with a fixture that runs every rule
through both.

**Every promise this repository makes is now checked by a job that fails.** An
audit found the gaps were not in the analysis but in the guard rails around it,
and each one was free to close — the checks all passed the day they were added.
The test suite was never type-checked: `tsc` read `src` only, and a third of the
codebase had no type gate. Formatting and import order were never checked: CI
ran `biome lint`, the linter alone, where `biome ci` runs the formatter and the
assists over the same tree and reaches the JSON the linter skips. The Biome
exemption for fixture directories named five of the nine by hand, so four
fixture trees — whose whole job is to hold code nothing uses — were linted with
`noUnusedVariables: error`; a pattern now covers every one. `ci.yml` declared no `permissions`, no `concurrency`, and
no `timeout-minutes`, so a fork's pull request could inherit a write-scoped
token and a hung child process could run for GitHub's default six hours. Every
action is pinned to a commit SHA, and Dependabot moves them. A weekly security
workflow runs CodeQL, `pnpm audit --prod`, and OpenSSF Scorecard. Coverage is
reported, never gated.

**The build runs on Windows.** It was `rm -rf dist && chmod +x`, neither of
which exists there, so a Windows contributor could not build, could not run the
two suites that spawn the binary, and could not publish. It cleans and chmods
through Node now.

**The build stopped emitting declarations nobody could import.** 48 `.d.ts`
files, 13% of the tarball, reachable through no `main`, `exports`, or `types`.
norefs is a CLI; the manifest said so and the build did not. A test now pins
that decision, so the two cannot drift apart again.

**One build, before the suite starts.** `cli.test.ts` and `smoke.test.ts` each
built the binary in their own `beforeAll`, in separate worker processes — so one
suite's build could delete `dist` while the other was spawning it. It is a
`globalSetup` now, and it costs under a second.

Also here: the release is one `pnpm run release patch` rather than four hand
steps, `.nvmrc` puts local work on a Node version CI covers, `describe.ts` moved
out of `engine/` because `collectors/` imported it upward, and the repository
gained `SECURITY.md`, issue forms, and a pull request template.

## [0.7.0](https://github.com/FranCanias/norefs/releases/tag/v0.7.0) — 2026-08-14

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

One change answers the opposite kind of wrong. A const object's members were
never checked at all — no false positive to hit, just a question nobody asked,
about the shape that has replaced the enum.

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
  `Step[]` reads `done` on `Step` — and only together: a bare literal written
  against an array type selects nothing, so it reads nothing either, and a name
  in it credits no member. The credit stops at four levels down, and the members
  beside the named ones are reported exactly as before.

- **An import specifier is not a value escaping.** The escape check that decides
  whether a binding's members can be counted read `import { Timeouts }` as the
  value leaving local view, so every exported binding was untrackable. It is the
  same binding under another name, and the reference index resolves past it — the
  uses it leads to were in the list all along. The check for callables already
  knew this; the one for values now does too.

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

  A string in a comment is left alone too. The strings come off the same token
  stream the scanner reads source with, so a commented-out line is not a config
  saying something — which matters in both directions. `// import './setup'`
  above a live `setupFiles: ['./setup']` would have cancelled that entry point
  and called the file dead, and `// import gone from 'gone-plugin'` would have
  kept a dead dependency looking alive.

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

- **Members of a const object are checked, like an enum's.** `const Timeouts = {
  … } as const` is the enum modern TypeScript writes, and
  `Timeouts.CHART_UPDATE_DELAY` was provably dead while norefs said nothing —
  not with `--anon`, not scoped to the file. The member pass read type
  declarations, and this is a value; the export pass saw `Timeouts` imported and
  stopped at the binding. Nobody asked about the members.

  Now a sixth collector does, beside the one that already answers it for enums.
  A plain `const x = { … }` counts too, exported or not, and a property written
  the short way — `{ spareJar }` — is a property like any other. A declared shape
  is not: an annotation or a `satisfies` hands the shape to a named type, and the
  collectors that read types report that type — a second finding here would say
  the same thing in a different voice. The fixture proves the hand-off lands
  rather than assuming it: each dead member is reported once, on the type that
  declares it.

  Only the top level of the object is read. A member of a literal nested inside
  it is nobody's finding yet — the same boundary the returned-object collector
  has always had, and the blind-spot list now says so.

  A value hands out all of its properties at once, which an enum never does, so
  four uses silence the whole declaration rather than softening the verdict on
  it: `Object.values`, a spread, an index with a computed key, and the binding
  passed on whole. `keyof typeof` and the serializing sinks already silenced it.
  A `'name' in Timeouts` probe is the one use that reads a single key, so it
  marks that key used and leaves the rest reportable — a reference count that
  missed a read is not a weaker claim, it is the wrong one.

  Found by an adversarial review after 0.6.0, on the same repository the rest of
  this release answers. On the corpus it changes nothing: hono and inshellisense
  report exactly what they reported before it.

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

## [0.6.0](https://github.com/FranCanias/norefs/releases/tag/v0.6.0) — 2026-08-14

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

## [0.5.0](https://github.com/FranCanias/norefs/releases/tag/v0.5.0) — 2026-08-14

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

## [0.4.0](https://github.com/FranCanias/norefs/releases/tag/v0.4.0) — 2026-08-14

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

## [0.3.0](https://github.com/FranCanias/norefs/releases/tag/v0.3.0) — 2026-08-13

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

## [0.2.0](https://github.com/FranCanias/norefs/releases/tag/v0.2.0) — 2026-08-13

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

## [0.1.1](https://github.com/FranCanias/norefs/releases/tag/v0.1.1) — 2026-08-13

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

## [0.1.0](https://github.com/FranCanias/norefs/releases/tag/v0.1.0) — 2026-08-13

First npm release: unused files, exports, types, members, and dependencies
for TypeScript projects, with `--fix`, baselines, and github/sarif
reporters.
