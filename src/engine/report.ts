import path from 'node:path';
import type { Finding } from '../types';

function describeFinding(finding: Finding): string {
  switch (finding.kind) {
    case 'file':
      return 'unused file';
    case 'export':
      return `unused export \`${finding.name}\``;
    case 'type':
      return `unused exported type \`${finding.name}\``;
    case 'ns-export':
      return `unused export \`${finding.name}\` in used namespace \`${finding.context}\``;
    case 'ns-type':
      return `unused exported type \`${finding.name}\` in used namespace \`${finding.context}\``;
    case 'member':
      return `unused property \`${finding.name}\` in ${finding.context}`;
  }
}

function summarize(findings: Finding[]): string {
  const of = (...kinds: Finding['kind'][]): number => findings.filter(f => kinds.includes(f.kind)).length;
  const groups: Array<[number, string, string]> = [
    [of('file'), 'file', 'files'],
    [of('export', 'ns-export'), 'export', 'exports'],
    [of('type', 'ns-type'), 'exported type', 'exported types'],
    [of('member'), 'property', 'properties'],
  ];
  const parts = groups.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  return `Unused code (${findings.length}): ${parts.join(', ')}`;
}

function groupByFile(findings: Finding[]): Map<string, Finding[]> {
  const byFile = new Map<string, Finding[]>();
  for (const finding of findings) {
    const list = byFile.get(finding.filePath) ?? [];
    list.push(finding);
    byFile.set(finding.filePath, list);
  }
  return byFile;
}

export function formatText(findings: Finding[], cwd: string): string {
  if (findings.length === 0) return 'No unused code found.\n';

  const lines: string[] = [];
  for (const [filePath, fileFindings] of groupByFile(findings)) {
    lines.push(path.relative(cwd, filePath));
    for (const finding of fileFindings) {
      lines.push(
        finding.kind === 'file'
          ? `  ${describeFinding(finding)}`
          : `  ${finding.line}:${finding.column}  ${describeFinding(finding)}`
      );
    }
  }
  lines.push('', summarize(findings));
  return lines.join('\n');
}

export function formatMarkdown(findings: Finding[], cwd: string): string {
  const lines: string[] = ['# noref findings', ''];
  if (findings.length === 0) {
    lines.push('No unused code found.');
    return lines.join('\n');
  }

  lines.push(summarize(findings), '');
  for (const [filePath, fileFindings] of groupByFile(findings)) {
    const relativePath = path.relative(cwd, filePath);
    lines.push(`[${path.basename(relativePath)}](${relativePath})`, '');
    for (const finding of fileFindings) {
      lines.push(
        finding.kind === 'file'
          ? `- ${describeFinding(finding)}`
          : `- ${describeFinding(finding)} (line ${finding.line}, column ${finding.column})`
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function formatJson(findings: Finding[], cwd: string): string {
  return JSON.stringify(
    findings.map(f => ({
      kind: f.kind,
      filePath: path.relative(cwd, f.filePath),
      line: f.line,
      column: f.column,
      name: f.name,
      context: f.context,
      anonymous: f.anonymous,
    })),
    null,
    2
  );
}
