import type { Project } from 'ts-morph';
import type { CollectOptions } from '../collectors';
import { collectCandidates } from '../collectors';
import type { Finding } from '../types';
import { isUnused } from './check';

export function analyze(project: Project, options: CollectOptions = {}): Finding[] {
  const candidates = collectCandidates(project, options);
  const findings: Finding[] = [];

  for (const { member, context, anonymous } of candidates) {
    if (!isUnused(member)) continue;
    const nameNode = member.getNameNode();
    const sourceFile = member.getSourceFile();
    const { line, column } = sourceFile.getLineAndColumnAtPos(nameNode.getStart());
    findings.push({
      filePath: sourceFile.getFilePath(),
      line,
      column,
      propertyName: member.getName(),
      context,
      anonymous,
      member,
    });
  }

  findings.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line || a.column - b.column);
  return findings;
}
