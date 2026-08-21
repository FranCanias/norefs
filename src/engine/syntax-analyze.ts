import fs from 'node:fs';
import path from 'node:path';
import type { ts } from 'ts-morph';
import type { Finding, FindingKind } from '../types';
import type { DependencyUse } from './dependencies';
import { analyzeDependencies } from './dependencies';
import type { EntryPoint } from './entry-points';
import { packageEntryPoints } from './entry-points';
import { diskFileSystem } from './file-system';
import type { PackageConfig } from './project';
import { optionsForDir, pathAliasPatterns } from './project';
import { commonDirectory, isEntryFile, isHarnessFile, reachableFiles } from './reachability';
import { projectFilePaths, SourceIndex } from './sources';
import { configReader } from './tool-configs';

/** The findings the syntax alone decides — no type checker is involved. */
// norefs-ignore: the test suite imports it, outside this tsconfig
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
  const filePaths = projectFilePaths(tsConfigFilePaths);
  const packages = options.packages ?? [];
  const sources = new SourceIndex(filePaths, packages, fallbackOptions);

  const fallbackRoot = commonDirectory(filePaths);
  const rootDirs = options.rootDirs?.length ? options.rootDirs : [fallbackRoot];
  const known = new Set(filePaths);
  const reader = configReader(diskFileSystem);
  const entries = [
    ...(options.entries ?? []),
    ...rootDirs.flatMap(dir =>
      packageEntryPoints(dir, fallbackRoot, optionsForDir(packages, dir) ?? fallbackOptions, known, reader).map(
        entry => entry.filePath
      )
    ),
  ];

  const reachable = reachableFiles(
    filePaths,
    filePath =>
      isEntryFile(filePath, rootDirs, entries) ||
      (!options.production && isHarnessFile(filePath, rootDirs)) ||
      sources.isFileSuppressed(filePath),
    filePath => sources.importsOf(filePath).flatMap(entry => (entry.target ? [entry.target] : []))
  );

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

  findings.push(
    ...analyzeDependencies(
      uses,
      rootDirs,
      {
        scopeDir: options.scopeDir,
        ignore: options.ignoreDependencies ?? [],
        aliasPatterns: pathAliasPatterns(packages, fallbackOptions),
        production: options.production,
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
  const filePaths = projectFilePaths(tsConfigFilePaths);
  const packages = options.packages ?? [];
  const fallbackRoot = commonDirectory(filePaths);
  const rootDirs = options.rootDirs?.length ? options.rootDirs : [fallbackRoot];
  const known = new Set(filePaths);
  const reader = configReader(diskFileSystem);

  const discovered = new Map<string, string>();
  for (const dir of rootDirs) {
    for (const entry of packageEntryPoints(
      dir,
      fallbackRoot,
      optionsForDir(packages, dir) ?? fallbackOptions,
      known,
      reader
    )) {
      if (!discovered.has(entry.filePath)) discovered.set(entry.filePath, entry.source);
    }
  }

  const asked = options.entries ?? [];
  const entries: EntryPoint[] = [];
  for (const filePath of filePaths) {
    const source = asked.some(entry => filePath === entry || filePath.startsWith(`${entry}/`))
      ? 'asked for with --entry'
      : (discovered.get(filePath) ??
        (isEntryFile(filePath, rootDirs, []) ? 'index/main/cli beside a tsconfig' : undefined));
    if (source) entries.push({ filePath, source });
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
