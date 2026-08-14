# What each flag does to your working tree

`norefs` has one flag that writes source files — `--fix` — and seven that
change what it writes, when it writes, or whether it writes at all. This page
says exactly what each one does to the tree, and what the combinations do.

One rule holds everywhere: **nothing reaches disk unless it verified.** Every
fix is applied to an in-memory copy of the project first. The files on disk
change only after the probe is green.

`package.json` is the one file no probe reads by default — the type checker has
no opinion about a dependency list. So those edits need `--fix-unsafe`, and
`--verify-command` is the probe that can actually judge them.

## The flags that touch files

| Flag | What it writes |
|---|---|
| `--fix` | Source files: dead code removed, over-exported declarations de-exported |
| `--fix-unsafe` | The same, plus write-only, contract, and shadowed findings — and the proven writes behind them. Also `package.json`: an unused entry is removed, a misplaced one is moved |
| `--baseline` | `norefs-baseline.json` in the current directory. Never touches source |
| `--ratchet` | `norefs-baseline.json`, when entries went stale. Never touches source |
| `--export md\|json` | `norefs-findings.md` or `norefs-findings.json`. Never touches source |
| `norefs init` | `norefs.config.json`, and never over an existing one. Never touches source |

Everything else — `--dry-run`, `--no-verify`, `--verify-command`,
`--allow-dirty`, `--scope`, `--only`, `--entry`, `--watch`, `--explain`,
`--anon`, `--production`, `--reporter` — writes no file of its own.

## Which flags belong in norefs.config.json

A **setting** shapes the analysis and the report. It is true of the project
every time, so it belongs in a file everyone shares. An **action** does
something — it writes source files, a baseline, a report file, or it keeps
running — and that is a decision per run.

| Setting (config key) | Action (flag only) |
|---|---|
| `-p/--project`, `--entry`, `--only`, `--scope` | `--fix`, `--fix-unsafe` |
| `--reporter`, `--anon`, `--explain`, `--production` | `--baseline`, `--ratchet` |
| `ignore`, `ignoreDependencies`, `boundaries` (no flag) | `--export`, `--dry-run`, `--watch` |

A flag passed on the run wins over the file, except `--entry`, which merges.
`--no-anon`, `--no-explain` and `--no-production` are how a run says no to a
project that said yes. An action key in the config file is a usage error, exit code 2.

`--no-verify`, `--verify-command` and `--allow-dirty` shape what `--fix` does
rather than what a run finds, so they stay with the action and are flags only.

## The order a fixing run happens in

0. **Projects.** With no `-p` and no `project` key, a `pnpm-workspace.yaml` or a
   `workspaces` list names them; otherwise it is `./tsconfig.json`. A tsconfig
   that does not exist is a usage error, exit code 2.
1. **Dirty check.** With `--fix` and no `--dry-run`, a tree with uncommitted
   changes stops the run. Pass `--allow-dirty` to go ahead anyway.
2. **Analysis**, shaped by `--only`, `--scope`, `--entry`, and the config file.
3. **Baseline filter.** When `norefs-baseline.json` exists, matched findings
   drop out — so `--fix` only ever fixes findings the baseline does not cover.
4. **Fixing, in memory.** Fixable findings are applied, then the project is
   re-analyzed and fixed again until nothing new appears — five passes at most.
5. **The probe.** By default the type checker runs and its errors are compared
   against the pre-fix inventory. `--verify-command` runs after that, on the
   candidate text, and must exit 0.
6. **Bisection.** A red probe rolls the whole campaign back and bisects the
   first pass to the fix that broke it. That fix is held back with the error it
   would have introduced, and the loop tries again without it. A fix the editor
   refuses gets the same treatment without the bisection — it names itself by
   throwing — so one impossible edit never takes the run down with it.
7. **The manifest.** `--fix-unsafe` edits `package.json` after the campaign, not
   inside it: no type check reads a manifest, so the campaign's probe has
   nothing to say about these edits. When `--verify-command` is set it runs once
   more with the manifest applied, and a red result holds the manifest edits
   back on their own — the verified source fixes still land.
8. **Writing.** Only now, and only the files a verified result touched. With
   `--dry-run`, this step prints a unified diff instead.

## What a fix is allowed to leave behind

A fix finishes the finding it acts on, or refuses it:

- A **dead** member, export, or type is removed whole, with the import and
  export specifiers that forwarded it, the comment lines directly above it,
  and the comment beside it on its line. A comment with code after it on the
  line introduces that code and stays.
- A **proven write-only** member is removed together with the writes that
  prove it, with any local whose last reader those writes were, and with the
  dependency entries that named that local — `useMemo(() => ({ track }),
  [track])` loses all three. That removes computations: whatever the write
  itself computed in place, and whatever the local's initializer did, goes
  with them, side effects included. That is what `--fix-unsafe` means, and
  what `--verify-command` is for. When one of the writes cannot be removed on
  its own — a spread carries members beyond this one — the whole finding is
  kept and the write is named on stderr.
- **Prose is never edited.** A comment that survived next to a fix is listed
  as a location to reread.
- A **`package.json` entry** is retired or relocated as text, so the key order,
  the indentation, and everything the edit does not name survive. An entry that
  does not sit on a line of its own is refused and named, because these edits
  move whole lines.
- **Files, namespace findings, and emptied types** are never fixed. Nor are
  `test-only` findings: the fix is deleting the tests too, and only you do that.

## Combinations worth knowing

| Combination | What happens |
|---|---|
| `--fix-unsafe` | Implies `--fix`. Never needs it spelled out |
| `--fix --dry-run` | Prints the diff, writes nothing, skips the dirty check. Exit code 1 |
| `--fix --no-verify` | No type check. Fixes are written as applied — the one mode where an unverified edit reaches disk |
| `--no-verify --verify-command "npm test"` | The type check is skipped, your command still runs and still gates the write |
| `--fix --verify-command "npm test"` | Both probes, type check first. The only way to catch runtime-only reads of a deleted member — and the only probe that can judge a `package.json` edit |
| `--fix` with a baseline file | Fixes new findings only. Baselined ones stay untouched |
| `--baseline --fix` | The baseline wins: the file is written, nothing is fixed |
| `--baseline --ratchet` | `--baseline` rewrites the file from scratch, so `--ratchet` has nothing to drop |
| `--ratchet` with no baseline file | Does nothing |
| `--fix --only members` | Fixes members only. `--only` prunes the analysis, so the other kinds are never even found |
| `--scope <path>` with a stranded handler | The handler is reported only when it lives under the scope. The note on the in-scope wrapper still names its file and line |
| `--fix` with an over-exported bridge wrapper | Nothing is stranded. The keyword goes, the declaration stays, and every sender inside it keeps sending |
| `--production --fix` | Refused. Exit code 2: a production finding may be alive in the tests the run ignored |
| `--production --baseline` | Fine. A baseline of the strict cut is a useful thing to hold |
| `--watch --fix` / `--watch --baseline` | Refused. Exit code 2 |
| `--dry-run` without `--fix` | Refused. Exit code 2 |
| `--fix` on a dirty tree | Refused unless `--allow-dirty` or `--dry-run`. Exit code 2 |

## Exit codes

| Code | When |
|---|---|
| 0 | No findings; or a baseline was written; or `--fix` ran and saved |
| 1 | Findings remain; a `--dry-run` had changes to show; verification failed with no culprit to isolate |
| 2 | A usage error: bad flag combination, unreadable config, missing tsconfig, dirty tree, unknown command |

`norefs init` and `norefs entries` report, they do not judge: both exit 0
whenever they ran, however many entry points there were.

Code 1 on a run that found something is what linters do, and what norefs has
always done. A test pins all three codes, so they cannot change without saying
so here first. If you script norefs and want the findings without the failure,
read the `json` reporter's output and ignore the code.

## Where the output goes

The report goes to **stdout** — that is the part a reporter formats and a
pipeline consumes. Everything else goes to **stderr**: unresolved-import
warnings, baseline counts, held-back fixes, kept comments, stranded far sides,
and the `Verified` line. A `--dry-run` diff goes to stdout, its summary to
stderr.
