import path from 'node:path';
import type {
  ExportDeclaration,
  Identifier,
  ImportDeclaration,
  ModuleDeclaration,
  Node,
  Project,
  SourceFile,
  StringLiteral,
} from 'ts-morph';
import { ModuleDeclarationKind, SyntaxKind, ts } from 'ts-morph';
import { valueUsesStayLocal } from '../collectors/escape';
import { descendantsOfKind } from '../lookup/descendants';
import { hasDeclarationSibling, isOwnDeclarationFile } from '../lookup/files';
import { findDefaultExportReferences, findReferencesAsNodes } from '../lookup/references';
import type { Boundary, ExportFinding, Finding, TypeKeyword } from '../types';
import type { DependencyUse } from './dependencies';
import { analyzeDependencies } from './dependencies';
import { packageEntryPoints } from './entry-points';
import { hostFileSystem } from './file-system';
import { lineAndColumnAt } from './location';
import type { OutsideReach } from './outside';
import { readOutside, takenOutside } from './outside';
import type { PackageConfig } from './project';
import { optionsForDir, pathAliasPatterns } from './project';
import { commonDirectory, isEntryFile, isHarnessFile, reachableFiles } from './reachability';
import { isFileSuppressed, isNodeSuppressed } from './suppress';
import { runtimeSibling } from './text';
import { configReader } from './tool-configs';
import { workspaceSiblings } from './workspaces';

/** How a module is consumed through an `import * as ns` / `export * as ns` binding. */
interface NamespaceUse {
  /** The binding name, quoted back in the finding as the namespace it belongs to. */
  alias: string;
  /**
   * True when a consumer takes the namespace object whole — passes it as an
   * argument, stores it, spreads it. Its keys can be enumerated at run time
   * from there, so nothing inside it can be called unused.
   */
  opaque: boolean;
}

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
  const referenced = sourceFile.getReferencedSourceFiles();
  const targets = referenced.filter(target => !target.isDeclarationFile());
  const seen = new Set<SourceFile>();
  for (const target of referenced) {
    if (!target.isDeclarationFile()) continue;
    const sibling = runtimeSibling(target.getFilePath());
    const implementation = sibling && byPath.get(sibling);
    if (implementation) targets.push(implementation);
    else if (isOwnDeclarationFile(target)) reachedThrough(target, targets, seen);
  }
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

/**
 * The files a project's own declaration file names.
 *
 * A `.d.ts` is not a node in this graph — nothing imports one for its runtime,
 * and the file list a run starts from leaves them all out. Where the project
 * wrote one itself it is a pane of glass instead: importing it reaches
 * whatever it names, however many declaration files deep that goes. Without
 * that, a module only a `.d.ts` imports has no importer at all.
 */
function reachedThrough(declaration: SourceFile, targets: SourceFile[], seen: Set<SourceFile>): void {
  if (seen.has(declaration)) return;
  seen.add(declaration);
  for (const onward of declaration.getReferencedSourceFiles()) {
    if (!onward.isDeclarationFile()) targets.push(onward);
    else if (isOwnDeclarationFile(onward)) reachedThrough(onward, targets, seen);
  }
}

export function analyzeModules(project: Project, options: ModuleOptions = {}): ModuleAnalysis {
  const sourceFiles = project.getSourceFiles().filter(sf => !sf.isDeclarationFile());
  // A package can publish a declaration file — `types: './index.d.ts'` — and
  // a re-export can name one. They are not nodes in the import graph, but a
  // config naming one names a real file, and an entry file's exports are
  // public API whichever kind of file holds them.
  const ownDeclarations = project.getSourceFiles().filter(isOwnDeclarationFile);
  const fallbackRoot = commonDirectory(sourceFiles.map(sf => sf.getFilePath()));
  const rootDirs = options.rootDirs?.length ? options.rootDirs : [fallbackRoot];
  const byPath = new Map(sourceFiles.map(sf => [sf.getFilePath(), sf]));
  const known = new Set([...byPath.keys(), ...ownDeclarations.map(sf => sf.getFilePath())]);
  const fileSystem = hostFileSystem(project.getFileSystem());
  const reader = configReader(fileSystem);
  const declared = rootDirs.flatMap(dir =>
    packageEntryPoints(
      dir,
      fallbackRoot,
      optionsForDir(options.packages ?? [], dir) ?? project.getCompilerOptions(),
      known,
      reader,
      rootDirs
    )
  );
  const entries = [...(options.entries ?? []), ...declared.map(entry => entry.filePath)];
  // The entries the product itself is reached through. A config's are left
  // out: a path in one is read at face value, and a coverage exclude list is
  // paths that are the opposite of an entry point.
  const shippingEntries = [
    ...(options.entries ?? []),
    ...declared.filter(entry => !entry.harness).map(entry => entry.filePath),
  ];
  // What the tsconfig left out still imports the project. Nothing in those
  // files is analyzed, and what they import is used all the same.
  const outside = readOutside(new Set(project.getSourceFiles().map(sf => sf.getFilePath())), {
    rootDirs,
    packages: options.packages ?? [],
    fallbackOptions: project.getCompilerOptions(),
    siblingDirs: workspaceSiblings(rootDirs, fileSystem),
    fileSystem,
  });
  // A production run treats a harness as absent wherever it sits, so only the
  // shipped half of the code beside the program answers for anything.
  const reached = options.production ? outside.shipped : outside.all;
  const imports = new Map<SourceFile, SourceFile[]>();
  const importsOf = (sourceFile: SourceFile): SourceFile[] => {
    let found = imports.get(sourceFile);
    if (!found) {
      found = importedFiles(sourceFile, project, byPath, options.packages ?? []);
      imports.set(sourceFile, found);
    }
    return found;
  };
  const reachable = reachableFiles(
    sourceFiles,
    sourceFile => {
      const filePath = sourceFile.getFilePath();
      return (
        isEntryFile(filePath, rootDirs, entries) ||
        (!options.production && isHarnessFile(filePath, rootDirs)) ||
        reached.targets.has(filePath) ||
        isFileSuppressed(sourceFile)
      );
    },
    importsOf
  );
  // The same walk without the harness roots: what the shipped product can
  // reach. A file outside it imports nothing the product needs, whatever the
  // directory is called.
  const shipping = shippingPath(sourceFiles, rootDirs, shippingEntries, outside.shipped, importsOf);
  const namespaceConsumers = findNamespaceConsumers(project);

  const findings: Finding[] = [];
  const deadFiles = new Set<SourceFile>();
  const deadDecls = new Set<Node>();
  const publicDecls = publicApiDeclarations([...sourceFiles, ...ownDeclarations], rootDirs, entries);
  // A module handed to a runtime consumer as one object — `import * as schema`
  // then `orm(db, { schema })` — is read key by key by code no reference search
  // can see. Its exports stand on the same footing as public API.
  for (const [target, use] of namespaceConsumers) {
    if (use.opaque) publicDecls.add(target);
  }
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
    // An implementation a declaration file describes answers through it, not
    // for itself. Every import lands on the declaration, so the names here
    // cannot collect a reference whatever the module's users do.
    if (hasDeclarationSibling(sourceFile)) continue;

    collectExportFindings(
      sourceFile,
      namespaceConsumers.get(sourceFile)?.alias,
      findings,
      deadDecls,
      publicDecls,
      harnessFiles,
      options.production ?? false,
      outside.shipped.names.get(filePath),
      options.production ? undefined : outside.all.names.get(filePath)
    );
    for (const ns of sourceFile.getModules()) {
      if (publicDecls.has(ns)) continue;
      collectNamespaceFindings(ns, findings, deadDecls);
    }
  }

  // The project's own declaration files, which the walk above cannot hold.
  // A `.d.ts` is not a node in the import graph — nothing imports one for its
  // runtime, and the file list a run starts from leaves them all out — so the
  // dead-file question is not one it can be asked. Its exports are another
  // matter: they are imported by name like any module's, and answer the same
  // way. Only the ones an import reached are here at all.
  for (const sourceFile of ownDeclarations) {
    const filePath = sourceFile.getFilePath();
    if (options.scopeDir && !filePath.startsWith(options.scopeDir)) continue;
    if (isEntryFile(filePath, rootDirs, entries)) continue;
    if (options.production && harnessFiles.has(sourceFile)) continue;
    if (isFileSuppressed(sourceFile)) continue;
    if (publicDecls.has(sourceFile)) continue;
    collectExportFindings(
      sourceFile,
      namespaceConsumers.get(sourceFile)?.alias,
      findings,
      deadDecls,
      publicDecls,
      harnessFiles,
      options.production ?? false,
      outside.shipped.names.get(filePath),
      options.production ? undefined : outside.all.names.get(filePath)
    );
  }

  const host = project.getFileSystem();
  findings.push(
    ...analyzeDependencies(
      [...dependencyUses(project), ...outside.uses],
      rootDirs,
      {
        scopeDir: options.scopeDir,
        ignore: options.ignoreDependencies ?? [],
        aliasPatterns: pathAliasPatterns(options.packages ?? [], project.getCompilerOptions()),
        production: options.production,
        offShippingPath: shipping,
      },
      {
        fileExists: filePath => host.fileExistsSync(filePath),
        readFile: filePath => host.readFileSync(filePath),
        isSuppressedAt: (filePath, offset) => {
          const sourceFile = project.getSourceFile(filePath);
          const node = sourceFile?.getDescendantAtPos(offset);
          return node !== undefined && isNodeSuppressed(node);
        },
        positionAt: (filePath, offset) => lineAndColumnAt(project.getSourceFileOrThrow(filePath), offset),
        configStrings: dir => reader.strings(dir),
        bundlerExternals: dir => reader.externals(dir),
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
      for (const decl of declarations) {
        publicDecls.add(decl);
        // `export default { … }` resolves to the value. The statement that
        // exports it is what the default-export check holds, so it is public
        // API on the same terms.
        const holder = decl.getParent();
        if (holder?.isKind(SyntaxKind.ExportAssignment)) publicDecls.add(holder);
      }
    }
  }
  return publicDecls;
}

/**
 * Files no chain of imports from an entry point reaches, or nothing when the
 * run resolved no entry point at all.
 *
 * With no root there is no reachability to read, and answering "nothing
 * ships" would turn every dependency into a misplaced one. So the question
 * goes unanswered, which is what the empty set means to every reader of it.
 */
function shippingPath(
  sourceFiles: SourceFile[],
  rootDirs: string[],
  entries: string[],
  outside: OutsideReach,
  importsOf: (sourceFile: SourceFile) => SourceFile[]
): ReadonlySet<string> | undefined {
  const isRoot = (sourceFile: SourceFile): boolean => {
    const filePath = sourceFile.getFilePath();
    return isEntryFile(filePath, rootDirs, entries) || outside.targets.has(filePath) || isFileSuppressed(sourceFile);
  };
  if (!sourceFiles.some(sourceFile => isEntryFile(sourceFile.getFilePath(), rootDirs, entries))) return undefined;
  const reached = reachableFiles(sourceFiles, isRoot, importsOf);
  return new Set(
    sourceFiles.filter(sourceFile => !reached.has(sourceFile)).map(sourceFile => sourceFile.getFilePath())
  );
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
  production: boolean,
  /** Names a shipped file outside the program takes from this one. */
  outsideNames: ReadonlySet<string> | undefined,
  /**
   * The same, counting the harness files outside as well. A name only those
   * take is a name only tests use, which is a verdict rather than silence.
   */
  outsideOrHarnessNames: ReadonlySet<string> | undefined
): void {
  const seen = new Set<Node>();
  for (const [exportedAs, declarations] of sourceFile.getExportedDeclarations()) {
    // A name the program never sees imported may still be imported, by a file
    // the tsconfig left out. Nothing here can be called private, or dead.
    if (takenOutside(outsideNames, exportedAs)) continue;
    // Taken by an excluded test and by nothing else: where the test sits is
    // not what decides the verdict, so this answers the way an in-program test
    // would. Whether the name is used locally as well is still the loop's own
    // question, so the flag rides in rather than short-circuiting here.
    const harnessTook = takenOutside(outsideOrHarnessNames, exportedAs);
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
      const onlyHarnessUses = testOnly || harnessTook;

      const typeKind = typeKeyword(decl);
      const kind: ExportFinding['kind'] = namespaceAlias
        ? typeKind
          ? 'ns-type'
          : 'ns-export'
        : typeKind
          ? 'type'
          : 'export';
      if (onlyHarnessUses) {
        // Production code in its own file justifies the declaration; tests
        // importing it on top of that make it simply used.
        if (locallyUsed) continue;
        // So does a harness declaration the harness consumes: a fixture whose
        // only callers are tests is what a fixture is. The verdict is for
        // shipping code the tests alone keep alive.
        if (harnessFiles.has(sourceFile)) continue;
        findings.push({
          ...makeFinding(kind, namedExport(nameNode), namespaceAlias ?? '', false, typeKind),
          verdict: 'test-only',
          evidence: 'only test files reference it',
        });
        continue;
      }

      // In a declaration file the `export` keyword is what makes the file a
      // module rather than a script of globals, so it is never the dead part
      // on its own: dropping it would change the meaning of every declaration
      // beside it. Such a file answers the dead question and no other.
      if (locallyUsed && sourceFile.isDeclarationFile()) continue;
      if (!locallyUsed) deadDecls.add(decl);
      findings.push(makeFinding(kind, namedExport(nameNode), namespaceAlias ?? '', !locallyUsed, typeKind));
    }
  }

  if (takenOutside(outsideNames, 'default')) return;
  collectDefaultExportFinding(
    sourceFile,
    namespaceAlias,
    findings,
    deadDecls,
    publicDecls,
    harnessFiles,
    production,
    takenOutside(outsideOrHarnessNames, 'default')
  );
}

/**
 * The one export the walk above cannot reach: a default export with no name.
 *
 * Nothing local can use it — there is no name to use — so it is dead or it is
 * imported, with no third answer and no `over-exported` to report.
 */
function collectDefaultExportFinding(
  sourceFile: SourceFile,
  namespaceAlias: string | undefined,
  findings: Finding[],
  deadDecls: Set<Node>,
  publicDecls: Set<Node>,
  harnessFiles: Set<SourceFile>,
  production: boolean,
  /** An excluded test imports the default, and nothing shipped does. */
  harnessTook: boolean
): void {
  // A harness file is loaded by a tool rather than imported, and the default
  // export is how a tool takes its input: a vitest config, a storybook story,
  // a playwright project. Nothing inside the project will ever name it, which
  // is the same reason an entry file's exports are left alone.
  if (harnessFiles.has(sourceFile)) return;

  const declaration = unnamedDefaultExport(sourceFile);
  if (!declaration || publicDecls.has(declaration) || isAmbient(declaration)) return;
  if (isNodeSuppressed(declaration)) return;

  let harnessUsed = harnessTook;
  for (const ref of findDefaultExportReferences(declaration)) {
    if (isModuleBinding(ref)) continue;
    if (harnessFiles.has(ref.getSourceFile())) harnessUsed = true;
    else return;
  }
  const anchor = defaultExport(declaration);
  const kind = namespaceAlias ? 'ns-export' : 'export';
  if (harnessUsed && !production) {
    findings.push({
      ...makeFinding(kind, anchor, namespaceAlias ?? '', false),
      verdict: 'test-only',
      evidence: 'only test files reference it',
    });
    return;
  }
  deadDecls.add(declaration);
  findings.push(makeFinding(kind, anchor, namespaceAlias ?? '', true));
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
        makeFinding(
          typeKind ? 'ns-type' : 'ns-export',
          namedExport(declName),
          ns.getName(),
          refs.length === 0,
          typeKind
        )
      );
    }
  }
}

/** Where an export finding points, what it is called, and the node a fix acts on. */
interface ExportAnchor {
  at: Node;
  name: string;
  node: Node;
}

/** A named export answers all three with its identifier. */
function namedExport(nameNode: Node): ExportAnchor {
  return { at: nameNode, name: nameNode.getText(), node: nameNode.getParent() ?? nameNode };
}

/**
 * An export with no name of its own: `export default class { … }`. `default`
 * is the module system's word for it rather than the author's, and the
 * statement that exports it is both where the finding points and what a fix
 * takes away.
 */
function defaultExport(declaration: Node): ExportAnchor {
  return { at: declaration, name: 'default', node: declaration };
}

function makeFinding(
  kind: ExportFinding['kind'],
  anchor: ExportAnchor,
  context: string,
  dead: boolean,
  typeKind?: TypeKeyword
): ExportFinding {
  const sourceFile = anchor.at.getSourceFile();
  const { line, column } = lineAndColumnAt(sourceFile, anchor.at.getStart());
  return {
    kind,
    filePath: sourceFile.getFilePath(),
    line,
    column,
    name: anchor.name,
    context,
    anonymous: false,
    dead,
    typeKind,
    verdict: dead ? 'dead' : 'over-exported',
    evidence: dead ? 'zero references anywhere' : 'every reference sits inside its own file',
    node: anchor.node,
  };
}

/**
 * The default export of this file, when nothing names it.
 *
 * `export default class Greeter { … }` and `export default box` both hand the
 * question to a declaration with a name, and the main walk answers there.
 * What is left is the export that answers to nothing else: an anonymous
 * class or function, an object literal, an arrow, a bare value.
 */
function unnamedDefaultExport(sourceFile: SourceFile): Node | undefined {
  const declaration = sourceFile.getDefaultExportSymbol()?.getDeclarations()[0];
  if (!declaration || declarationNameNode(declaration)) return undefined;
  if (declaration.isKind(SyntaxKind.ExportAssignment)) {
    if (declaration.isExportEquals()) return undefined;
    // `export default box` forwards a declaration that has a name of its own,
    // and that name is where the finding belongs.
    if (declaration.getExpression().isKind(SyntaxKind.Identifier)) return undefined;
  }
  return declaration;
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
function findNamespaceConsumers(project: Project): Map<SourceFile, NamespaceUse> {
  const consumers = new Map<SourceFile, NamespaceUse>();
  const record = (target: SourceFile | undefined, binding: Identifier): void => {
    if (!target) return;
    const refs = findReferencesAsNodes(binding).filter(ref => !isModuleBinding(ref));
    if (refs.length === 0) return;
    const seen = consumers.get(target);
    const opaque = !valueUsesStayLocal(binding);
    if (!seen) consumers.set(target, { alias: binding.getText(), opaque });
    else if (opaque) seen.opaque = true;
  };
  for (const sourceFile of project.getSourceFiles()) {
    for (const importDecl of sourceFile.getImportDeclarations()) {
      const binding = importDecl.getNamespaceImport();
      if (binding) record(importDecl.getModuleSpecifierSourceFile(), binding);
    }
    for (const exportDecl of sourceFile.getExportDeclarations()) {
      const bindingName = exportDecl.getNamespaceExport()?.getNameNode();
      if (bindingName?.isKind(SyntaxKind.Identifier)) record(exportDecl.getModuleSpecifierSourceFile(), bindingName);
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
    // A package imported only from a project's own `.d.ts` is imported.
    if (sourceFile.isDeclarationFile() && !isOwnDeclarationFile(sourceFile)) continue;
    const filePath = sourceFile.getFilePath();
    const found: DependencyUse[] = [];
    for (const literal of sourceFile.getImportStringLiterals()) {
      const parent = literal.getParent();
      const clause =
        parent?.isKind(SyntaxKind.ImportDeclaration) || parent?.isKind(SyntaxKind.ExportDeclaration)
          ? parent
          : undefined;
      const target = clause?.getModuleSpecifierSourceFile();
      found.push({
        filePath,
        text: literal.getLiteralText(),
        start: literal.getStart(),
        typeOnly: clause !== undefined && isTypeOnlyClause(clause),
        internal: target !== undefined && !target.isInNodeModules(),
      });
    }
    for (const reference of sourceFile.getTypeReferenceDirectives()) {
      found.push({
        filePath,
        text: reference.getFileName(),
        start: reference.getPos(),
        typeOnly: true,
        internal: false,
      });
    }
    for (const literal of resolveCallLiterals(sourceFile)) {
      found.push({
        filePath,
        text: literal.getLiteralText(),
        start: literal.getStart(),
        typeOnly: false,
        internal: false,
      });
    }
    // In file order, so an unlisted package is reported at its first mention
    // whichever of the two forms wrote it.
    found.sort((a, b) => a.start - b.start);
    uses.push(...found);
  }
  return uses;
}

/**
 * The packages `require.resolve('pkg')` names. It loads nothing, so it is no
 * import — and it is still the project saying that package must be installed,
 * which is the only question the dependency checks ask. A tool pointed at a
 * parser by path is usually the project's one mention of it.
 */
function resolveCallLiterals(sourceFile: SourceFile): StringLiteral[] {
  // The walk is worth its cost only for a file that writes the call at all.
  if (!sourceFile.getFullText().includes('require.resolve')) return [];
  const found: StringLiteral[] = [];
  for (const call of descendantsOfKind(sourceFile, SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!callee.isKind(SyntaxKind.PropertyAccessExpression)) continue;
    if (callee.getName() !== 'resolve' || callee.getExpression().getText() !== 'require') continue;
    const [argument] = call.getArguments();
    if (argument?.isKind(SyntaxKind.StringLiteral)) found.push(argument);
  }
  return found;
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
