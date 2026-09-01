import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import v8 from 'node:v8';
import type { Project } from 'ts-morph';
import { applyBaseline, writeBaseline } from './baseline';
import { CONFIG_FILE, initConfig, loadConfig } from './config';
import { analyze, needsMembers } from './engine/analyze';
import { findConfigProblems, findUnresolvedImports } from './engine/diagnostics';
import { runFixCampaign } from './engine/fix-campaign';
import { loadPackages, loadProject, optionsForDir } from './engine/project';
import { formatGitHub, formatJson, formatMarkdown, formatSarif, formatText } from './engine/report';
import { analyzeSyntax, isSyntaxOnly, listEntryPoints } from './engine/syntax-analyze';
import { watchProject } from './engine/watch';
import { findWorkspace } from './engine/workspaces';
import type { FilterOptions } from './filters';
import { applyFilters, parseKinds } from './filters';
import { CliError, fail, firstLine, HELP } from './messages';
import type { Finding } from './types';

// norefs-ignore: the test suite imports it, outside this tsconfig
export function parseCli(args?: string[]) {
  return parseArgs({
    // parseArgs reads process.argv when no list is passed; tests pass one.
    ...(args === undefined ? {} : { args }),
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
    // The `--no-*` negations the help text documents. The option landed in
    // Node 22.4, which is why "engines" asks for it.
    allowNegative: true,
  });
}

type CliValues = ReturnType<typeof parseCli>['values'];

/** One validation voice for every flag that picks a name from a table. */
function pick<T>(table: Record<string, T>, name: string, source: string): T {
  const found = table[name];
  if (found === undefined) {
    throw new CliError(`${source} must be one of ${Object.keys(table).join(', ')}, got "${name}"`);
  }
  return found;
}

const REPORTERS: Record<string, (findings: Finding[], cwd: string, explain: boolean) => string> = {
  text: formatText,
  json: formatJson,
  github: formatGitHub,
  sarif: formatSarif,
};

const EXPORTS: Record<
  string,
  { fileName: string; format: (findings: Finding[], cwd: string, explain: boolean) => string }
> = {
  md: { fileName: 'norefs-findings.md', format: formatMarkdown },
  json: { fileName: 'norefs-findings.json', format: formatJson },
};

/** Everything one run resolved once: the merged options, and the lazy project behind them. */
interface Session {
  values: CliValues;
  cwd: string;
  tsConfigPaths: string[];
  analyzeOptions: Parameters<typeof analyze>[1];
  project(): Project;
  entryOptions(): Parameters<typeof listEntryPoints>[1];
  runAnalysis(): Finding[];
  warnUnresolved(): void;
  printReport(findings: Finding[], baseline: ReturnType<typeof applyBaseline>): void;
}

export function main(): void {
  let parsed: ReturnType<typeof parseCli>;
  try {
    parsed = parseCli();
  } catch (error) {
    // An unknown flag or one missing its value is a usage error like any
    // other, and it used to arrive as a stack trace from inside node:util.
    fail(firstLine(error));
    return;
  }
  const { values, positionals } = parsed;

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  if (values['fix-unsafe']) values.fix = true;

  const command = positionals[0];
  const COMMANDS = ['init', 'entries'];
  if (command !== undefined && !COMMANDS.includes(command)) {
    fail(`unknown command "${command}" (the commands are ${COMMANDS.join(', ')})`);
    return;
  }

  // One boundary for everything below: a malformed tsconfig, a ts-morph
  // failure mid-analysis, an unwritable export file. Whatever escapes arrives
  // in the CLI's own voice — never as a stack trace — and exits 2, the same
  // answer a usage error gets.
  try {
    if (command === 'init') {
      const fileName = initConfig(process.cwd());
      process.stderr.write(`Wrote ${fileName}\n`);
      return;
    }
    const session = createSession(values, process.cwd());
    if (command === 'entries') listEntries(session);
    else if (values.baseline) runBaseline(session);
    else if (values.watch) runWatch(session);
    else runOnce(session);
  } catch (error) {
    fail(error instanceof CliError ? error.message : firstLine(error));
  }
}

/** Merge the flags with the config file, validate the combination, and load nothing yet. */
// norefs-ignore: the test suite imports it, outside this tsconfig
export function createSession(values: CliValues, cwd: string): Session {
  const exporter = values.export === undefined ? undefined : pick(EXPORTS, values.export, '--export');

  if (values['dry-run'] && !values.fix) throw new CliError('--dry-run requires --fix');

  if (values.watch && (values.fix || values.baseline)) {
    throw new CliError('--watch cannot combine with --fix or --baseline');
  }

  const config = loadConfig(cwd);
  const kindNames = values.only && values.only.length > 0 ? values.only : (config.only ?? []);
  const filterOptions: FilterOptions = {
    anonymous: values.anon ?? config.anon,
    only: kindNames.length > 0 ? parseKinds(kindNames) : undefined,
    ignore: config.ignore,
    cwd,
  };

  // A production finding is dead to the shipping code path and may be alive in
  // the tests this run did not look at. Deleting it breaks them — which is the
  // same reason a `test-only` finding is never fixed either. This asks about
  // the flags alone, so it answers before anything about the tree does: a
  // combination that cannot work says so whether or not the tree is clean.
  const production = values.production ?? config.production;
  if (production && values.fix) {
    throw new CliError(
      '--production cannot combine with --fix. Its findings are dead to production and may still be used by the tests this run ignored.'
    );
  }

  // Fixes written into a dirty tree cannot be reviewed or reverted apart
  // from the user's own edits, so --fix wants a clean slate.
  if (values.fix && !values['dry-run'] && !values['allow-dirty']) {
    const tree = uncommittedChanges(cwd);
    if (tree === 'dirty') {
      throw new CliError(
        'the working tree has uncommitted changes. Commit or stash them so the fixes stay separable, or pass --allow-dirty.'
      );
    }
    // The guard exists so fixes stay separable from the user's own edits.
    // When git cannot answer, staying silent would defeat it silently too.
    if (tree === 'unknown') {
      process.stderr.write(
        'warning: git could not check this tree for uncommitted changes, so the fixes will not be separable from your own edits.\n'
      );
    }
  }

  // A flag that was passed wins; otherwise the project's own answer stands.
  // `--no-anon` and `--no-explain` are how a run overrides a config that says
  // yes, which is why neither flag carries a default.
  const explain = values.explain ?? config.explain;
  const reporterName = values.reporter ?? config.reporter ?? 'text';
  const reporterSource = values.reporter === undefined ? `"reporter" in ${CONFIG_FILE}` : '--reporter';
  const reporter = pick(REPORTERS, reporterName, reporterSource);

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
    const hint =
      workspace === undefined && cliProjects.length === 0 && config.project.length === 0
        ? '\nPass one with --project, or run norefs from a directory that has a tsconfig.json.'
        : '';
    throw new CliError(`no tsconfig at ${named}${hint}`);
  }
  // A config that holds no files, or one whose `extends` target is missing,
  // makes every answer below meaningless — and both report as a clean run.
  for (const problem of findConfigProblems(tsConfigPaths)) {
    process.stderr.write(`warning: ${problem}\n\n`);
  }
  const packages = loadPackages(tsConfigPaths);

  // Loading the project parses every file and builds a type checker: seconds
  // and gigabytes. A run that only asks for unused files or dependencies never
  // needs one, so the load waits until something actually asks for types.
  let loaded: Project | undefined;
  const project = (): Project => {
    if (!loaded) {
      loaded = loadProject(tsConfigPaths);
      warnMemory(loaded, filterOptions.only);
    }
    return loaded;
  };

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
  // A path nobody can find filters everything out, and the run then reports
  // success with zero findings — the quietest way a tool can be wrong. Both
  // settings say the same thing about a typo as the tsconfig check above.
  const missingPaths = [
    ...(scopeDir !== undefined && !fs.existsSync(scopeDir) ? [`--scope ${scope}`] : []),
    ...entries.filter(entry => !fs.existsSync(entry)).map(entry => `--entry ${path.relative(cwd, entry) || entry}`),
  ];
  if (missingPaths.length > 0) throw new CliError(`no such path: ${missingPaths.join(', ')}`);

  const rootDirs = [...new Set(tsConfigPaths.map(p => path.dirname(p)))];
  // tsConfigPaths always holds at least the ./tsconfig.json fallback by now.
  const primaryRootDir = rootDirs[0] as string;
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
    cwd,
  };

  const entryOptions = (): Parameters<typeof listEntryPoints>[1] => optionsForDir(packages, primaryRootDir) ?? {};

  const runAnalysis = (): Finding[] => {
    const findings = syntaxOnly
      ? analyzeSyntax(tsConfigPaths, entryOptions(), analyzeOptions)
      : analyze(project(), analyzeOptions);
    return applyFilters(findings, filterOptions);
  };

  const printReport = (findings: Finding[], baseline: ReturnType<typeof applyBaseline>): void => {
    process.stdout.write(reporter(findings, cwd, explain));
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

    if (exporter) {
      fs.writeFileSync(path.join(cwd, exporter.fileName), `${exporter.format(findings, cwd, explain)}\n`);
      process.stderr.write(`Wrote ${exporter.fileName}\n`);
    }
  };

  return {
    values,
    cwd,
    tsConfigPaths,
    analyzeOptions,
    project,
    entryOptions,
    runAnalysis,
    warnUnresolved,
    printReport,
  };
}

function listEntries(session: Session): void {
  const found = listEntryPoints(session.tsConfigPaths, session.entryOptions(), session.analyzeOptions);
  for (const entry of found) {
    process.stdout.write(`${path.relative(session.cwd, entry.filePath)}  —  ${entry.source}\n`);
  }
  process.stderr.write(
    found.length === 0
      ? 'No entry points. Every file will be reported unused; name one with --entry.\n'
      : `${found.length} entry point(s). Their exports are public API and never reported unused.\n`
  );
}

function runBaseline(session: Session): void {
  session.warnUnresolved();
  const findings = session.runAnalysis();
  const fileName = writeBaseline(findings, session.cwd);
  process.stderr.write(`Wrote ${fileName} with ${findings.length} finding(s)\n`);
}

function runWatch(session: Session): void {
  // The loop must survive anything a re-run can throw (a broken tsconfig
  // save, an invalid baseline file): report the error and keep watching.
  const report = (): void => {
    try {
      session.warnUnresolved();
      let findings = session.runAnalysis();
      const baseline = applyBaseline(findings, session.cwd);
      if (baseline) findings = baseline.fresh;
      session.printReport(findings, baseline);
    } catch (error) {
      process.stderr.write(`error: ${error instanceof CliError ? error.message : firstLine(error)}\n`);
    }
    process.stderr.write('Watching for file changes. Press Ctrl-C to stop.\n');
  };
  // Watch first, report second. The report signs off with "Watching for file
  // changes", and until the watcher exists that line promises more than the
  // process is doing: a save landing in the gap is lost, and the run sits
  // silent over a file it was asked to follow. The gap is too narrow to see
  // on a laptop and wide enough to miss an edit on a loaded machine. An edit
  // during the first analysis now queues a re-run instead of vanishing.
  watchProject(session.project(), session.tsConfigPaths, () => {
    if (process.stdout.isTTY) process.stdout.write('\x1Bc');
    report();
  });
  report();
}

function runOnce(session: Session): void {
  const { values, cwd } = session;
  session.warnUnresolved();
  let findings = session.runAnalysis();

  const baseline = applyBaseline(findings, cwd);
  if (baseline) findings = baseline.fresh;

  // The ratchet only tightens: entries whose finding vanished are dropped
  // from the baseline automatically, so the count can only go down.
  // printReport announces the drop.
  if (values.ratchet && baseline && baseline.stale > 0) {
    writeBaseline(baseline.matchedFindings, cwd);
  }

  session.printReport(findings, baseline);

  if (findings.length === 0) return;

  if (values.fix) {
    runFix(session, findings, baseline);
    return;
  }

  process.exitCode = 1;
}

function runFix(session: Session, findings: Finding[], baseline: ReturnType<typeof applyBaseline>): void {
  const { values, cwd } = session;
  // Everything happens in memory: fix to the cascade fixpoint, verify, and
  // when a fix breaks the probe, bisect to it and hold it back. Disk is
  // only touched by a verified result.
  const save = !values['dry-run'];
  const result = runFixCampaign({
    project: session.project(),
    findings,
    reanalyze: () => {
      const remaining = session.runAnalysis();
      return baseline ? (applyBaseline(remaining, cwd)?.fresh ?? remaining) : remaining;
    },
    unsafe: values['fix-unsafe'],
    verify: values.verify,
    command: values['verify-command'],
    save,
    cwd,
    log: line => {
      process.stderr.write(`${line}\n`);
    },
  });

  if (result.aborted) {
    process.stderr.write('Verification failed and no single fix could be isolated. Nothing was changed.\n');
    for (const line of result.aborted) process.stderr.write(`  ${line}\n`);
    process.exitCode = 1;
    return;
  }

  for (const patch of result.patches) process.stdout.write(`${patch}\n`);
  for (const note of result.notes) process.stderr.write(`${note}\n`);
  if (!save) process.exitCode = 1;
}

/**
 * Say before the analysis what a run this size costs, when the heap cannot
 * hold it. Running out of memory arrives as a V8 native crash the CLI cannot
 * catch or soften, so the only place to speak is before the work starts.
 *
 * The estimate is linear in project source bytes, fitted to profiled runs of
 * 0.3, 1.1, and 8.9 MB of source (which needed roughly 0.3, 0.5, and 3.1 GB
 * with the member analysis, and 0.1, 0.3, and 1.9 GB without). It is a
 * warning threshold, not a promise — it only has to be right about the order
 * of magnitude.
 */
function warnMemory(project: Project, kinds: Parameters<typeof needsMembers>[0]): void {
  let sourceBytes = 0;
  for (const sourceFile of project.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile()) sourceBytes += sourceFile.compilerNode.text.length;
  }
  const sourceMB = sourceBytes / (1024 * 1024);
  const estimateMB = needsMembers(kinds) ? 200 + 330 * sourceMB : 130 + 200 * sourceMB;
  const limitMB = v8.getHeapStatistics().heap_size_limit / (1024 * 1024);
  if (estimateMB <= limitMB) return;
  process.stderr.write(
    `warning: ${Math.round(sourceMB)} MB of source against a ${Math.round(limitMB)} MB heap — this run is likely to run out of memory (it needs roughly ${Math.round(estimateMB / 100) / 10} GB).\n` +
      'Give Node more with NODE_OPTIONS=--max-old-space-size=8192, or ask for less with --only.\n\n'
  );
}

/**
 * Whether this tree has uncommitted changes — or 'unknown' when git itself
 * could not answer: no git on the PATH, or no repository here.
 */
function uncommittedChanges(cwd: string): 'clean' | 'dirty' | 'unknown' {
  const run = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
  if (run.error || run.status !== 0) return 'unknown';
  return run.stdout.trim().length > 0 ? 'dirty' : 'clean';
}
