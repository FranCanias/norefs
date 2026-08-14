# Changelog

norefs follows [semver](https://semver.org). Before 1.0.0, minor versions
(0.x.0) may change output formats, flag semantics, and verdicts; patch
versions (0.x.y) fix bugs without changing what a script or a baseline sees.

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
