import type { Project } from 'ts-morph';
import { collectCandidates } from '../collectors';
import type { Finding } from '../types';
import { isUnused } from './check';

export function analyze(project: Project): Finding[] {
  const candidates = collectCandidates(project);
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
    });
  }

  findings.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line || a.column - b.column);
  return findings;
}
