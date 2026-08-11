import path from 'node:path';
import type { Identifier, ModuleDeclaration, Node, Project, SourceFile } from 'ts-morph';
import { ModuleDeclarationKind, SyntaxKind, ts } from 'ts-morph';
import type { Finding, FindingKind } from '../types';

export interface ModuleAnalysis {
  findings: Finding[];
  /** Files reported unused; member analysis skips everything inside them. */
  deadFiles: Set<SourceFile>;
  /** Declarations with zero references anywhere; member analysis skips their insides. */
  deadDecls: Set<Node>;
}

export interface ModuleOptions {
  /** Only report findings declared under this absolute path prefix. */
  scopeDir?: string;
  /** Absolute paths (files or directories) treated as entry points. */
  entries?: string[];
  /** Directory that anchors the default entry-file and harness-file patterns. */
  rootDir?: string;
}

/** Default entry files, following the convention knip uses: index/main/cli in the root or src/. */
const ENTRY_NAME = /^(index|main|cli)\.[cm]?[jt]sx?$/;
/** Files a harness runs directly; they import code but nothing imports them. */
const HARNESS_NAME = /\.(test|spec|stories|bench|config)\.[cm]?[jt]sx?$/;
const HARNESS_DIRS = new Set(['test', 'tests', '__tests__', '__mocks__']);

export function analyzeModules(project: Project, options: ModuleOptions = {}): ModuleAnalysis {
  const entries = options.entries ?? [];
  const sourceFiles = project.getSourceFiles().filter(sf => !sf.isDeclarationFile());
  const rootDir = options.rootDir ?? commonDirectory(sourceFiles);
  const namespaceConsumers = findNamespaceConsumers(project);

  const findings: Finding[] = [];
  const deadFiles = new Set<SourceFile>();
  const deadDecls = new Set<Node>();

  for (const sourceFile of sourceFiles) {
    const filePath = sourceFile.getFilePath();
    if (options.scopeDir && !filePath.startsWith(options.scopeDir)) continue;
    if (isEntryFile(filePath, rootDir, entries)) continue;

    if (!isHarnessFile(filePath, rootDir) && !isReferenced(sourceFile)) {
      deadFiles.add(sourceFile);
      findings.push({
        kind: 'file',
        filePath,
        line: 1,
        column: 1,
        name: sourceFile.getBaseName(),
        context: '',
        anonymous: false,
      });
      continue;
    }

    collectExportFindings(sourceFile, namespaceConsumers.get(sourceFile), findings, deadDecls);
    for (const ns of sourceFile.getModules()) {
      collectNamespaceFindings(ns, findings, deadDecls);
    }
  }

  return { findings, deadFiles, deadDecls };
}

function isReferenced(sourceFile: SourceFile): boolean {
  return sourceFile.getReferencingSourceFiles().some(ref => ref !== sourceFile);
}

function isEntryFile(filePath: string, rootDir: string, entries: string[]): boolean {
  if (entries.some(entry => filePath === entry || filePath.startsWith(`${entry}/`))) return true;
  if (!ENTRY_NAME.test(path.basename(filePath))) return false;
  const dir = path.dirname(filePath);
  return dir === rootDir || dir === path.join(rootDir, 'src');
}

function isHarnessFile(filePath: string, rootDir: string): boolean {
  if (HARNESS_NAME.test(path.basename(filePath))) return true;
  const relative = path.relative(rootDir, path.dirname(filePath));
  return relative.split(path.sep).some(segment => HARNESS_DIRS.has(segment));
}

/**
 * Exported declarations of this file that nothing outside the file uses.
 * References resolve through re-export chains, so a barrel between the
 * declaration and its consumers does not hide usage.
 */
function collectExportFindings(
  sourceFile: SourceFile,
  namespaceAlias: string | undefined,
  findings: Finding[],
  deadDecls: Set<Node>
): void {
  const seen = new Set<Node>();
  for (const declarations of sourceFile.getExportedDeclarations().values()) {
    for (const decl of declarations) {
      if (decl.getSourceFile() !== sourceFile || seen.has(decl)) continue;
      seen.add(decl);
      if (isAmbient(decl)) continue;
      const nameNode = declarationNameNode(decl);
      if (!nameNode) continue;

      const { externallyUsed, locallyUsed } = classifyReferences(nameNode, sourceFile);
      if (externallyUsed) continue;
      if (!locallyUsed) deadDecls.add(decl);

      const typeOnly = isTypeDeclaration(decl);
      const kind: FindingKind = namespaceAlias ? (typeOnly ? 'ns-type' : 'ns-export') : typeOnly ? 'type' : 'export';
      findings.push(makeFinding(kind, nameNode, namespaceAlias ?? '', !locallyUsed));
    }
  }
}

/**
 * Exported members of a used TS namespace whose references never leave the
 * namespace body. Inside the body, siblings reach each other without the
 * export keyword, so those references do not justify the export.
 */
function collectNamespaceFindings(ns: ModuleDeclaration, findings: Finding[], deadDecls: Set<Node>): void {
  if (ns.getDeclarationKind() !== ModuleDeclarationKind.Namespace || isAmbient(ns)) return;
  const nameNode = ns.getNameNode();
  const body = ns.getBody();
  if (!nameNode.isKind(SyntaxKind.Identifier) || !body) return;
  const used = nameNode.findReferencesAsNodes().some(ref => ref !== nameNode && !isModuleBinding(ref));
  if (!used) return; // An unused namespace is itself an unused export; its members are noise.

  for (const statement of ns.getStatements()) {
    if (!hasExportModifier(statement)) continue;
    const decls = statement.isKind(SyntaxKind.VariableStatement) ? statement.getDeclarations() : [statement];
    for (const decl of decls) {
      const declName = declarationNameNode(decl);
      if (!declName) continue;
      const refs = declName.findReferencesAsNodes().filter(ref => ref !== declName && !isModuleBinding(ref));
      const escapesBody = refs.some(
        ref =>
          ref.getSourceFile() !== ns.getSourceFile() ||
          ref.getStart() < body.getPos() ||
          ref.getStart() >= body.getEnd()
      );
      if (escapesBody) {
        if (decl.isKind(SyntaxKind.ModuleDeclaration)) collectNamespaceFindings(decl, findings, deadDecls);
        continue;
      }
      if (refs.length === 0) deadDecls.add(decl);
      const kind: FindingKind = isTypeDeclaration(decl) ? 'ns-type' : 'ns-export';
      findings.push(makeFinding(kind, declName, ns.getName(), refs.length === 0));
    }
  }
}

function makeFinding(kind: FindingKind, nameNode: Node, context: string, dead: boolean): Finding {
  const sourceFile = nameNode.getSourceFile();
  const { line, column } = sourceFile.getLineAndColumnAtPos(nameNode.getStart());
  return {
    kind,
    filePath: sourceFile.getFilePath(),
    line,
    column,
    name: nameNode.getText(),
    context,
    anonymous: false,
    dead,
    node: nameNode.getParent() ?? nameNode,
  };
}

function classifyReferences(
  nameNode: Identifier,
  sourceFile: SourceFile
): { externallyUsed: boolean; locallyUsed: boolean } {
  let locallyUsed = false;
  for (const ref of nameNode.findReferencesAsNodes()) {
    if (ref === nameNode || isModuleBinding(ref)) continue;
    if (ref.getSourceFile() !== sourceFile) return { externallyUsed: true, locallyUsed };
    locallyUsed = true;
  }
  return { externallyUsed: false, locallyUsed };
}

/** True for occurrences that only bind or forward a name (import/export sites), not real usage. */
function isModuleBinding(ref: Node): boolean {
  const parent = ref.getParent();
  if (!parent) return false;
  if (
    parent.isKind(SyntaxKind.ImportSpecifier) ||
    parent.isKind(SyntaxKind.ExportSpecifier) ||
    parent.isKind(SyntaxKind.ImportClause) ||
    parent.isKind(SyntaxKind.NamespaceImport) ||
    parent.isKind(SyntaxKind.NamespaceExport) ||
    parent.isKind(SyntaxKind.ImportEqualsDeclaration)
  ) {
    return true;
  }
  return parent.isKind(SyntaxKind.ExportAssignment) && parent.getExpression() === ref;
}

/**
 * Modules consumed through a namespace binding (`import * as ns` or
 * `export * as ns`) that is itself used. Their zero-reference exports are
 * reported at lower confidence: the namespace object may be consumed
 * dynamically.
 */
function findNamespaceConsumers(project: Project): Map<SourceFile, string> {
  const consumers = new Map<SourceFile, string>();
  for (const sourceFile of project.getSourceFiles()) {
    for (const importDecl of sourceFile.getImportDeclarations()) {
      const binding = importDecl.getNamespaceImport();
      if (!binding) continue;
      const target = importDecl.getModuleSpecifierSourceFile();
      if (!target || consumers.has(target)) continue;
      if (binding.findReferencesAsNodes().some(ref => !isModuleBinding(ref))) {
        consumers.set(target, binding.getText());
      }
    }
    for (const exportDecl of sourceFile.getExportDeclarations()) {
      const binding = exportDecl.getNamespaceExport();
      const bindingName = binding?.getNameNode();
      if (!bindingName?.isKind(SyntaxKind.Identifier)) continue;
      const target = exportDecl.getModuleSpecifierSourceFile();
      if (!target || consumers.has(target)) continue;
      if (bindingName.findReferencesAsNodes().some(ref => !isModuleBinding(ref))) {
        consumers.set(target, bindingName.getText());
      }
    }
  }
  return consumers;
}

export function declarationNameNode(decl: Node): Identifier | undefined {
  if (
    decl.isKind(SyntaxKind.FunctionDeclaration) ||
    decl.isKind(SyntaxKind.ClassDeclaration) ||
    decl.isKind(SyntaxKind.InterfaceDeclaration) ||
    decl.isKind(SyntaxKind.TypeAliasDeclaration) ||
    decl.isKind(SyntaxKind.EnumDeclaration) ||
    decl.isKind(SyntaxKind.ModuleDeclaration) ||
    decl.isKind(SyntaxKind.VariableDeclaration)
  ) {
    const nameNode = decl.getNameNode();
    if (nameNode?.isKind(SyntaxKind.Identifier)) return nameNode;
  }
  return undefined;
}

function isTypeDeclaration(decl: Node): boolean {
  return (
    decl.isKind(SyntaxKind.InterfaceDeclaration) ||
    decl.isKind(SyntaxKind.TypeAliasDeclaration) ||
    decl.isKind(SyntaxKind.EnumDeclaration)
  );
}

function isAmbient(decl: Node): boolean {
  return (ts.getCombinedModifierFlags(decl.compilerNode as ts.Declaration) & ts.ModifierFlags.Ambient) !== 0;
}

function hasExportModifier(statement: Node): boolean {
  return (ts.getCombinedModifierFlags(statement.compilerNode as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}

function commonDirectory(sourceFiles: SourceFile[]): string {
  const dirs = sourceFiles.map(sf => path.dirname(sf.getFilePath()).split('/'));
  if (dirs.length === 0) return '/';
  let prefix = dirs[0];
  for (const segments of dirs.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < segments.length && prefix[i] === segments[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix.join('/') || '/';
}
