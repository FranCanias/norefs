import path from 'node:path';
import type {
  ExportDeclaration,
  Identifier,
  ImportDeclaration,
  ModuleDeclaration,
  Node,
  Project,
  SourceFile,
} from 'ts-morph';
import { ModuleDeclarationKind, SyntaxKind, ts } from 'ts-morph';
import { findReferencesAsNodes } from '../lookup/references';
import type { Boundary, ExportFinding, Finding, TypeKeyword } from '../types';
import type { DependencyUse } from './dependencies';
import { analyzeDependencies } from './dependencies';
import { packageEntryPoints } from './entry-points';
import { hostFileSystem } from './file-system';
import { lineAndColumnAt } from './location';
import type { PackageConfig } from './project';
import { optionsForDir, pathAliasPatterns } from './project';
import { commonDirectory, isEntryFile, isHarnessFile, reachableFiles } from './reachability';
import { isFileSuppressed, isNodeSuppressed } from './suppress';
import { configReader } from './tool-configs';

interface ModuleAnalysis {
  findings: Finding[];
  /** Files reported unused; member analysis skips everything inside them. */
  deadFiles: Set<SourceFile>;
  /** Declarations with zero references anywhere; member analysis skips their insides. */
  deadDecls: Set<Node>;
  /**
   * The public API: every declaration an entry file exports, star re-export
   * chains included. Their consumers live outside this program, so neither
   * they nor their members can be called unused.
   */
  publicDecls: Set<Node>;
  /** Test, spec, stories, bench, and config files: never worth member findings. */
  harnessFiles: Set<SourceFile>;
}

export interface ModuleOptions {
  /** Only report findings declared under this absolute path prefix. */
  scopeDir?: string | undefined;
  /** Absolute paths (files or directories) treated as entry points. */
  entries?: string[] | undefined;
  /** Directories that anchor the entry-file and harness-file patterns — one per tsconfig. */
  rootDirs?: string[] | undefined;
  /** Per-package compiler options; each package's manifest entries map through its own outDir. */
  packages?: PackageConfig[] | undefined;
  /** Dependency names or globs the dependency checks never report. */
  ignoreDependencies?: string[] | undefined;
  /** Channel boundaries the project declared, for the stranded-handler pairing. */
  boundaries?: Boundary[] | undefined;
  /**
   * Analyze the shipping code path alone: test, spec, stories, bench, config
   * files and everything under a test directory are treated as absent. They
   * stop keeping code reachable, they stop counting as usage, and they report
   * nothing of their own.
   */
  production?: boolean | undefined;
}

/**
 * The project files a file imports.
 *
 * `getReferencedSourceFiles` answers from the type system, and the type system
 * links a specifier only to a *module*. A file with no import and no export of
 * its own is a script, so `import './routes'` — how a route table or a polyfill
 * gets registered — resolves to nothing, and the file it names looks unreached.
 * The compiler's own resolver holds no such opinion, and the syntax-only run
 * has always used it. Asking it for the specifiers the type system dropped is
 * what makes the two runs agree.
 */
function importedFiles(
  sourceFile: SourceFile,
  project: Project,
  byPath: Map<string, SourceFile>,
  packages: PackageConfig[]
): SourceFile[] {
  const targets = sourceFile.getReferencedSourceFiles().filter(target => !target.isDeclarationFile());
  // The options of the package owning the importing file, exactly as the
  // project used when it loaded: a run spanning several tsconfigs resolves
  // each package's `paths` with that package's own options, and a fallback
  // that reached for the first tsconfig's could call a live file dead.
  const options = optionsForDir(packages, path.dirname(sourceFile.getFilePath())) ?? project.getCompilerOptions();
  for (const declaration of sourceFile.getImportDeclarations()) {
    if (declaration.getModuleSpecifierSourceFile()) continue;
    const resolved = ts.resolveModuleName(
      declaration.getModuleSpecifierValue(),
      sourceFile.getFilePath(),
      options,
      project.getModuleResolutionHost()
    ).resolvedModule;
    const target = resolved && byPath.get(resolved.resolvedFileName);
    if (target) targets.push(target);
  }
  return targets;
}

export function analyzeModules(project: Project, options: ModuleOptions = {}): ModuleAnalysis {
  const sourceFiles = project.getSourceFiles().filter(sf => !sf.isDeclarationFile());
  const fallbackRoot = commonDirectory(sourceFiles.map(sf => sf.getFilePath()));
  const rootDirs = options.rootDirs?.length ? options.rootDirs : [fallbackRoot];
  const byPath = new Map(sourceFiles.map(sf => [sf.getFilePath(), sf]));
  const known = new Set(byPath.keys());
  const reader = configReader(hostFileSystem(project.getFileSystem()));
  const entries = [
    ...(options.entries ?? []),
    ...rootDirs.flatMap(dir =>
      packageEntryPoints(
        dir,
        fallbackRoot,
        optionsForDir(options.packages ?? [], dir) ?? project.getCompilerOptions(),
        known,
        reader
      ).map(entry => entry.filePath)
    ),
  ];
  const reachable = reachableFiles(
    sourceFiles,
    sourceFile => {
      const filePath = sourceFile.getFilePath();
      return (
        isEntryFile(filePath, rootDirs, entries) ||
        (!options.production && isHarnessFile(filePath, rootDirs)) ||
        isFileSuppressed(sourceFile)
      );
    },
    sourceFile => importedFiles(sourceFile, project, byPath, options.packages ?? [])
  );
  const namespaceConsumers = findNamespaceConsumers(project);

  const findings: Finding[] = [];
  const deadFiles = new Set<SourceFile>();
  const deadDecls = new Set<Node>();
  const publicDecls = publicApiDeclarations(sourceFiles, rootDirs, entries);
  const harnessFiles = new Set(sourceFiles.filter(sf => isHarnessFile(sf.getFilePath(), rootDirs)));

  for (const sourceFile of sourceFiles) {
    const filePath = sourceFile.getFilePath();
    if (options.scopeDir && !filePath.startsWith(options.scopeDir)) continue;
    if (isEntryFile(filePath, rootDirs, entries)) continue;
    // A file the run treats as absent reports nothing, itself included.
    if (options.production && harnessFiles.has(sourceFile)) continue;
    if (isFileSuppressed(sourceFile)) continue;

    if (!reachable.has(sourceFile)) {
      deadFiles.add(sourceFile);
      findings.push({
        kind: 'file',
        filePath,
        line: 1,
        column: 1,
        name: sourceFile.getBaseName(),
        context: '',
        anonymous: false,
        verdict: 'dead',
        evidence: 'no chain of imports from any entry point reaches it',
      });
      continue;
    }

    // A file an entry re-exports whole (`export * as ns from`) is public API
    // down to its last member.
    if (publicDecls.has(sourceFile)) continue;

    collectExportFindings(
      sourceFile,
      namespaceConsumers.get(sourceFile),
      findings,
      deadDecls,
      publicDecls,
      harnessFiles,
      options.production ?? false
    );
    for (const ns of sourceFile.getModules()) {
      if (publicDecls.has(ns)) continue;
      collectNamespaceFindings(ns, findings, deadDecls);
    }
  }

  const fileSystem = project.getFileSystem();
  findings.push(
    ...analyzeDependencies(
      dependencyUses(project),
      rootDirs,
      {
        scopeDir: options.scopeDir,
        ignore: options.ignoreDependencies ?? [],
        aliasPatterns: pathAliasPatterns(options.packages ?? [], project.getCompilerOptions()),
        production: options.production,
      },
      {
        fileExists: filePath => fileSystem.fileExistsSync(filePath),
        readFile: filePath => fileSystem.readFileSync(filePath),
        isSuppressedAt: (filePath, offset) => {
          const sourceFile = project.getSourceFile(filePath);
          const node = sourceFile?.getDescendantAtPos(offset);
          return node !== undefined && isNodeSuppressed(node);
        },
        positionAt: (filePath, offset) => lineAndColumnAt(project.getSourceFileOrThrow(filePath), offset),
        configStrings: dir => reader.strings(dir),
      }
    )
  );
  return { findings, deadFiles, deadDecls, publicDecls, harnessFiles };
}

/**
 * Every declaration an entry file exports, resolved through re-export chains
 * — `export *` included, which leaves no name references and would otherwise
 * hide the fact that a declaration is public API.
 */
function publicApiDeclarations(sourceFiles: SourceFile[], rootDirs: string[], entries: string[]): Set<Node> {
  const publicDecls = new Set<Node>();
  for (const sourceFile of sourceFiles) {
    if (!isEntryFile(sourceFile.getFilePath(), rootDirs, entries)) continue;
    for (const declarations of sourceFile.getExportedDeclarations().values()) {
      for (const decl of declarations) publicDecls.add(decl);
    }
  }
  return publicDecls;
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
  deadDecls: Set<Node>,
  publicDecls: Set<Node>,
  harnessFiles: Set<SourceFile>,
  production: boolean
): void {
  const seen = new Set<Node>();
  for (const declarations of sourceFile.getExportedDeclarations().values()) {
    for (const decl of declarations) {
      if (decl.getSourceFile() !== sourceFile || seen.has(decl)) continue;
      seen.add(decl);
      if (publicDecls.has(decl)) continue;
      if (isAmbient(decl)) continue;
      const nameNode = declarationNameNode(decl);
      if (!nameNode) continue;
      if (isNodeSuppressed(nameNode)) continue;

      const { externallyUsed, locallyUsed, testOnly } = classifyReferences(
        nameNode,
        sourceFile,
        harnessFiles,
        production
      );
      if (externallyUsed) continue;

      const typeKind = typeKeyword(decl);
      const kind: ExportFinding['kind'] = namespaceAlias
        ? typeKind
          ? 'ns-type'
          : 'ns-export'
        : typeKind
          ? 'type'
          : 'export';
      if (testOnly) {
        // Production code in its own file justifies the declaration; tests
        // importing it on top of that make it simply used.
        if (locallyUsed) continue;
        findings.push({
          ...makeFinding(kind, nameNode, namespaceAlias ?? '', false, typeKind),
          verdict: 'test-only',
          evidence: 'only test files reference it',
        });
        continue;
      }

      if (!locallyUsed) deadDecls.add(decl);
      findings.push(makeFinding(kind, nameNode, namespaceAlias ?? '', !locallyUsed, typeKind));
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
  const used = findReferencesAsNodes(nameNode).some(ref => ref !== nameNode && !isModuleBinding(ref));
  if (!used) return; // An unused namespace is itself an unused export; its members are noise.

  for (const statement of ns.getStatements()) {
    if (!hasExportModifier(statement)) continue;
    const decls = statement.isKind(SyntaxKind.VariableStatement) ? statement.getDeclarations() : [statement];
    for (const decl of decls) {
      const declName = declarationNameNode(decl);
      if (!declName) continue;
      if (isNodeSuppressed(declName)) continue;
      const refs = findReferencesAsNodes(declName).filter(ref => ref !== declName && !isModuleBinding(ref));
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
      const typeKind = typeKeyword(decl);
      findings.push(
        makeFinding(typeKind ? 'ns-type' : 'ns-export', declName, ns.getName(), refs.length === 0, typeKind)
      );
    }
  }
}

function makeFinding(
  kind: ExportFinding['kind'],
  nameNode: Node,
  context: string,
  dead: boolean,
  typeKind?: TypeKeyword
): ExportFinding {
  const sourceFile = nameNode.getSourceFile();
  const { line, column } = lineAndColumnAt(sourceFile, nameNode.getStart());
  return {
    kind,
    filePath: sourceFile.getFilePath(),
    line,
    column,
    name: nameNode.getText(),
    context,
    anonymous: false,
    dead,
    typeKind,
    verdict: dead ? 'dead' : 'over-exported',
    evidence: dead ? 'zero references anywhere' : 'every reference sits inside its own file',
    node: nameNode.getParent() ?? nameNode,
  };
}

function classifyReferences(
  nameNode: Identifier,
  sourceFile: SourceFile,
  harnessFiles: Set<SourceFile>,
  /** When true a harness reference is no reference: the declaration is unused. */
  production: boolean
): { externallyUsed: boolean; locallyUsed: boolean; testOnly: boolean } {
  let locallyUsed = false;
  let harnessUsed = false;
  for (const ref of findReferencesAsNodes(nameNode)) {
    if (ref === nameNode || isModuleBinding(ref)) continue;
    const refFile = ref.getSourceFile();
    if (refFile === sourceFile) {
      locallyUsed = true;
    } else if (harnessFiles.has(refFile)) {
      harnessUsed = true;
    } else {
      return { externallyUsed: true, locallyUsed, testOnly: false };
    }
  }
  return { externallyUsed: false, locallyUsed, testOnly: harnessUsed && !production };
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
      if (findReferencesAsNodes(binding).some(ref => !isModuleBinding(ref))) {
        consumers.set(target, binding.getText());
      }
    }
    for (const exportDecl of sourceFile.getExportDeclarations()) {
      const binding = exportDecl.getNamespaceExport();
      const bindingName = binding?.getNameNode();
      if (!bindingName?.isKind(SyntaxKind.Identifier)) continue;
      const target = exportDecl.getModuleSpecifierSourceFile();
      if (!target || consumers.has(target)) continue;
      if (findReferencesAsNodes(bindingName).some(ref => !isModuleBinding(ref))) {
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

/** The keyword behind a type declaration, or undefined for a value declaration. */
function typeKeyword(decl: Node): TypeKeyword | undefined {
  if (decl.isKind(SyntaxKind.InterfaceDeclaration)) return 'interface';
  if (decl.isKind(SyntaxKind.TypeAliasDeclaration)) return 'type';
  if (decl.isKind(SyntaxKind.EnumDeclaration)) return 'enum';
  return undefined;
}

function isAmbient(decl: Node): boolean {
  return (ts.getCombinedModifierFlags(decl.compilerNode as ts.Declaration) & ts.ModifierFlags.Ambient) !== 0;
}

function hasExportModifier(statement: Node): boolean {
  return (ts.getCombinedModifierFlags(statement.compilerNode as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}

/**
 * Imports that name a package rather than project code. A specifier resolving
 * to a project source file is a relative import or a path alias.
 */
function dependencyUses(project: Project): DependencyUse[] {
  const uses: DependencyUse[] = [];
  // Sorted, so an unlisted package is always reported at the same one of its
  // import sites however the tsconfigs happened to glob.
  const sourceFiles = [...project.getSourceFiles()].sort((a, b) => a.getFilePath().localeCompare(b.getFilePath()));
  for (const sourceFile of sourceFiles) {
    if (sourceFile.isDeclarationFile()) continue;
    for (const literal of sourceFile.getImportStringLiterals()) {
      const parent = literal.getParent();
      const clause =
        parent?.isKind(SyntaxKind.ImportDeclaration) || parent?.isKind(SyntaxKind.ExportDeclaration)
          ? parent
          : undefined;
      const target = clause?.getModuleSpecifierSourceFile();
      if (target && !target.isInNodeModules()) continue;
      uses.push({
        filePath: sourceFile.getFilePath(),
        text: literal.getLiteralText(),
        start: literal.getStart(),
        typeOnly: clause !== undefined && isTypeOnlyClause(clause),
      });
    }
  }
  return uses;
}

/**
 * True when the compiler erases the whole clause: `import type`, or braces
 * whose every binding carries `type`. A default binding, a namespace, `export
 * *`, and a bare `import 'x'` all leave the module standing at run time.
 */
function isTypeOnlyClause(clause: ImportDeclaration | ExportDeclaration): boolean {
  if (clause.isTypeOnly()) return true;
  if (clause.isKind(SyntaxKind.ExportDeclaration)) {
    if (clause.isNamespaceExport()) return false;
    const named = clause.getNamedExports();
    return named.length > 0 && named.every(specifier => specifier.isTypeOnly());
  }
  if (clause.getDefaultImport() || clause.getNamespaceImport()) return false;
  const named = clause.getNamedImports();
  return named.length > 0 && named.every(specifier => specifier.isTypeOnly());
}
