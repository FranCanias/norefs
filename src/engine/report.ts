import path from 'node:path';
import type { Finding } from '../types';

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

export function formatMarkdown(findings: Finding[], cwd: string): string {
  const lines: string[] = ['# noref findings', ''];
  if (findings.length === 0) {
    lines.push('No unused properties found.');
    return lines.join('\n');
  }

  const byFile = new Map<string, Finding[]>();
  for (const finding of findings) {
    const list = byFile.get(finding.filePath) ?? [];
    list.push(finding);
    byFile.set(finding.filePath, list);
  }

  lines.push(`Unused properties: ${findings.length}`, '');
  for (const [filePath, fileFindings] of byFile) {
    const relativePath = path.relative(cwd, filePath);
    lines.push(`[${path.basename(relativePath)}](${relativePath})`, '');
    for (const finding of fileFindings) {
      lines.push(
        `- \`${finding.propertyName}\` in ${finding.context} (line ${finding.line}, column ${finding.column})`
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function formatJson(findings: Finding[], cwd: string): string {
  return JSON.stringify(
    findings.map(f => ({ ...f, filePath: path.relative(cwd, f.filePath) })),
    null,
    2
  );
}
