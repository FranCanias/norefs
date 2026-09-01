import fs from 'node:fs';
import path from 'node:path';
import type { ts } from 'ts-morph';
import type { Finding, FindingKind } from '../types';
import type { DependencyUse } from './dependencies';
import { analyzeDependencies } from './dependencies';
import type { EntryPoint } from './entry-points';
import { packageEntryPoints } from './entry-points';
import { diskFileSystem } from './file-system';
import type { OutsideReach } from './outside';
import { readOutside } from './outside';
import type { PackageConfig } from './project';
import { optionsForDir, pathAliasPatterns } from './project';
import { commonDirectory, isEntryFile, isHarnessFile, reachableFiles } from './reachability';
import { projectFiles, SourceIndex } from './sources';
import { configReader } from './tool-configs';
import { workspaceSiblings } from './workspaces';

/** The findings the syntax alone decides — no type checker is involved. */
export const SYNTAX_KINDS: FindingKind[] = ['file', 'dependency', 'unlisted', 'misplaced'];

/** True when every requested kind can be answered without a type checker. */
export function isSyntaxOnly(kinds: FindingKind[] | undefined): boolean {
  return kinds !== undefined && kinds.length > 0 && kinds.every(kind => SYNTAX_KINDS.includes(kind));
}

interface SyntaxOptions {
  scopeDir?: string | undefined;
  entries?: string[] | undefined;
  rootDirs?: string[] | undefined;
  packages?: PackageConfig[] | undefined;
  ignoreDependencies?: string[] | undefined;
  /** Treat harness files as absent: the shipping code path alone. */
  production?: boolean | undefined;
}

/**
 * Unused files, unused dependencies, and unlisted imports, read from the
 * source text alone.
 *
 * The full analysis builds a TypeScript program to answer these, which costs
 * seconds and gigabytes for facts the text already carries. Here a single-pass
 * scanner reads every file, the compiler resolves the specifiers it found,
 * and the import graph answers the rest.
 */
export function analyzeSyntax(
  tsConfigFilePaths: string[],
  fallbackOptions: ts.CompilerOptions,
  options: SyntaxOptions = {}
): Finding[] {
  const { sources: filePaths, declarations } = projectFiles(tsConfigFilePaths);
  const packages = options.packages ?? [];
  const sources = new SourceIndex(filePaths, packages, fallbackOptions);

  const fallbackRoot = commonDirectory(filePaths);
  const rootDirs = options.rootDirs?.length ? options.rootDirs : [fallbackRoot];
  // A manifest can publish a declaration file — `types: './index.d.ts'` — so
  // an entry the config names is looked for among those too.
  const known = new Set([...filePaths, ...declarations]);
  const reader = configReader(diskFileSystem);
  const declared = rootDirs.flatMap(dir =>
    packageEntryPoints(dir, fallbackRoot, optionsForDir(packages, dir) ?? fallbackOptions, known, reader, rootDirs)
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
  const outside = readOutside(known, {
    rootDirs,
    packages,
    fallbackOptions,
    siblingDirs: workspaceSiblings(rootDirs, diskFileSystem),
    fileSystem: diskFileSystem,
  });
  // A production run treats a harness as absent wherever it sits, so only the
  // shipped half of the code beside the program answers for anything.
  const reached = options.production ? outside.shipped : outside.all;

  const importedFiles = (filePath: string): string[] =>
    sources.importsOf(filePath).flatMap(entry => (entry.target ? [entry.target] : []));
  const reachable = reachableFiles(
    filePaths,
    filePath =>
      isEntryFile(filePath, rootDirs, entries) ||
      (!options.production && isHarnessFile(filePath, rootDirs)) ||
      reached.targets.has(filePath) ||
      sources.isFileSuppressed(filePath),
    importedFiles
  );
  // The same walk without the harness roots: what the shipped product can
  // reach. A file outside it imports nothing the product needs, whatever the
  // directory is called. With no entry point there is no reachability to
  // read, so the question goes unanswered rather than answered wrongly.
  const shipping = shippingPath(filePaths, rootDirs, shippingEntries, outside.shipped, sources, importedFiles);

  const findings: Finding[] = [];
  const uses: DependencyUse[] = [];
  for (const filePath of filePaths) {
    for (const entry of sources.importsOf(filePath)) {
      uses.push({
        filePath,
        text: entry.specifier.text,
        start: entry.specifier.start,
        typeOnly: entry.specifier.typeOnly,
        internal: entry.resolved && !entry.external,
      });
    }
    for (const reference of sources.typeReferencesOf(filePath)) {
      uses.push({ filePath, text: reference.text, start: reference.start, typeOnly: true, internal: false });
    }

    if (options.scopeDir && !filePath.startsWith(options.scopeDir)) continue;
    if (isEntryFile(filePath, rootDirs, entries)) continue;
    if (options.production && isHarnessFile(filePath, rootDirs)) continue;
    if (sources.isFileSuppressed(filePath)) continue;
    if (reachable.has(filePath)) continue;
    findings.push({
      kind: 'file',
      filePath,
      line: 1,
      column: 1,
      name: path.basename(filePath),
      context: '',
      anonymous: false,
      verdict: 'dead',
      evidence: 'no chain of imports from any entry point reaches it',
    });
  }

  uses.push(...outside.uses);
  findings.push(
    ...analyzeDependencies(
      uses,
      rootDirs,
      {
        scopeDir: options.scopeDir,
        ignore: options.ignoreDependencies ?? [],
        aliasPatterns: pathAliasPatterns(packages, fallbackOptions),
        production: options.production,
        offShippingPath: shipping,
      },
      {
        fileExists: filePath => fs.existsSync(filePath),
        readFile: filePath => readFile(filePath),
        isSuppressedAt: (filePath, offset) => sources.isSuppressedAt(filePath, offset),
        positionAt: (filePath, offset) => sources.positionAt(filePath, offset),
        configStrings: dir => reader.strings(dir),
        bundlerExternals: dir => reader.externals(dir),
      }
    )
  );

  findings.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line || a.column - b.column);
  return findings;
}

/**
 * Every entry point of the project, and the thing that named each one.
 *
 * Discovery that cannot be inspected is discovery nobody can trust: an entry
 * point silently makes a file used and its exports public API, so a wrong one
 * hides findings without leaving a trace. This is what `norefs entries` prints.
 * It reads the text alone, so the audit costs no type checker.
 */
export function listEntryPoints(
  tsConfigFilePaths: string[],
  fallbackOptions: ts.CompilerOptions,
  options: SyntaxOptions = {}
): EntryPoint[] {
  const { sources: filePaths, declarations } = projectFiles(tsConfigFilePaths);
  const packages = options.packages ?? [];
  const fallbackRoot = commonDirectory(filePaths);
  const rootDirs = options.rootDirs?.length ? options.rootDirs : [fallbackRoot];
  const known = new Set([...filePaths, ...declarations]);
  const reader = configReader(diskFileSystem);

  const discovered = new Map<string, EntryPoint>();
  for (const dir of rootDirs) {
    for (const entry of packageEntryPoints(
      dir,
      fallbackRoot,
      optionsForDir(packages, dir) ?? fallbackOptions,
      known,
      reader,
      rootDirs
    )) {
      if (!discovered.has(entry.filePath)) discovered.set(entry.filePath, entry);
    }
  }

  const asked = options.entries ?? [];
  const entries: EntryPoint[] = [];
  for (const filePath of [...filePaths, ...declarations]) {
    if (asked.some(entry => filePath === entry || filePath.startsWith(`${entry}/`))) {
      entries.push({ filePath, source: 'asked for with --entry', harness: false });
      continue;
    }
    const discoveredEntry = discovered.get(filePath);
    if (discoveredEntry) entries.push(discoveredEntry);
    else if (isEntryFile(filePath, rootDirs, [])) {
      entries.push({ filePath, source: 'index/main/cli beside a tsconfig', harness: false });
    }
  }
  return entries;
}

function readFile(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Files no chain of imports from an entry point reaches, or nothing when the
 * run resolved no entry point at all.
 *
 * With no root there is no reachability to read, and answering "nothing
 * ships" would turn every dependency into a misplaced one. So the question
 * goes unanswered, which is what nothing means to every reader of it.
 */
function shippingPath(
  filePaths: string[],
  rootDirs: string[],
  entries: string[],
  outside: OutsideReach,
  sources: SourceIndex,
  importedFiles: (filePath: string) => string[]
): ReadonlySet<string> | undefined {
  if (!filePaths.some(filePath => isEntryFile(filePath, rootDirs, entries))) return undefined;
  const reached = reachableFiles(
    filePaths,
    filePath =>
      isEntryFile(filePath, rootDirs, entries) || outside.targets.has(filePath) || sources.isFileSuppressed(filePath),
    importedFiles
  );
  return new Set(filePaths.filter(filePath => !reached.has(filePath)));
}
