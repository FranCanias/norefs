# What each flag does to your working tree

`norefs` has one flag that writes source files — `--fix` — and seven that
change what it writes, when it writes, or whether it writes at all. This page
says exactly what each one does to the tree, and what the combinations do.

One rule holds everywhere: **nothing reaches disk unless it verified.** Every
fix is applied to an in-memory copy of the project first. The files on disk
change only after the probe is green.

## The flags that touch files

| Flag | What it writes |
|---|---|
| `--fix` | Source files: dead code removed, over-exported declarations de-exported |
| `--fix-unsafe` | The same, plus write-only, contract, and shadowed findings — and the proven writes behind them |
| `--baseline` | `norefs-baseline.json` in the current directory. Never touches source |
| `--ratchet` | `norefs-baseline.json`, when entries went stale. Never touches source |
| `--export md\|json` | `norefs-findings.md` or `norefs-findings.json`. Never touches source |

Everything else — `--dry-run`, `--no-verify`, `--verify-command`,
`--allow-dirty`, `--scope`, `--only`, `--entry`, `--watch`, `--explain`,
`--anon`, `--reporter` — writes no file of its own.

## The order a fixing run happens in

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
   would have introduced, and the loop tries again without it.
7. **Writing.** Only now, and only the files a verified result touched. With
   `--dry-run`, this step prints a unified diff instead.

## What a fix is allowed to leave behind

A fix finishes the finding it acts on, or refuses it:

- A **dead** member, export, or type is removed whole, with the import and
  export specifiers that forwarded it and the comment lines directly above it.
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
- **Files, namespace findings, emptied types, and dependencies** are never
  fixed. Nor are `test-only` findings: the fix is deleting the tests too, and
  only you do that.

## Combinations worth knowing

| Combination | What happens |
|---|---|
| `--fix-unsafe` | Implies `--fix`. Never needs it spelled out |
| `--fix --dry-run` | Prints the diff, writes nothing, skips the dirty check. Exit code 1 |
| `--fix --no-verify` | No type check. Fixes are written as applied — the one mode where an unverified edit reaches disk |
| `--no-verify --verify-command "npm test"` | The type check is skipped, your command still runs and still gates the write |
| `--fix --verify-command "npm test"` | Both probes, type check first. The only way to catch runtime-only reads of a deleted member |
| `--fix` with a baseline file | Fixes new findings only. Baselined ones stay untouched |
| `--baseline --fix` | The baseline wins: the file is written, nothing is fixed |
| `--baseline --ratchet` | `--baseline` rewrites the file from scratch, so `--ratchet` has nothing to drop |
| `--ratchet` with no baseline file | Does nothing |
| `--fix --only members` | Fixes members only. `--only` prunes the analysis, so the other kinds are never even found |
| `--scope <path>` with a stranded handler | The handler is reported only when it lives under the scope. The note on the in-scope wrapper still names its file and line |
| `--watch --fix` / `--watch --baseline` | Refused. Exit code 2 |
| `--dry-run` without `--fix` | Refused. Exit code 2 |
| `--fix` on a dirty tree | Refused unless `--allow-dirty` or `--dry-run`. Exit code 2 |

## Exit codes

| Code | When |
|---|---|
| 0 | No findings; or a baseline was written; or `--fix` ran and saved |
| 1 | Findings remain; a `--dry-run` had changes to show; verification failed with no culprit to isolate |
| 2 | A usage error: bad flag combination, unreadable config, dirty tree |

## Where the output goes

The report goes to **stdout** — that is the part a reporter formats and a
pipeline consumes. Everything else goes to **stderr**: unresolved-import
warnings, baseline counts, held-back fixes, kept comments, stranded far sides,
and the `Verified` line. A `--dry-run` diff goes to stdout, its summary to
stderr.
