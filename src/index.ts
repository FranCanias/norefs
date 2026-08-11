#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { applyBaseline, writeBaseline } from './baseline';
import { loadConfig } from './config';
import { analyze } from './engine/analyze';
import { findUnresolvedImports } from './engine/diagnostics';
import { applyFixes } from './engine/fix';
import { loadProject } from './engine/project';
import { formatGitHub, formatJson, formatMarkdown, formatSarif, formatText } from './engine/report';
import type { FilterOptions } from './filters';
import { applyFilters, parseKinds } from './filters';

const HELP = `noref - find unused files, exports, and properties in a TypeScript project

Usage: noref [options]

Options:
  -p, --project <path>  Path to tsconfig.json (default: ./tsconfig.json)
  --scope <path>         Only report findings declared under this path
                         (still uses the whole project to resolve usages —
                         handy when a tsconfig spans an SDK and its consumer)
  --entry <path>         Treat this file or directory as an entry point: it is
                         never reported unused and its exports are the public
                         API (repeatable; index/main/cli files in the project
                         root or src/ are entry points by default)
  --only <kinds>         Report only these finding kinds, comma-separated: files,
                         exports, types, ns-exports, ns-types, members, empty-types
  --reporter <name>      Output format: text (default), json, github (workflow
                         commands that annotate pull requests), sarif
  --baseline             Write the findings to noref-baseline.json and exit;
                         when that file exists, later runs report and fail on
                         new findings only
  --export <md|json>     Also write findings to noref-findings.md or noref-findings.json
  --fix                  Remove reported members and export keywords from the source files
  --no-anonymous         Hide findings on unnamed inline types and anonymous functions
  -h, --help             Show this help message

Configuration:
  noref reads noref.json from the current directory when it exists:
    { "project": "...", "entry": [...], "ignore": ["globs"], "only": [...] }
  Command-line flags win over the config file; entries merge.

Suppressing findings:
  // noref-ignore [reason]   on the reported line or the line above
  // noref-ignore-file       before the first statement of a file
`;

function main(): void {
  const { values } = parseArgs({
    options: {
      project: { type: 'string', short: 'p' },
      scope: { type: 'string' },
      entry: { type: 'string', multiple: true },
      only: { type: 'string', multiple: true },
      reporter: { type: 'string', default: 'text' },
      baseline: { type: 'boolean', default: false },
      export: { type: 'string' },
      fix: { type: 'boolean', default: false },
      anonymous: { type: 'boolean', default: true },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowNegative: true,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  if (values.export !== undefined && values.export !== 'md' && values.export !== 'json') {
    process.stderr.write(`error: --export must be "md" or "json", got "${values.export}"\n`);
    process.exitCode = 2;
    return;
  }

  const reporters = { text: formatText, json: formatJson, github: formatGitHub, sarif: formatSarif };
  const reporter = reporters[values.reporter as keyof typeof reporters];
  if (!reporter) {
    process.stderr.write(`error: --reporter must be one of ${Object.keys(reporters).join(', ')}, got "${values.reporter}"\n`);
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

  const tsConfigFilePath = path.resolve(cwd, values.project ?? config.project ?? 'tsconfig.json');
  const project = loadProject(tsConfigFilePath);

  const unresolved = findUnresolvedImports(project);
  if (unresolved.length > 0) {
    const examples = unresolved.slice(0, 5).join(', ');
    const more = unresolved.length > 5 ? ', …' : '';
    process.stderr.write(
      `warning: ${unresolved.length} import specifier(s) do not resolve (${examples}${more}).\n` +
        `References through them are invisible, so used properties may be reported as unused.\n` +
        `Check the tsconfig "paths" and "include" settings.\n\n`
    );
  }

  const scopeDir = values.scope ? path.resolve(cwd, values.scope) : undefined;
  const entries = [...config.entry, ...(values.entry ?? [])].map(entry => path.resolve(cwd, entry));
  const rootDir = path.dirname(tsConfigFilePath);
  let findings = applyFilters(analyze(project, { scopeDir, entries, rootDir }), filterOptions);

  if (values.baseline) {
    const fileName = writeBaseline(findings, cwd);
    process.stderr.write(`Wrote ${fileName} with ${findings.length} finding(s)\n`);
    return;
  }

  let baseline: ReturnType<typeof applyBaseline>;
  try {
    baseline = applyBaseline(findings, cwd);
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  if (baseline) findings = baseline.fresh;

  process.stdout.write(reporter(findings, cwd));
  process.stdout.write('\n');

  if (baseline) {
    process.stderr.write(`Baseline: ${baseline.matched} finding(s) matched and were not reported\n`);
    if (baseline.stale > 0) {
      process.stderr.write(
        `${baseline.stale} baseline finding(s) no longer occur — run noref --baseline to refresh the file\n`
      );
    }
  }

  if (values.export) {
    const fileName = values.export === 'md' ? 'noref-findings.md' : 'noref-findings.json';
    const content = values.export === 'md' ? formatMarkdown(findings, cwd) : formatJson(findings, cwd);
    fs.writeFileSync(path.join(cwd, fileName), `${content}\n`);
    process.stderr.write(`Wrote ${fileName}\n`);
  }

  if (findings.length === 0) return;

  if (values.fix) {
    // Removing code can orphan other exports, so re-analyze and fix again
    // until nothing fixable is left.
    let result = applyFixes(findings);
    let totalFixed = result.fixed;
    const touched = new Set(result.filePaths);
    for (let pass = 2; result.fixed > 0 && pass <= 5; pass++) {
      let remaining = applyFilters(analyze(project, { scopeDir, entries, rootDir }), filterOptions);
      if (baseline) remaining = applyBaseline(remaining, cwd)?.fresh ?? remaining;
      result = applyFixes(remaining);
      if (result.fixed === 0) break;
      totalFixed += result.fixed;
      for (const filePath of result.filePaths) touched.add(filePath);
      process.stderr.write(`Pass ${pass}: fixed ${result.fixed} more finding(s)\n`);
    }
    process.stderr.write(`Fixed ${totalFixed} finding(s) in ${touched.size} file(s)\n`);
    if (result.skipped > 0) {
      process.stderr.write(
        `Skipped ${result.skipped} finding(s) --fix does not touch (unused files, namespace findings, emptied types)\n`
      );
    }
    return;
  }

  process.exitCode = 1;
}

main();
