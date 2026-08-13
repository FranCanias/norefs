import fs from 'node:fs';
import path from 'node:path';
import type { ts } from 'ts-morph';
import type { Finding, FindingKind } from '../types';
import type { DependencyUse } from './dependencies';
import { analyzeDependencies } from './dependencies';
import type { PackageConfig } from './project';
import { optionsForDir, pathAliasPatterns } from './project';
import { commonDirectory, isEntryFile, isHarnessFile, reachableFiles } from './reachability';
import { SourceIndex, projectFilePaths } from './sources';

/** The findings the syntax alone decides — no type checker is involved. */
// norefs-ignore: the test suite imports it, outside this tsconfig
export const SYNTAX_KINDS: FindingKind[] = ['file', 'dependency', 'unlisted'];

/** True when every requested kind can be answered without a type checker. */
export function isSyntaxOnly(kinds: FindingKind[] | undefined): boolean {
  return kinds !== undefined && kinds.length > 0 && kinds.every(kind => SYNTAX_KINDS.includes(kind));
}

interface SyntaxOptions {
  scopeDir?: string;
  entries?: string[];
  rootDirs?: string[];
  packages?: PackageConfig[];
  ignoreDependencies?: string[];
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
  const entries = [
    ...(options.entries ?? []),
    ...rootDirs.flatMap(dir =>
      manifestEntries(dir, fallbackRoot, optionsForDir(packages, dir) ?? fallbackOptions, known)
    ),
  ];

  const reachable = reachableFiles(
    filePaths,
    filePath =>
      isEntryFile(filePath, rootDirs, entries) ||
      isHarnessFile(filePath, rootDirs) ||
      sources.isFileSuppressed(filePath),
    filePath => sources.importsOf(filePath).flatMap(entry => (entry.target ? [entry.target] : []))
  );

  const findings: Finding[] = [];
  const uses: DependencyUse[] = [];
  for (const filePath of filePaths) {
    for (const entry of sources.importsOf(filePath)) {
      if (entry.resolved && !entry.external) continue;
      uses.push({ filePath, text: entry.specifier.text, start: entry.specifier.start });
    }

    if (options.scopeDir && !filePath.startsWith(options.scopeDir)) continue;
    if (isEntryFile(filePath, rootDirs, entries)) continue;
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
      options.scopeDir,
      options.ignoreDependencies ?? [],
      pathAliasPatterns(packages, fallbackOptions),
      {
        fileExists: filePath => fs.existsSync(filePath),
        readFile: filePath => readFile(filePath),
        isSuppressedAt: (filePath, offset) => sources.isSuppressedAt(filePath, offset),
        positionAt: (filePath, offset) => sources.positionAt(filePath, offset),
      }
    )
  );

  findings.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line || a.column - b.column);
  return findings;
}

function readFile(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
const OUTPUT_EXTENSION = /\.(?:d\.ts|d\.mts|d\.cts|js|jsx|mjs|cjs)$/;

/**
 * Entry files a package.json names: main, bin, and exports. A path pointing
 * into the compiled output is mapped back to source through the package's own
 * outDir and rootDir. Only paths that land on a project file count.
 */
function manifestEntries(
  packageDir: string,
  fallbackSourceRoot: string,
  compilerOptions: ts.CompilerOptions,
  known: Set<string>
): string[] {
  const text = readFile(path.join(packageDir, 'package.json'));
  if (text === undefined) return [];
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof manifest !== 'object' || manifest === null) return [];
  const data = manifest as Record<string, unknown>;

  const candidates = new Set<string>();
  collectStrings(data.main, candidates);
  collectStrings(data.bin, candidates);
  collectStrings(data.exports, candidates);

  const outDir = compilerOptions.outDir ? path.resolve(packageDir, compilerOptions.outDir) : undefined;
  const sourceRoot = compilerOptions.rootDir ? path.resolve(packageDir, compilerOptions.rootDir) : fallbackSourceRoot;

  const entries = new Set<string>();
  for (const candidate of candidates) {
    for (const sourcePath of sourceCandidates(path.resolve(packageDir, candidate), outDir, sourceRoot)) {
      if (known.has(sourcePath)) entries.add(sourcePath);
    }
  }
  return [...entries];
}

/** Strings in main ("dist/index.js"), bin ({name: path}), and exports (nested conditions). */
function collectStrings(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    if (!value.includes('*')) out.add(value);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) collectStrings(nested, out);
  }
}

/** The source files a published path can correspond to, including the path itself. */
function sourceCandidates(filePath: string, outDir: string | undefined, sourceRoot: string): string[] {
  const bases = new Set<string>([filePath]);
  if (outDir && (filePath === outDir || filePath.startsWith(`${outDir}${path.sep}`))) {
    bases.add(path.join(sourceRoot, path.relative(outDir, filePath)));
  }
  const candidates = new Set<string>(bases);
  for (const base of bases) {
    if (!OUTPUT_EXTENSION.test(base)) continue;
    const stem = base.replace(OUTPUT_EXTENSION, '');
    for (const extension of SOURCE_EXTENSIONS) candidates.add(stem + extension);
  }
  return [...candidates];
}
