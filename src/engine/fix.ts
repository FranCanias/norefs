import type { SourceFile } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import type { Finding } from '../types';

/**
 * Remove the members behind the findings and save the touched files.
 * Returns the paths of the files that changed.
 *
 * A parameter property only loses its modifiers and stays a plain parameter,
 * so the constructor signature and every call site keep working.
 */
export function applyFixes(findings: Finding[]): string[] {
  // Remove inner members before outer ones, so a member nested inside another
  // finding (an object literal inside a dead method) is still valid when its
  // turn comes.
  const sorted = [...findings].sort((a, b) =>
    a.filePath === b.filePath ? b.member.getStart() - a.member.getStart() : a.filePath.localeCompare(b.filePath)
  );

  const touched = new Set<SourceFile>();
  for (const { member } of sorted) {
    touched.add(member.getSourceFile());
    if (member.isKind(SyntaxKind.Parameter)) {
      member.setHasOverrideKeyword(false);
      member.setIsReadonly(false);
      member.setScope(undefined);
    } else {
      (member as unknown as { remove(): void }).remove();
    }
  }

  const filePaths = [...touched].map(file => file.getFilePath());
  for (const file of touched) file.saveSync();
  return filePaths;
}
