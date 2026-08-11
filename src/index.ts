#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { analyze } from './analyze.js';
import { loadProject } from './project.js';
import { formatJson, formatText } from './report.js';

const HELP = `noref - find unused properties on types, interfaces, and object literals

Usage: noref [options]

Options:
  -p, --project <path>  Path to tsconfig.json (default: ./tsconfig.json)
  --json                 Print findings as JSON
  -h, --help             Show this help message
`;

function main(): void {
  const { values } = parseArgs({
    options: {
      project: { type: 'string', short: 'p', default: 'tsconfig.json' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const cwd = process.cwd();
  const tsConfigFilePath = path.resolve(cwd, values.project);
  const project = loadProject(tsConfigFilePath);
  const findings = analyze(project);

  process.stdout.write(values.json ? formatJson(findings, cwd) : formatText(findings, cwd));
  process.stdout.write('\n');

  if (findings.length > 0) process.exitCode = 1;
}

main();
