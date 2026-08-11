#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { analyze } from './engine/analyze';
import { findUnresolvedImports } from './engine/diagnostics';
import { loadProject } from './engine/project';
import { formatJson, formatMarkdown, formatText } from './engine/report';
import { applyFilters } from './filters';

const HELP = `noref - find unused properties on types, interfaces, and object literals

Usage: noref [options]

Options:
  -p, --project <path>  Path to tsconfig.json (default: ./tsconfig.json)
  --scope <path>         Only report properties declared under this path
                         (still uses the whole project to resolve usages —
                         handy when a tsconfig spans an SDK and its consumer)
  --json                 Print findings as JSON
  --export <md|json>     Also write findings to noref-findings.md or noref-findings.json
  --no-anonymous         Hide findings on unnamed inline types and anonymous functions
  -h, --help             Show this help message
`;

function main(): void {
  const { values } = parseArgs({
    options: {
      project: { type: 'string', short: 'p', default: 'tsconfig.json' },
      scope: { type: 'string' },
      json: { type: 'boolean', default: false },
      export: { type: 'string' },
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

  const cwd = process.cwd();
  const tsConfigFilePath = path.resolve(cwd, values.project);
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
  const findings = applyFilters(analyze(project, { scopeDir }), { anonymous: values.anonymous });

  process.stdout.write(values.json ? formatJson(findings, cwd) : formatText(findings, cwd));
  process.stdout.write('\n');

  if (values.export) {
    const fileName = values.export === 'md' ? 'noref-findings.md' : 'noref-findings.json';
    const content =
      values.export === 'md' ? formatMarkdown(findings, cwd) : formatJson(findings, cwd);
    fs.writeFileSync(path.join(cwd, fileName), `${content}\n`);
    process.stderr.write(`Wrote ${fileName}\n`);
  }

  if (findings.length > 0) process.exitCode = 1;
}

main();
