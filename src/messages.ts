/**
 * The CLI's user-facing voice: the help text, the error prefix, and the shape
 * of whatever was thrown. Policy about *what* to say lives with the code that
 * knows it; how it reaches the user is decided here, once.
 */

export const HELP = `norefs - find unused files, exports, and properties in a TypeScript project

Usage: norefs [options]
       norefs init            Write a norefs.config.json with every option at its default
       norefs entries         List every entry point and what named it

Options:
  -p, --project <path>  Path to tsconfig.json. Repeatable: every package
                         resolves its imports with its own tsconfig's compiler
                         options. Rarely needed in a workspace — norefs reads
                         the packages from pnpm-workspace.yaml or the
                         package.json "workspaces" list. Default: ./tsconfig.json
  --scope <path>         Only report findings declared under this path
                         (still uses the whole project to resolve usages —
                         handy when a tsconfig spans an SDK and its consumer)
  --entry <path>         Treat this file or directory as an entry point: it is
                         never reported unused and its exports are the public
                         API. Repeatable, and rarely needed: norefs already
                         reads the entry points your build declares — see
                         \`norefs entries\` for the list and where each came from
  --only <kinds>         Report only these finding kinds, comma-separated:
                         files, exports, types, ns-exports, ns-types, members,
                         empty-types, dependencies, unlisted, misplaced,
                         stranded.
                         This prunes the analysis, it does not filter its
                         output: asking for files and dependencies alone
                         skips the type checker, and leaving members out
                         skips the costliest half of what is left
  --reporter <name>      Output format: text (default), json, github (workflow
                         commands that annotate pull requests), sarif
  --baseline             Write the findings to norefs-baseline.json and exit;
                         when that file exists, later runs report and fail on
                         new findings only
  --export <md|json>     Also write findings to norefs-findings.md or norefs-findings.json.
                         An export is a file for reading later, not a reporter
                         for a pipe — which is why markdown lives here and not
                         in --reporter
  --fix                  Apply the fixes the verdicts prove safe: dead code is
                         removed, over-exported declarations lose the export
                         keyword
  --fix-unsafe           Also apply write-only, contract, and shadowed findings,
                         and edit package.json (implies --fix). A proven write-only member is retired
                         together with the writes that prove it; when one of
                         those writes cannot be removed on its own, the whole
                         finding is kept and the write is named. These are
                         claims the analysis cannot prove — review the diff
  --no-verify            Skip the check after --fix. By default norefs
                         type-checks in memory, holds back any fix that breaks
                         the build, and saves only what verifies
  --verify-command <cmd> A command that must exit 0 for the fixes to count
                         (your test suite, say). Runs after the type check
                         passes; a fix that fails it is held back too
  --allow-dirty          Let --fix write into a tree with uncommitted changes.
                         By default it refuses, so the fixes stay separable
                         from your own edits
  --ratchet              With a baseline: drop entries whose finding vanished,
                         so the baseline count can only go down
  --dry-run              With --fix: print the would-be changes as a unified
                         diff without writing any file
  --watch                Re-run on save: keep the loaded project in memory,
                         refresh the changed files, and report again
                         (tsconfig and norefs.config.json changes need a restart)
  --explain              Append each finding's evidence chain: what was
                         searched, what was found, why the verdict
  --anon                 Include findings on unnamed inline types and anonymous
                         functions. Hidden by default: with no name to anchor
                         them, they are the most false-positive-prone
  --production           Analyze the shipping code path alone. Test, spec,
                         stories, bench and config files are treated as absent:
                         they keep nothing reachable, they count as no usage,
                         and they report nothing. Stricter than the test-only
                         verdict, and never combined with --fix
  -h, --help             Show this help message

Configuration:
  norefs reads norefs.config.json from the current directory when it exists.
  It holds the settings — what shapes the analysis and the report, true of the
  project every run. It never holds an action: --fix, --fix-unsafe, --baseline,
  --ratchet, --dry-run, --export and --watch each write something, and you ask
  for those per run.
    { "project": "…"|[…], "entry": […], "ignore": ["globs"],
      "only": […], "ignoreDependencies": ["names or globs"],
      "scope": "path", "reporter": "text|json|github|sarif",
      "boundaries": [{ "send": ["fetch"], "handle": ["app.get"] }],
      "anon": false, "explain": false, "production": false }
  A flag passed on the run wins over the file; entries merge. --no-anon,
  --no-explain and --no-production are how a run says no to a project that
  said yes.
  "boundaries" is the one setting with no flag of its own: it names the callees
  that send on a channel and the ones that register a handler for it, which
  extends the stranded-handler check past the Electron-shaped bridge norefs
  finds unaided. "norefs init" writes the whole list out with its defaults.

Suppressing findings:
  // norefs-ignore [reason]        on the reported line or the line above
  // norefs-ignore-block [reason]  on a declaration, or above it: covers that
                                   declaration and every finding inside it
  // norefs-ignore-file            before the first statement of a file

Exit codes:
  0  no findings
  1  findings were reported, or --dry-run printed would-be changes
  2  a usage or project error
`;

/**
 * An error whose whole text is written for the user — a usage mistake with a
 * hint on its second line. The top-level boundary prints it in full, where an
 * unexpected throw gets only its first line.
 */
export class CliError extends Error {}

/** Report an error in the CLI's one error voice, and make the run exit 2. */
export function fail(message: string): void {
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 2;
}

/**
 * The first line of whatever was thrown.
 *
 * Two reasons for the trim: a ts-morph error carries a whole dump after its
 * first line, and a throw is not always an Error — reading `.message` off a
 * thrown string prints `undefined`, which tells the user nothing.
 */
export function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const [first = ''] = message.split('\n');
  return first.trim();
}
