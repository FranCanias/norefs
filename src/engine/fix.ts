import type { Node, SourceFile } from 'ts-morph';
import { Node as NodeGuards, SyntaxKind } from 'ts-morph';
import type { Finding } from '../types';

export interface FixResult {
  /** Paths of the files that changed. */
  filePaths: string[];
  fixed: number;
  /** Findings --fix leaves for the user: unused files and namespace findings. */
  skipped: number;
}

/**
 * Fix the findings and save the touched files.
 *
 * Members are removed; a parameter property only loses its modifiers and stays
 * a plain parameter, so the constructor signature and every call site keep
 * working. Unused exports lose their export keyword but keep the declaration.
 * Unused files and namespace findings are never touched.
 */
export function applyFixes(findings: Finding[]): FixResult {
  const fixable = findings.filter(f => f.kind === 'member' || f.kind === 'export' || f.kind === 'type');
  let skipped = findings.length - fixable.length;

  // Fix inner nodes before outer ones, so a member nested inside another
  // finding (an object literal inside a dead method) is still valid when its
  // turn comes.
  const sorted = [...fixable].sort((a, b) =>
    a.filePath === b.filePath
      ? (b.node?.getStart() ?? 0) - (a.node?.getStart() ?? 0)
      : a.filePath.localeCompare(b.filePath)
  );

  const touched = new Set<SourceFile>();
  let fixed = 0;
  for (const finding of sorted) {
    const node = finding.node;
    if (!node) continue;
    if (finding.kind === 'member' ? fixMember(node) : unexport(node)) {
      touched.add(node.getSourceFile());
      fixed++;
    } else {
      skipped++;
    }
  }

  const filePaths = [...touched].map(file => file.getFilePath());
  for (const file of touched) file.saveSync();
  return { filePaths, fixed, skipped };
}

function fixMember(member: Node): boolean {
  if (member.isKind(SyntaxKind.Parameter)) {
    member.setHasOverrideKeyword(false);
    member.setIsReadonly(false);
    member.setScope(undefined);
  } else {
    (member as unknown as { remove(): void }).remove();
  }
  return true;
}

function unexport(decl: Node): boolean {
  if (decl.isKind(SyntaxKind.VariableDeclaration)) {
    const statement = decl.getVariableStatement();
    if (statement?.hasExportKeyword() && statement.getDeclarations().length === 1) {
      statement.setIsExported(false);
      return true;
    }
    return removeExportSpecifier(decl);
  }
  if (NodeGuards.isExportable(decl) && decl.hasExportKeyword()) {
    decl.setIsExported(false);
    return true;
  }
  return removeExportSpecifier(decl);
}

/** Remove the `export { name }` specifier that exports the declaration. */
function removeExportSpecifier(decl: Node): boolean {
  const name = NodeGuards.hasName(decl) ? decl.getName() : undefined;
  if (!name) return false;
  for (const exportDecl of decl.getSourceFile().getExportDeclarations()) {
    if (exportDecl.getModuleSpecifier()) continue;
    for (const specifier of exportDecl.getNamedExports()) {
      if (specifier.getNameNode().getText() !== name) continue;
      if (exportDecl.getNamedExports().length === 1) exportDecl.remove();
      else specifier.remove();
      return true;
    }
  }
  return false;
}
