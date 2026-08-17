# Contributing

Thanks for looking. This page holds what the code cannot say about itself: how
the suite is organized, how a release happens, and the rules the writing follows.

## Getting set up

```sh
pnpm install
pnpm run build      # compile to dist/
pnpm test           # the whole suite
pnpm run lint       # biome lint
pnpm run typecheck  # tsc --noEmit
pnpm run format     # biome format --write
```

Node 22.4 or newer. That floor is not arbitrary: the CLI parses `--no-*` flags
with `parseArgs({ allowNegative: true })`, which landed in 22.4. CI runs the
floor and the current release, so a change that needs something newer fails
there rather than in a user's terminal.

The package is CommonJS, on purpose and in writing: `"type": "commonjs"` in
`package.json`, `module: "nodenext"` in the tsconfig. A CLI is started by a
shebang and never imported, so CJS costs nothing and starts marginally faster.
The one file that has to be ESM says so with its extension —
`vitest.config.mts`.

`norefs.code-workspace` sets VS Code up for this repository — the pinned
TypeScript, Biome as the formatter, the file nesting. `.editorconfig` carries
the portable subset for every other editor.

## The layers

```
src/
  index.ts      the CLI: parse, route, format. It holds no analysis policy
  config.ts     norefs.config.json and `norefs init`
  baseline.ts   norefs-baseline.json
  messages.ts   one error-to-line helper, shared by every layer
  engine/       the analysis and the fix campaign
  lookup/       the project-wide reference index and its query API — the layer
                engine/ and collectors/ both sit on
  collectors/   one file per source of candidate members
  filters/      post-collection filters
  types/        shared types
```

Two rules keep the layering honest: `lookup/` never imports from `engine/`, and
`index.ts` never decides anything the engine could decide. When a CLI block
starts growing policy, it belongs in `engine/` — that is how
`engine/fix-campaign.ts` came to exist.

## The test suite

One behaviour per test, and the assertion names the behaviour. Beyond that:

- **One fixture per pattern.** `tests/fixtures/` holds one file per usage
  pattern, and `tests/analyze.test.ts` depends on that convention — a fixture
  that covers two patterns makes a failure ambiguous. Every fixture in every
  fixture directory is referenced by at least one test.
- **`tests/helpers.ts` holds the shared setup**: `analyzeFiles`, `withTempDir`,
  `inProject`, `runCli`. A test that needs a temp directory takes it from there,
  so a failing assertion never leaks one.
- **The CLI is tested as a binary.** `tests/cli.test.ts` and
  `tests/smoke.test.ts` spawn `dist/index.js`. Unit tests prove a mechanism;
  these prove `main()` reaches it. 0.5.0 shipped a feature that had never run
  end to end, and that is the miss they exist to catch.
- **Pin the wording of a claim.** Evidence strings, the `Verified:` line, and
  the exit codes are contract. A test that pins the words is what stops a
  refactor from quietly promising more than the analysis proves.
- **A new check needs a corpus note.** `docs/corpus.md` is the regression log:
  re-run the repos, compare the counts, explain every jump.

## Adding a check

A new source of candidate members is one file in `src/collectors/`, registered
in `src/collectors/index.ts`. A new filter extends `src/filters/index.ts`. A new
finding kind needs its name in `src/types/`, its label in `engine/describe.ts`,
its `--only` name in `filters/`, and a row in `docs/checks.md`.

Every heuristic states, in place, why its failure mode can only hide a finding
rather than invent one. A heuristic that can invent a finding does not ship.

## Documentation

Three places describe the flags — the README table, the `HELP` string in
`src/index.ts`, and `docs/flags.md` — and `tests/package.test.ts` checks the
three agree on the set. The prose still has to be updated by hand, in all three.

## Releasing

1. Update `CHANGELOG.md`. Entries are an engineering narrative with falsifiable
   claims: what changed, why, and what was checked rather than assumed.
2. Bump `version` in `package.json`, commit, and tag `vX.Y.Z`.
3. Publish a GitHub release for the tag. The publish workflow checks the tag
   matches `package.json`, runs lint, typecheck, and tests, and publishes to npm
   through OIDC trusted publishing — no token anywhere.

## Writing style

The code comments and the docs follow one voice, and it is part of the review:

- Simplified Technical English, and Zinsser's four: simplicity, brevity,
  clarity, humanity.
- Short sentences. Active voice. One meaning per word. Cut the clutter.
- A comment says *why*, never *what* — the code already says what.
- The claim may not outrun the probe. If a check cannot prove something, the
  message says so.

## Commits

Conventional Commits, imperative mood, and a body that explains why. The history
is meant to teach the next reader; `git log` is the closest thing this project
has to a design document.
