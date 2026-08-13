# Changelog

norefs follows [semver](https://semver.org). Before 1.0.0, minor versions
(0.x.0) may change output formats, flag semantics, and verdicts; patch
versions (0.x.y) fix bugs without changing what a script or a baseline sees.

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
  `'deviceLibrary:loadDevice'` at electron/main.ts:164". The claim stays
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
