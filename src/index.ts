#!/usr/bin/env node
import './compile-cache';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { Project } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import { applyBaseline, writeBaseline } from './baseline';
import { CONFIG_FILE, initConfig, loadConfig } from './config';
import { analyze } from './engine/analyze';
import { findUnresolvedImports } from './engine/diagnostics';
import { isFixable, unremovableWrites } from './engine/fix';
import { editManifest, manifestEdits } from './engine/fix-manifest';
import { applyVerifiedFixes, findingKey } from './engine/fix-verified';
import { loadPackages, loadProject, optionsForDir } from './engine/project';
import { formatGitHub, formatJson, formatMarkdown, formatPatch, formatSarif, formatText } from './engine/report';
import { analyzeSyntax, isSyntaxOnly, listEntryPoints } from './engine/syntax-analyze';
import { formatLocation } from './engine/verdicts';
import { watchProject } from './engine/watch';
import { findWorkspace } from './engine/workspaces';
import type { FilterOptions } from './filters';
import { applyFilters, parseKinds } from './filters';
import type { Finding } from './types';

const HELP = `norefs - find unused files, exports, and properties in a TypeScript project

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
  --export <md|json>     Also write findings to norefs-findings.md or norefs-findings.json
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
  project every run. It never holds an action: --fix, --baseline, --dry-run,
  --export and --watch each write something, and you ask for those per run.
    { "project": "…"|[…], "entry": […], "ignore": ["globs"],
      "only": […], "ignoreDependencies": ["names or globs"],
      "scope": "path", "reporter": "text|json|github|sarif",
      "anon": false, "explain": false }
  A flag passed on the run wins over the file; entries merge. --no-anon and
  --no-explain are how a run says no to a project that said yes.

Suppressing findings:
  // norefs-ignore [reason]        on the reported line or the line above
  // norefs-ignore-block [reason]  on a declaration, or above it: covers that
                                   declaration and every finding inside it
  // norefs-ignore-file            before the first statement of a file
`;

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: 'string', short: 'p', multiple: true },
      scope: { type: 'string' },
      entry: { type: 'string', multiple: true },
      only: { type: 'string', multiple: true },
      // The settings the config file can also carry take no default here: an
      // unset flag has to stay distinguishable from one passed at its default,
      // or the flag would silently outrank the config on every run.
      reporter: { type: 'string' },
      baseline: { type: 'boolean', default: false },
      export: { type: 'string' },
      fix: { type: 'boolean', default: false },
      'fix-unsafe': { type: 'boolean', default: false },
      verify: { type: 'boolean', default: true },
      'verify-command': { type: 'string' },
      'allow-dirty': { type: 'boolean', default: false },
      explain: { type: 'boolean' },
      ratchet: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      watch: { type: 'boolean', default: false },
      anon: { type: 'boolean' },
      production: { type: 'boolean' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowNegative: true,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  if (values['fix-unsafe']) values.fix = true;

  const command = positionals[0];
  const COMMANDS = ['init', 'entries'];
  if (command !== undefined && !COMMANDS.includes(command)) {
    process.stderr.write(`error: unknown command "${command}" (the commands are ${COMMANDS.join(', ')})\n`);
    process.exitCode = 2;
    return;
  }

  if (command === 'init') {
    try {
      const fileName = initConfig(process.cwd());
      process.stderr.write(`Wrote ${fileName}\n`);
    } catch (error) {
      process.stderr.write(`error: ${(error as Error).message}\n`);
      process.exitCode = 2;
    }
    return;
  }

  if (values.export !== undefined && values.export !== 'md' && values.export !== 'json') {
    process.stderr.write(`error: --export must be "md" or "json", got "${values.export}"\n`);
    process.exitCode = 2;
    return;
  }

  if (values['dry-run'] && !values.fix) {
    process.stderr.write('error: --dry-run requires --fix\n');
    process.exitCode = 2;
    return;
  }

  if (values.watch && (values.fix || values.baseline)) {
    process.stderr.write('error: --watch cannot combine with --fix or --baseline\n');
    process.exitCode = 2;
    return;
  }

  const cwd = process.cwd();
  let config: ReturnType<typeof loadConfig>;
  let filterOptions: FilterOptions;
  try {
    config = loadConfig(cwd);
    const kindNames = values.only && values.only.length > 0 ? values.only : (config.only ?? []);
    filterOptions = {
      anonymous: values.anon ?? config.anon,
      only: kindNames.length > 0 ? parseKinds(kindNames) : undefined,
      ignore: config.ignore,
      cwd,
    };
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n`);
    process.exitCode = 2;
    return;
  }

  // A production finding is dead to the shipping code path and may be alive in
  // the tests this run did not look at. Deleting it breaks them — which is the
  // same reason a `test-only` finding is never fixed either. This asks about
  // the flags alone, so it answers before anything about the tree does: a
  // combination that cannot work says so whether or not the tree is clean.
  const production = values.production ?? config.production;
  if (production && values.fix) {
    process.stderr.write(
      'error: --production cannot combine with --fix. Its findings are dead to production and may still be used by the tests this run ignored.\n'
    );
    process.exitCode = 2;
    return;
  }

  // Fixes written into a dirty tree cannot be reviewed or reverted apart
  // from the user's own edits, so --fix wants a clean slate.
  if (values.fix && !values['dry-run'] && !values['allow-dirty'] && hasUncommittedChanges(cwd)) {
    process.stderr.write(
      'error: the working tree has uncommitted changes. Commit or stash them so the fixes stay separable, or pass --allow-dirty.\n'
    );
    process.exitCode = 2;
    return;
  }

  // A flag that was passed wins; otherwise the project's own answer stands.
  // `--no-anon` and `--no-explain` are how a run overrides a config that says
  // yes, which is why neither flag carries a default.
  const explain = values.explain ?? config.explain;
  const reporterName = values.reporter ?? config.reporter ?? 'text';
  const reporters = {
    text: (f: Finding[], c: string) => formatText(f, c, explain),
    json: formatJson,
    github: formatGitHub,
    sarif: formatSarif,
  };
  const reporter = reporters[reporterName as keyof typeof reporters];
  if (!reporter) {
    const source = values.reporter === undefined ? `"reporter" in ${CONFIG_FILE}` : '--reporter';
    process.stderr.write(
      `error: ${source} must be one of ${Object.keys(reporters).join(', ')}, got "${reporterName}"\n`
    );
    process.exitCode = 2;
    return;
  }

  const cliProjects = values.project ?? [];
  const tsConfigPaths = (cliProjects.length > 0 ? cliProjects : config.project).map(p => path.resolve(cwd, p));
  // A monorepo already says where its packages are. Only when nothing was
  // asked for: a list you passed is the list you meant.
  const workspace = tsConfigPaths.length === 0 ? findWorkspace(cwd) : undefined;
  if (workspace) {
    tsConfigPaths.push(...workspace.tsConfigPaths);
    // Which packages a run covers decides what every finding means, so a run
    // that decided it for you says so.
    const missing = workspace.withoutTsConfig;
    process.stderr.write(
      `${workspace.tsConfigPaths.length} workspace package(s) from ${workspace.source}` +
        `${missing.length > 0 ? `; skipped ${missing.join(', ')} — no tsconfig.json` : ''}\n`
    );
  }
  if (tsConfigPaths.length === 0) tsConfigPaths.push(path.resolve(cwd, 'tsconfig.json'));

  const unreadable = tsConfigPaths.filter(p => !fs.existsSync(p));
  if (unreadable.length > 0) {
    // A tsconfig nobody can read is a usage error like any other, and the flag
    // reference says so. It used to arrive as a stack trace from inside ts.
    const named = unreadable.map(p => path.relative(cwd, p) || p).join(', ');
    process.stderr.write(
      `error: no tsconfig at ${named}\n` +
        (workspace === undefined && cliProjects.length === 0 && config.project.length === 0
          ? 'Pass one with --project, or run norefs from a directory that has a tsconfig.json.\n'
          : '')
    );
    process.exitCode = 2;
    return;
  }
  const packages = loadPackages(tsConfigPaths);

  // Loading the project parses every file and builds a type checker: seconds
  // and gigabytes. A run that only asks for unused files or dependencies never
  // needs one, so the load waits until something actually asks for types.
  let loaded: Project | undefined;
  const project = (): Project => (loaded ??= loadProject(tsConfigPaths));

  // Unused files and the dependency checks read the source text alone. When
  // nothing else is asked for, the syntax scanner answers them and the type
  // checker is never built.
  const syntaxOnly = isSyntaxOnly(filterOptions.only) && !values.fix && !values.watch;

  const warnUnresolved = (): void => {
    // The warning is about references going missing, which a syntax-only run
    // never looks for — and asking would build the very program it skipped.
    if (syntaxOnly) return;
    const unresolved = findUnresolvedImports(project());
    if (unresolved.length === 0) return;
    const examples = unresolved.slice(0, 5).join(', ');
    const more = unresolved.length > 5 ? ', …' : '';
    process.stderr.write(
      `warning: ${unresolved.length} import specifier(s) do not resolve (${examples}${more}).\n` +
        `References through them are invisible, so used properties may be reported as unused.\n` +
        `Check the tsconfig "paths" and "include" settings.\n\n`
    );
  };

  const scope = values.scope ?? config.scope;
  const scopeDir = scope ? path.resolve(cwd, scope) : undefined;
  const entries = [...config.entry, ...(values.entry ?? [])].map(entry => path.resolve(cwd, entry));
  const rootDirs = [...new Set(tsConfigPaths.map(p => path.dirname(p)))];
  // The kinds go to the analysis, not only to the filter: knowing that no
  // member finding is wanted lets it skip the member analysis outright.
  const analyzeOptions = {
    scopeDir,
    entries,
    rootDirs,
    packages,
    ignoreDependencies: config.ignoreDependencies,
    boundaries: config.boundaries,
    production,
    kinds: filterOptions.only,
  };
  if (command === 'entries') {
    const found = listEntryPoints(tsConfigPaths, optionsForDir(packages, rootDirs[0]) ?? {}, analyzeOptions);
    for (const entry of found) {
      process.stdout.write(`${path.relative(cwd, entry.filePath)}  —  ${entry.source}\n`);
    }
    process.stderr.write(
      found.length === 0
        ? 'No entry points. Every file will be reported unused; name one with --entry.\n'
        : `${found.length} entry point(s). Their exports are public API and never reported unused.\n`
    );
    return;
  }

  const runAnalysis = (): Finding[] => {
    const findings = syntaxOnly
      ? analyzeSyntax(tsConfigPaths, optionsForDir(packages, rootDirs[0]) ?? {}, analyzeOptions)
      : analyze(project(), analyzeOptions);
    return applyFilters(findings, filterOptions);
  };

  const printReport = (findings: Finding[], baseline: ReturnType<typeof applyBaseline>): void => {
    process.stdout.write(reporter(findings, cwd));
    process.stdout.write('\n');

    if (baseline) {
      process.stderr.write(`Baseline: ${baseline.matched} finding(s) matched and were not reported\n`);
      if (baseline.stale > 0) {
        process.stderr.write(
          values.ratchet
            ? `Ratchet: dropped ${baseline.stale} stale entr${baseline.stale === 1 ? 'y' : 'ies'} from the baseline\n`
            : `${baseline.stale} baseline finding(s) no longer occur — run norefs --baseline to refresh the file\n`
        );
      }
    }

    if (values.export) {
      const fileName = values.export === 'md' ? 'norefs-findings.md' : 'norefs-findings.json';
      const content = values.export === 'md' ? formatMarkdown(findings, cwd, explain) : formatJson(findings, cwd);
      fs.writeFileSync(path.join(cwd, fileName), `${content}\n`);
      process.stderr.write(`Wrote ${fileName}\n`);
    }
  };

  if (values.baseline) {
    warnUnresolved();
    const findings = runAnalysis();
    const fileName = writeBaseline(findings, cwd);
    process.stderr.write(`Wrote ${fileName} with ${findings.length} finding(s)\n`);
    return;
  }

  if (values.watch) {
    // The loop must survive anything a re-run can throw (a broken tsconfig
    // save, an invalid baseline file): report the error and keep watching.
    const report = (): void => {
      try {
        warnUnresolved();
        let findings = runAnalysis();
        const baseline = applyBaseline(findings, cwd);
        if (baseline) findings = baseline.fresh;
        printReport(findings, baseline);
      } catch (error) {
        process.stderr.write(`error: ${(error as Error).message}\n`);
      }
      process.stderr.write('Watching for file changes. Press Ctrl-C to stop.\n');
    };
    report();
    watchProject(project(), tsConfigPaths, () => {
      if (process.stdout.isTTY) process.stdout.write('\x1Bc');
      report();
    });
    return;
  }

  warnUnresolved();
  let findings = runAnalysis();

  let baseline: ReturnType<typeof applyBaseline>;
  try {
    baseline = applyBaseline(findings, cwd);
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  if (baseline) findings = baseline.fresh;

  // The ratchet only tightens: entries whose finding vanished are dropped
  // from the baseline automatically, so the count can only go down.
  // printReport announces the drop.
  if (values.ratchet && baseline && baseline.stale > 0) {
    writeBaseline(baseline.matchedFindings, cwd);
  }

  printReport(findings, baseline);

  if (findings.length === 0) return;

  if (values.fix) {
    // Everything happens in memory: fix to the cascade fixpoint, verify, and
    // when a fix breaks the probe, bisect to it and hold it back. Disk is
    // only touched by a verified result.
    const save = !values['dry-run'];
    const unsafe = values['fix-unsafe'];
    const verify = values.verify && findings.some(f => isFixable(f, unsafe));
    const command = values['verify-command'];

    // A fix finishes the finding it acts on or says why it can't. Read before
    // the first edit, so the coordinates are the ones the report printed.
    const refusals = unsafe
      ? findings.flatMap(finding => {
          const stuck = unremovableWrites(finding);
          if (stuck.length === 0) return [];
          const where = stuck
            .map(site => {
              const at = formatLocation(site.getSourceFile().getFilePath(), site.getStartLineNumber(), cwd);
              return site.isKind(SyntaxKind.SpreadAssignment)
                ? `the spread at ${at}, which carries members beyond this one,`
                : `the write at ${at}`;
            })
            .join(' and ');
          const at = formatLocation(finding.filePath, finding.line, cwd);
          return [`Kept \`${finding.name}\` (${at}): ${where} is why this isn't safe — removing it is yours to do`];
        })
      : [];
    // Counted here for the same reason: a fix the verify loop rolled back
    // leaves the findings it touched holding nodes the project has forgotten.
    const skipped = findings.filter(f => !isFixable(f, unsafe)).length;

    // "Verified" must not claim more than the probe can see: de-exporting is
    // compiler-checkable, but a deleted member can have runtime-only readers
    // (an identity-tracked context value, an inference-typed producer) that no
    // type check reaches — and a retired write takes a computation with it
    // that no type check weighs. Say so unless the user's own command also ran.
    const memberFixes = findings.some(f => f.kind === 'member' && isFixable(f, unsafe));
    const writeFixes = findings.some(f => (f.writeSites?.length ?? 0) > 0 && isFixable(f, unsafe));
    const blindSpot = writeFixes
      ? 'runtime-only reads of a deleted member, and it does not weigh what the writes deleted with it were doing'
      : 'runtime-only reads of deleted members';

    const result = applyVerifiedFixes({
      project: project(),
      findings,
      reanalyze: () => {
        const remaining = runAnalysis();
        return baseline ? (applyBaseline(remaining, cwd)?.fresh ?? remaining) : remaining;
      },
      unsafe,
      verify,
      check: command ? commandCheck(command, cwd) : undefined,
      cwd,
      log: line => process.stderr.write(`${line}\n`),
    });

    if (result.aborted) {
      process.stderr.write('Verification failed and no single fix could be isolated. Nothing was changed.\n');
      for (const line of result.aborted) process.stderr.write(`  ${line}\n`);
      process.exitCode = 1;
      return;
    }

    for (const { finding, errors, unapplied } of result.heldBack) {
      const where = `${path.relative(cwd, finding.filePath)}:${finding.line}`;
      const why = unapplied ? `the edit could not be applied — ${errors[0]}` : `fixing it would introduce ${errors[0]}`;
      process.stderr.write(`Held back \`${finding.name}\` (${where}): ${why}\n`);
    }

    // Two things no probe can verify, so a human gets pointed at them: prose
    // that outlived the code it described, and the far side of a deleted
    // bridge wrapper. Comment locations were recorded against intermediate
    // pass states, so each one is re-found in the final text by its own words
    // and dropped when a later pass removed it.
    const spots: string[] = [];
    for (const kept of result.keptComments) {
      const content = project().getSourceFile(kept.filePath)?.getFullText();
      if (content === undefined) continue;
      const lines = content.split('\n');
      const line = (lines[kept.line - 1] ?? '').includes(kept.text)
        ? kept.line
        : lines.findIndex(l => l.includes(kept.text)) + 1;
      if (line === 0) continue; // the comment did not survive later passes
      const spot = formatLocation(kept.filePath, line, cwd);
      if (!spots.includes(spot)) spots.push(spot);
    }
    if (spots.length > 0) {
      process.stderr.write(
        spots.length === 1
          ? `A comment near the fixes was kept: reread ${spots[0]}\n`
          : `${spots.length} comments near the fixes were kept: reread ${spots.join(', ')}\n`
      );
    }
    for (const refusal of refusals) process.stderr.write(`${refusal}\n`);
    // Held-back findings come from a re-analysis, so they are matched by
    // content, never by object identity: a held-back wrapper was not deleted
    // and gets no stranding warning.
    const held = new Set(result.heldBack.map(h => findingKey(h.finding, cwd)));
    for (const finding of findings) {
      if (!finding.strands || !isFixable(finding, unsafe) || held.has(findingKey(finding, cwd))) continue;
      process.stderr.write(
        `\`${finding.name}\`: ${finding.strands} — no analysis will flag it once the wrapper is gone\n`
      );
    }

    // package.json is edited as text, after the campaign and outside it: no
    // type check reads a manifest, so there is nothing for the campaign's probe
    // to say about these. The command you supply is the only probe that can
    // judge them, and it gets the last word below.
    const manifests = new Map<string, string>();
    let manifestFixed = 0;
    const manifestFindings = findings.filter(f => isFixable(f, unsafe) && !held.has(findingKey(f, cwd)));
    for (const [filePath, edits] of manifestEdits(manifestFindings)) {
      const before = fs.readFileSync(filePath, 'utf8');
      const { text, refused } = editManifest(before, edits);
      for (const { name, reason } of refused) {
        process.stderr.write(`Held back \`${name}\` (${path.relative(cwd, filePath)}): ${reason}\n`);
      }
      if (text === before) continue;
      manifests.set(filePath, text);
      manifestFixed += edits.length - refused.length;
    }
    if (manifests.size > 0 && command) {
      const candidates = new Map(manifests);
      for (const filePath of result.touched) {
        const text = project().getSourceFile(filePath)?.getFullText();
        if (text !== undefined) candidates.set(filePath, text);
      }
      const errors = runOnCandidates(command, cwd, candidates);
      if (errors.length > 0) {
        process.stderr.write(`Held back the package.json edits: ${errors[0]}\n`);
        manifests.clear();
        manifestFixed = 0;
      }
    }
    const fixedCount = result.fixed + manifestFixed;
    const fileCount = result.touched.length + manifests.size;

    const verifiedLine = (fixes: string): string => {
      const unseen = [memberFixes ? blindSpot : '', manifests.size > 0 ? 'a package.json edit' : ''].filter(
        part => part.length > 0
      );
      const caveat =
        unseen.length > 0 && !command
          ? ` A type check cannot see ${unseen.join(' or ')}; add --verify-command to run your tests too.\n`
          : '\n';
      return `Verified: tsc reports no new errors after the ${fixes}.${caveat}`;
    };

    if (!save) {
      for (const filePath of [...result.touched].sort()) {
        const before = fs.readFileSync(filePath, 'utf8');
        const after = project().getSourceFile(filePath)?.getFullText() ?? before;
        process.stdout.write(`${formatPatch(path.relative(cwd, filePath), before, after)}\n`);
      }
      for (const [filePath, after] of [...manifests].sort()) {
        const before = fs.readFileSync(filePath, 'utf8');
        process.stdout.write(`${formatPatch(path.relative(cwd, filePath), before, after)}\n`);
      }
      if (verify) process.stderr.write(verifiedLine('would-be fixes'));
      process.stderr.write(`Dry run: would fix ${fixedCount} finding(s) in ${fileCount} file(s)\n`);
      process.exitCode = 1;
      return;
    }

    for (const filePath of result.touched) {
      project().getSourceFile(filePath)?.saveSync();
    }
    for (const [filePath, text] of manifests) fs.writeFileSync(filePath, text);
    if (verify) process.stderr.write(verifiedLine('fixes'));
    process.stderr.write(`Fixed ${fixedCount} finding(s) in ${fileCount} file(s)\n`);

    if (skipped > 0) {
      const untouched = unsafe
        ? 'files, namespaces, emptied types, test-only findings, proven writes no single edit can retire'
        : 'write-only, contract, shadowed, and package.json findings need --fix-unsafe; files, namespaces, emptied types, and test-only findings are never touched';
      process.stderr.write(`Skipped ${skipped} finding(s) --fix does not touch (${untouched})\n`);
    }
    return;
  }

  process.exitCode = 1;
}

/** True when this is a git tree with uncommitted changes. No git, no repo: false. */
function hasUncommittedChanges(cwd: string): boolean {
  const run = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
  return run.status === 0 && run.stdout.trim().length > 0;
}

/**
 * The --verify-command probe. An external command reads from disk, so the
 * candidate texts go to disk for the run and the originals come back before
 * the verdict — a failed probe leaves no trace.
 */
function commandCheck(command: string, cwd: string): (project: Project, dirtyFilePaths: string[]) => string[] {
  return (project, dirtyFilePaths) => {
    const candidates = new Map<string, string>();
    for (const filePath of dirtyFilePaths) {
      const text = project.getSourceFile(filePath)?.getFullText();
      if (text !== undefined) candidates.set(filePath, text);
    }
    return runOnCandidates(command, cwd, candidates);
  };
}

/** Run the command with these texts in place, and put the originals back. */
function runOnCandidates(command: string, cwd: string, candidates: Map<string, string>): string[] {
  const originals = new Map([...candidates.keys()].map(filePath => [filePath, fs.readFileSync(filePath, 'utf8')]));
  try {
    for (const [filePath, text] of candidates) fs.writeFileSync(filePath, text);
    const run = spawnSync(command, { shell: true, cwd, encoding: 'utf8' });
    if (run.status === 0) return [];
    const tail = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim().split('\n').slice(-3).join(' | ');
    return [`\`${command}\` exited with ${run.status ?? 'a signal'}: ${tail}`];
  } finally {
    for (const [filePath, text] of originals) fs.writeFileSync(filePath, text);
  }
}

main();
