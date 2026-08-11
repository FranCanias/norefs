import path from 'node:path';
import type { Finding } from './types.js';

export function formatText(findings: Finding[], cwd: string): string {
  if (findings.length === 0) return 'No unused properties found.\n';

  const byFile = new Map<string, Finding[]>();
  for (const finding of findings) {
    const list = byFile.get(finding.filePath) ?? [];
    list.push(finding);
    byFile.set(finding.filePath, list);
  }

  const lines: string[] = [];
  for (const [filePath, fileFindings] of byFile) {
    lines.push(path.relative(cwd, filePath));
    for (const finding of fileFindings) {
      lines.push(
        `  ${finding.line}:${finding.column}  unused property \`${finding.propertyName}\` in ${finding.context}`
      );
    }
  }
  lines.push('', `Unused properties (${findings.length})`);
  return lines.join('\n');
}

export function formatJson(findings: Finding[], cwd: string): string {
  return JSON.stringify(
    findings.map(f => ({ ...f, filePath: path.relative(cwd, f.filePath) })),
    null,
    2
  );
}
