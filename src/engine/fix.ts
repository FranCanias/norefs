import type { ExportSpecifier, Identifier, ImportDeclaration, ImportSpecifier, Node, SourceFile } from 'ts-morph';
import { Node as NodeGuards, SyntaxKind, ts } from 'ts-morph';
import type { Finding } from '../types';
import { declarationNameNode } from './modules';
import { findReferencesAsNodes } from './references';

interface FixResult {
  /** Paths of the files that changed. */
  filePaths: string[];
  fixed: number;
  /** Findings --fix leaves for the user: unused files, namespace findings, emptied types. */
  skipped: number;
}

/**
 * Fix the findings and save the touched files, gated by verdict.
 *
 * A `dead` or `over-exported` finding auto-fixes: an export with zero
 * references anywhere is removed whole, together with any import/export
 * specifiers that forward it; an over-exported declaration only loses the
 * export keyword; a dead member is deleted (a parameter property only loses
 * its modifiers and stays a plain parameter, so the constructor signature and
 * every call site keep working). A `write-only`, `contract`, or `shadowed`
 * member is a claim the analysis cannot prove — it needs `options.unsafe`.
 * Orphaned identifiers left behind in touched files (an import only the
 * removed code used) are cleaned up before saving. Unused files, namespace
 * findings, and emptied types are never touched.
 */
/** True when --fix may act on this finding, given the unsafe opt-in. */
export function isFixable(finding: Finding, unsafe: boolean): boolean {
  if (finding.kind !== 'export' && finding.kind !== 'type' && finding.kind !== 'member') return false;
  return finding.verdict === 'dead' || finding.verdict === 'over-exported' || unsafe;
}

export function applyFixes(findings: Finding[], options: { save?: boolean; unsafe?: boolean } = {}): FixResult {
  const fixable = findings.filter(f => isFixable(f, options.unsafe ?? false));
  let skipped = findings.length - fixable.length;

  // Fix inner nodes before outer ones, so a member nested inside another
  // finding (an object literal inside a dead method) is still valid when its
  // turn comes.
  const sorted = [...fixable].sort((a, b) =>
    a.filePath === b.filePath
      ? (b.node?.getStart() ?? 0) - (a.node?.getStart() ?? 0)
      : a.filePath.localeCompare(b.filePath)
  );

  // Every reference query runs before the first edit, while the analysis
  // index still matches the project. The specifiers it hands back stay valid
  // across the edits — ts-morph remaps wrapped nodes a manipulation did not
  // remove — and the ones an earlier fix did remove are skipped as forgotten.
  const specifiers = new Map<Finding, Array<ImportSpecifier | ExportSpecifier>>();
  for (const finding of sorted) {
    if (finding.kind === 'member' || !finding.node) continue;
    const nameNode = declarationNameNode(finding.node);
    if (nameNode) specifiers.set(finding, danglingSpecifiers(nameNode));
  }

  const touched = new Set<SourceFile>();
  let fixed = 0;
  for (const finding of sorted) {
    const node = finding.node;
    if (!node) continue;
    const changed =
      finding.kind === 'member' ? fixMember(node) : fixExport(finding, node, specifiers.get(finding) ?? []);
    if (changed.length > 0) {
      for (const file of changed) touched.add(file);
      fixed++;
    } else {
      skipped++;
    }
  }

  cleanUpOrphans(touched);

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

function fixExport(finding: Finding, decl: Node, specifiers: Array<ImportSpecifier | ExportSpecifier>): SourceFile[] {
  const changed = new Set<SourceFile>();

  // First drop every import/export specifier that forwards the name — a barrel
  // re-export or an unused import would dangle once the export is gone.
  for (const specifier of specifiers) {
    if (specifier.wasForgotten()) continue; // an earlier fix removed its whole statement
    changed.add(specifier.getSourceFile());
    removeSpecifier(specifier);
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
  for (const ref of findReferencesAsNodes(nameNode)) {
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
 * that nothing references anymore. Each round first finds every orphan in
 * every touched file, then removes them all — queries never interleave with
 * edits, so the checker re-reads the project once per round rather than once
 * per question. One removal can orphan the next, so rounds repeat until the
 * files are stable.
 */
function cleanUpOrphans(files: Set<SourceFile>): void {
  for (let round = 0; round < 5; round++) {
    const removals: Array<() => void> = [];
    for (const file of files) {
      collectUnusedImports(file, removals);
      collectUnusedLocals(file, removals);
    }
    if (removals.length === 0) return;
    for (const removal of removals) removal();
  }
}

function collectUnusedImports(file: SourceFile, removals: Array<() => void>): void {
  for (const importDecl of file.getImportDeclarations()) {
    const defaultImport = importDecl.getDefaultImport();
    const namespaceImport = importDecl.getNamespaceImport();
    const named = importDecl.getNamedImports();
    if (named.length === 0 && !defaultImport && !namespaceImport) continue; // A bare side-effect import stays.

    const unusedSpecifiers = named.filter(specifier => {
      const binding = specifier.getAliasNode() ?? specifier.getNameNode();
      return binding.isKind(SyntaxKind.Identifier) && !isBindingUsed(binding, file, importDecl);
    });
    const dropDefault = defaultImport !== undefined && !isBindingUsed(defaultImport, file, importDecl);
    const dropNamespace = namespaceImport !== undefined && !isBindingUsed(namespaceImport, file, importDecl);
    if (unusedSpecifiers.length === 0 && !dropDefault && !dropNamespace) continue;

    const emptied = unusedSpecifiers.length === named.length && (dropDefault || !defaultImport) && !namespaceImport;
    removals.push(() => {
      if (importDecl.wasForgotten()) return;
      if (emptied || (dropNamespace && named.length === 0 && (dropDefault || !defaultImport))) {
        importDecl.remove();
        return;
      }
      for (const specifier of unusedSpecifiers) {
        if (!specifier.wasForgotten()) specifier.remove();
      }
      if (dropDefault) importDecl.removeDefaultImport();
      if (dropNamespace) importDecl.removeNamespaceImport();
    });
  }
}

/**
 * True when anything in the file outside the import itself still reads the
 * binding. Answered from the file alone: the checker resolves each identifier
 * spelled like the binding, which never rebuilds the language service's
 * project-wide import tracker the way a find-references call would.
 */
function isBindingUsed(binding: Identifier, file: SourceFile, importDecl: ImportDeclaration): boolean {
  return isUsedInFile(binding, file, importDecl.compilerNode);
}

/**
 * Remove unexported top-level declarations with zero references. A reference
 * from an `export { x }` list or an `export default x` keeps the declaration,
 * because those occurrences count as references. Exported declarations are
 * left to the analysis, which knows about entry files.
 */
function collectUnusedLocals(file: SourceFile, removals: Array<() => void>): void {
  for (const statement of file.getStatements()) {
    if (statement.isKind(SyntaxKind.VariableStatement)) {
      if (statement.hasExportKeyword() || statement.hasDeclareKeyword()) continue;
      for (const decl of statement.getDeclarations()) {
        const name = decl.getNameNode();
        if (name.isKind(SyntaxKind.Identifier) && !isUsedInFile(name, file)) {
          removals.push(() => {
            if (!decl.wasForgotten()) removeDeclaration(decl);
          });
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
      if (name?.isKind(SyntaxKind.Identifier) && !isUsedInFile(name, file)) {
        removals.push(() => {
          if (!statement.wasForgotten()) statement.remove();
        });
      }
    }
  }
}

/**
 * True when an identifier outside `exclude` (and outside the declaration
 * itself) resolves to the same symbol the name declares. A shorthand property
 * and an `export { x }` specifier name the symbol without resolving to it
 * directly, so those ask the checker their own way. When the name resolves to
 * nothing, the declaration is kept: proof, not absence of proof, removes code.
 */
function isUsedInFile(name: Identifier, file: SourceFile, exclude?: ts.Node): boolean {
  const checker = file.getProject().getTypeChecker().compilerObject;
  const target = checker.getSymbolAtLocation(name.compilerNode);
  if (!target) return true;
  const text = name.compilerNode.text;

  let used = false;
  const visit = (node: ts.Node): void => {
    if (used) return;
    if (exclude && node === exclude) return;
    if (ts.isIdentifier(node) && node.text === text && node !== name.compilerNode) {
      const parent = node.parent;
      if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
        if (checker.getShorthandAssignmentValueSymbol(parent) === target) {
          used = true;
          return;
        }
      }
      if (ts.isExportSpecifier(parent) && (parent.propertyName ?? parent.name) === node) {
        if (checker.getExportSpecifierLocalTargetSymbol(parent) === target) {
          used = true;
          return;
        }
      }
      if (checker.getSymbolAtLocation(node) === target) {
        used = true;
        return;
      }
    }
    node.forEachChild(visit);
  };
  file.compilerNode.forEachChild(visit);
  return used;
}
