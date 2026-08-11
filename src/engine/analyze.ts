import type { Project } from 'ts-morph';
import { collectCandidates } from '../collectors';
import type { Finding } from '../types';
import { isUnused } from './check';
import type { ModuleOptions } from './modules';
import { analyzeModules } from './modules';

export type AnalyzeOptions = ModuleOptions;

export function analyze(project: Project, options: AnalyzeOptions = {}): Finding[] {
  const modules = analyzeModules(project, options);
  const findings = [...modules.findings];

  for (const { member, context, anonymous } of collectCandidates(project, options)) {
    // An unused file or a declaration with zero references is already reported
    // as a whole; listing every member inside it would only add noise.
    if (modules.deadFiles.has(member.getSourceFile())) continue;
    if (member.getAncestors().some(ancestor => modules.deadDecls.has(ancestor))) continue;
    if (!isUnused(member)) continue;
    const nameNode = member.getNameNode();
    const sourceFile = member.getSourceFile();
    const { line, column } = sourceFile.getLineAndColumnAtPos(nameNode.getStart());
    findings.push({
      kind: 'member',
      filePath: sourceFile.getFilePath(),
      line,
      column,
      name: member.getName(),
      context,
      anonymous,
      node: member,
    });
  }

  findings.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line || a.column - b.column);
  return findings;
}
