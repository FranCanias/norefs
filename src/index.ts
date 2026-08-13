#!/usr/bin/env node
import './compile-cache';
import fs from 'node:fs';
import type { Project } from 'ts-morph';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { applyBaseline, writeBaseline } from './baseline';
import { initConfig, loadConfig } from './config';
import { analyze } from './engine/analyze';
import { findUnresolvedImports } from './engine/diagnostics';
import { applyFixes } from './engine/fix';
import { loadPackages, loadProject, optionsForDir } from './engine/project';
import { analyzeSyntax, isSyntaxOnly } from './engine/syntax-analyze';
import { formatGitHub, formatJson, formatMarkdown, formatPatch, formatSarif, formatText } from './engine/report';
import { watchProject } from './engine/watch';
import type { FilterOptions } from './filters';
import { applyFilters, parseKinds } from './filters';
import type { Finding } from './types';

const HELP = `norefs - find unused files, exports, and properties in a TypeScript project

Usage: norefs [options]
       norefs init            Write a norefs.config.json with every option at its default

Options:
  -p, --project <path>  Path to tsconfig.json (default: ./tsconfig.json).
                         Repeatable for a monorepo: every package resolves its
                         imports with its own tsconfig's compiler options
  --scope <path>         Only report findings declared under this path
                         (still uses the whole project to resolve usages —
                         handy when a tsconfig spans an SDK and its consumer)
  --entry <path>         Treat this file or directory as an entry point: it is
                         never reported unused and its exports are the public
                         API (repeatable; index/main/cli files in the project
                         root or src/ are entry points by default)
  --only <kinds>         Report only these finding kinds, comma-separated:
                         files, exports, types, ns-exports, ns-types, members,
                         empty-types, dependencies, unlisted.
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
  --fix                  Remove reported members and export keywords from the source files
  --dry-run              With --fix: print the would-be changes as a unified
                         diff without writing any file
  --watch                Re-run on save: keep the loaded project in memory,
                         refresh the changed files, and report again
                         (tsconfig and norefs.config.json changes need a restart)
  --no-anonymous         Hide findings on unnamed inline types and anonymous functions
  -h, --help             Show this help message

Configuration:
  norefs reads norefs.config.json from the current directory when it exists:
    { "project": "…"|[…], "entry": […], "ignore": ["globs"],
      "only": […], "ignoreDependencies": ["names or globs"] }
  Command-line flags win over the config file; entries merge.

Suppressing findings:
  // norefs-ignore [reason]   on the reported line or the line above
  // norefs-ignore-file       before the first statement of a file
`;

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: 'string', short: 'p', multiple: true },
      scope: { type: 'string' },
      entry: { type: 'string', multiple: true },
      only: { type: 'string', multiple: true },
      reporter: { type: 'string', default: 'text' },
      baseline: { type: 'boolean', default: false },
      export: { type: 'string' },
      fix: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      watch: { type: 'boolean', default: false },
      anonymous: { type: 'boolean', default: true },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowNegative: true,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const command = positionals[0];
  if (command !== undefined && command !== 'init') {
    process.stderr.write(`error: unknown command "${command}" (the only command is "init")\n`);
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

  const reporters = { text: formatText, json: formatJson, github: formatGitHub, sarif: formatSarif };
  const reporter = reporters[values.reporter as keyof typeof reporters];
  if (!reporter) {
    process.stderr.write(
      `error: --reporter must be one of ${Object.keys(reporters).join(', ')}, got "${values.reporter}"\n`
    );
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
      anonymous: values.anonymous,
      only: kindNames.length > 0 ? parseKinds(kindNames) : undefined,
      ignore: config.ignore,
      cwd,
    };
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n`);
    process.exitCode = 2;
    return;
  }

  const cliProjects = values.project ?? [];
  const tsConfigPaths = (cliProjects.length > 0 ? cliProjects : config.project).map(p => path.resolve(cwd, p));
  if (tsConfigPaths.length === 0) tsConfigPaths.push(path.resolve(cwd, 'tsconfig.json'));
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

  const scopeDir = values.scope ? path.resolve(cwd, values.scope) : undefined;
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
    kinds: filterOptions.only,
  };
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
          `${baseline.stale} baseline finding(s) no longer occur — run norefs --baseline to refresh the file\n`
        );
      }
    }

    if (values.export) {
      const fileName = values.export === 'md' ? 'norefs-findings.md' : 'norefs-findings.json';
      const content = values.export === 'md' ? formatMarkdown(findings, cwd) : formatJson(findings, cwd);
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

  printReport(findings, baseline);

  if (findings.length === 0) return;

  if (values.fix) {
    // Removing code can orphan other exports, so re-analyze and fix again
    // until nothing fixable is left. A dry run applies the same fixes to the
    // in-memory project only and prints the diff against the files on disk.
    const save = !values['dry-run'];
    let result = applyFixes(findings, { save });
    let totalFixed = result.fixed;
    const touched = new Set(result.filePaths);
    for (let pass = 2; result.fixed > 0 && pass <= 5; pass++) {
      let remaining = runAnalysis();
      if (baseline) remaining = applyBaseline(remaining, cwd)?.fresh ?? remaining;
      result = applyFixes(remaining, { save });
      if (result.fixed === 0) break;
      totalFixed += result.fixed;
      for (const filePath of result.filePaths) touched.add(filePath);
      if (save) process.stderr.write(`Pass ${pass}: fixed ${result.fixed} more finding(s)\n`);
    }

    if (!save) {
      for (const filePath of [...touched].sort()) {
        const before = fs.readFileSync(filePath, 'utf8');
        const after = project().getSourceFile(filePath)?.getFullText() ?? before;
        process.stdout.write(`${formatPatch(path.relative(cwd, filePath), before, after)}\n`);
      }
      process.stderr.write(`Dry run: would fix ${totalFixed} finding(s) in ${touched.size} file(s)\n`);
      process.exitCode = 1;
      return;
    }

    process.stderr.write(`Fixed ${totalFixed} finding(s) in ${touched.size} file(s)\n`);
    if (result.skipped > 0) {
      process.stderr.write(
        `Skipped ${result.skipped} finding(s) --fix does not touch (files, namespaces, emptied types, dependencies)\n`
      );
    }
    return;
  }

  process.exitCode = 1;
}

main();
