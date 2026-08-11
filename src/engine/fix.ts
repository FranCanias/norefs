import type { ExportSpecifier, Identifier, ImportDeclaration, ImportSpecifier, Node, SourceFile } from 'ts-morph';
import { Node as NodeGuards, SyntaxKind } from 'ts-morph';
import type { Finding } from '../types';
import { declarationNameNode } from './modules';

export interface FixResult {
  /** Paths of the files that changed. */
  filePaths: string[];
  fixed: number;
  /** Findings --fix leaves for the user: unused files, namespace findings, emptied types. */
  skipped: number;
}

/**
 * Fix the findings and save the touched files.
 *
 * Members are removed; a parameter property only loses its modifiers and stays
 * a plain parameter, so the constructor signature and every call site keep
 * working. An export with zero references anywhere is removed whole, together
 * with any import/export specifiers that forward it; an export still used
 * inside its file only loses the export keyword. Orphaned identifiers left
 * behind in touched files (an import only the removed code used) are cleaned
 * up before saving. Unused files, namespace findings, and emptied types are
 * never touched.
 */
export function applyFixes(findings: Finding[], options: { save?: boolean } = {}): FixResult {
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
    const changed = finding.kind === 'member' ? fixMember(node) : fixExport(finding, node);
    if (changed.length > 0) {
      for (const file of changed) touched.add(file);
      fixed++;
    } else {
      skipped++;
    }
  }

  for (const file of touched) cleanUpOrphans(file);

  const filePaths = [...touched].map(file => file.getFilePath());
  if (options.save ?? true) {
    for (const file of touched) file.saveSync();
  }
  return { filePaths, fixed, skipped };
}

function fixMember(member: Node): SourceFile[] {
  const sourceFile = member.getSourceFile();
  if (member.isKind(SyntaxKind.Parameter)) {
    member.setHasOverrideKeyword(false);
    member.setIsReadonly(false);
    member.setScope(undefined);
  } else {
    (member as unknown as { remove(): void }).remove();
  }
  return [sourceFile];
}

function fixExport(finding: Finding, decl: Node): SourceFile[] {
  const changed = new Set<SourceFile>();

  // First drop every import/export specifier that forwards the name — a barrel
  // re-export or an unused import would dangle once the export is gone.
  const nameNode = declarationNameNode(decl);
  if (nameNode) {
    for (const specifier of danglingSpecifiers(nameNode)) {
      changed.add(specifier.getSourceFile());
      removeSpecifier(specifier);
    }
  }

  if (finding.dead) {
    changed.add(decl.getSourceFile());
    removeDeclaration(decl);
    return [...changed];
  }

  if (NodeGuards.isExportable(decl) && decl.hasExportKeyword()) {
    decl.setIsExported(false);
    changed.add(decl.getSourceFile());
  } else if (decl.isKind(SyntaxKind.VariableDeclaration)) {
    const statement = decl.getVariableStatement();
    if (statement?.hasExportKeyword() && statement.getDeclarations().length === 1) {
      statement.setIsExported(false);
      changed.add(decl.getSourceFile());
    }
  }
  return [...changed];
}

/** Import/export specifiers anywhere in the project that forward the declaration's name. */
function danglingSpecifiers(nameNode: Identifier): Array<ImportSpecifier | ExportSpecifier> {
  const specifiers = new Set<ImportSpecifier | ExportSpecifier>();
  for (const ref of nameNode.findReferencesAsNodes()) {
    const parent = ref.getParent();
    if (parent?.isKind(SyntaxKind.ImportSpecifier) || parent?.isKind(SyntaxKind.ExportSpecifier)) {
      specifiers.add(parent);
    }
  }
  return [...specifiers];
}

function removeSpecifier(specifier: ImportSpecifier | ExportSpecifier): void {
  if (specifier.isKind(SyntaxKind.ExportSpecifier)) {
    const exportDecl = specifier.getExportDeclaration();
    if (exportDecl.getNamedExports().length === 1) exportDecl.remove();
    else specifier.remove();
    return;
  }
  const importDecl = specifier.getImportDeclaration();
  const lastBinding =
    importDecl.getNamedImports().length === 1 && !importDecl.getDefaultImport() && !importDecl.getNamespaceImport();
  if (lastBinding) importDecl.remove();
  else specifier.remove();
}

function removeDeclaration(decl: Node): void {
  if (decl.isKind(SyntaxKind.VariableDeclaration)) {
    const statement = decl.getVariableStatement();
    if (statement && statement.getDeclarations().length === 1) {
      statement.remove();
      return;
    }
  }
  (decl as unknown as { remove(): void }).remove();
}

/**
 * Remove code the fixes orphaned: imports and unexported top-level declarations
 * that nothing references anymore. Runs until the file is stable, because one
 * removal can orphan the next.
 */
function cleanUpOrphans(file: SourceFile): void {
  for (let pass = 0; pass < 5; pass++) {
    const importsChanged = removeUnusedImports(file);
    const localsChanged = removeUnusedLocals(file);
    if (!importsChanged && !localsChanged) return;
  }
}

function removeUnusedImports(file: SourceFile): boolean {
  let changed = false;
  for (const importDecl of [...file.getImportDeclarations()]) {
    const defaultImport = importDecl.getDefaultImport();
    const namespaceImport = importDecl.getNamespaceImport();
    const hadBindings = importDecl.getNamedImports().length > 0 || defaultImport || namespaceImport;
    if (!hadBindings) continue; // A bare side-effect import stays.

    for (const specifier of [...importDecl.getNamedImports()]) {
      const binding = specifier.getAliasNode() ?? specifier.getNameNode();
      if (binding.isKind(SyntaxKind.Identifier) && !isBindingUsed(binding, file, importDecl)) {
        specifier.remove();
        changed = true;
      }
    }
    if (defaultImport && !isBindingUsed(defaultImport, file, importDecl)) {
      importDecl.removeDefaultImport();
      changed = true;
    }
    if (namespaceImport && !isBindingUsed(namespaceImport, file, importDecl)) {
      importDecl.removeNamespaceImport();
      changed = true;
    }
    if (
      importDecl.getNamedImports().length === 0 &&
      !importDecl.getDefaultImport() &&
      !importDecl.getNamespaceImport()
    ) {
      importDecl.remove();
      changed = true;
    }
  }
  return changed;
}

function isBindingUsed(binding: Identifier, file: SourceFile, importDecl: ImportDeclaration): boolean {
  return binding
    .findReferencesAsNodes()
    .some(
      ref => ref.getSourceFile() === file && ref.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) !== importDecl
    );
}

/**
 * Remove unexported top-level declarations with zero references. A reference
 * from an `export { x }` list or an `export default x` keeps the declaration,
 * because those occurrences count as references. Exported declarations are
 * left to the analysis, which knows about entry files.
 */
function removeUnusedLocals(file: SourceFile): boolean {
  let changed = false;
  for (const statement of [...file.getStatements()]) {
    if (statement.isKind(SyntaxKind.VariableStatement)) {
      if (statement.hasExportKeyword() || statement.hasDeclareKeyword()) continue;
      for (const decl of [...statement.getDeclarations()]) {
        const name = decl.getNameNode();
        if (name.isKind(SyntaxKind.Identifier) && name.findReferencesAsNodes().length === 0) {
          removeDeclaration(decl);
          changed = true;
        }
      }
      continue;
    }
    if (
      statement.isKind(SyntaxKind.FunctionDeclaration) ||
      statement.isKind(SyntaxKind.ClassDeclaration) ||
      statement.isKind(SyntaxKind.InterfaceDeclaration) ||
      statement.isKind(SyntaxKind.TypeAliasDeclaration) ||
      statement.isKind(SyntaxKind.EnumDeclaration)
    ) {
      if (statement.isExported() || statement.hasDeclareKeyword()) continue;
      const name = statement.getNameNode();
      if (name?.isKind(SyntaxKind.Identifier) && name.findReferencesAsNodes().length === 0) {
        statement.remove();
        changed = true;
      }
    }
  }
  return changed;
}
