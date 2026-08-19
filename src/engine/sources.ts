import path from 'node:path';
import { ts } from 'ts-morph';
import type { PackageConfig } from './project';
import { optionsForDir } from './project';
import type { FileScan, Specifier } from './scan';
import { scanFiles } from './scan';
import { stripQuerySuffix } from './text';

/** An import as written, and where it resolves to. */
interface Import {
  specifier: Specifier;
  /** The project file it names, when it names one the project holds. */
  target?: string | undefined;
  /**
   * True when the compiler found a file for it. A resolved specifier that is
   * not a project file still names project code — a declaration file beside
   * the sources, say — and is no package.
   */
  resolved: boolean;
  /** True when it resolves into node_modules: a package, not project code. */
  external: boolean;
}

/**
 * The project as text: which files it holds, what each one imports, and where
 * its suppression comments sit.
 *
 * Unused files, unused dependencies, and unlisted imports are all answers the
 * syntax alone gives. Building a TypeScript program to reach them costs
 * seconds and gigabytes for information the text already carries, so this view
 * skips the program: a single-pass scanner reads every file, and the compiler
 * is asked only to resolve the specifiers it finds.
 */
export class SourceIndex {
  readonly filePaths: string[];
  private readonly scans = new Map<string, FileScan>();
  private readonly imports = new Map<string, Import[]>();

  constructor(filePaths: string[], packages: PackageConfig[], fallbackOptions: ts.CompilerOptions) {
    this.filePaths = filePaths;
    const scans = scanFiles(filePaths);
    // scanFiles returns one scan per path.
    for (const [i, filePath] of filePaths.entries()) this.scans.set(filePath, scans[i]!);

    const known = new Set(filePaths);
    const caches = new Map<ts.CompilerOptions, ts.ModuleResolutionCache>();
    for (const filePath of filePaths) {
      const dir = path.dirname(filePath);
      const options = optionsForDir(packages, dir) ?? fallbackOptions;
      let cache = caches.get(options);
      if (!cache) {
        cache = ts.createModuleResolutionCache(process.cwd(), fileName => fileName, options);
        caches.set(options, cache);
      }
      this.imports.set(filePath, this.resolveAll(filePath, options, cache, known));
    }
  }

  importsOf(filePath: string): Import[] {
    return this.imports.get(filePath) ?? [];
  }

  isFileSuppressed(filePath: string): boolean {
    return this.scans.get(filePath)?.fileSuppressed ?? false;
  }

  /**
   * True when a `norefs-ignore` comment sits on this offset's line or the line
   * above it. The line above only counts when it is a standalone comment; a
   * trailing comment there suppresses that line, not this one.
   */
  isSuppressedAt(filePath: string, offset: number): boolean {
    const scan = this.scans.get(filePath);
    if (!scan) return false;
    const { line } = this.positionAt(filePath, offset);
    if (includes(scan.suppressedLines, line)) return true;
    return includes(scan.suppressedLines, line - 1) && includes(scan.commentLines, line - 1);
  }

  /** The 1-based line and column of an offset, from the scanner's line table. */
  positionAt(filePath: string, offset: number): { line: number; column: number } {
    const starts = this.scans.get(filePath)?.lineStarts;
    if (!starts || starts.length === 0) return { line: 1, column: offset + 1 };

    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      // The search keeps 0 <= low <= middle <= high < starts.length.
      if (starts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return { line: low + 1, column: offset - starts[low]! + 1 };
  }

  private resolveAll(
    filePath: string,
    options: ts.CompilerOptions,
    cache: ts.ModuleResolutionCache,
    known: Set<string>
  ): Import[] {
    const scan = this.scans.get(filePath);
    if (!scan) return [];
    return scan.specifiers.map(specifier => {
      const text = stripQuerySuffix(specifier.text);
      const resolved = ts.resolveModuleName(text, filePath, options, ts.sys, cache).resolvedModule;
      if (!resolved) return { specifier, resolved: false, external: false };
      const target = resolved.resolvedFileName;
      return {
        specifier,
        target: known.has(target) ? target : undefined,
        resolved: true,
        external: resolved.isExternalLibraryImport === true || target.includes('/node_modules/'),
      };
    });
  }
}

function includes(values: number[], value: number): boolean {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    // The search keeps 0 <= low <= middle <= high < values.length.
    const candidate = values[middle]!;
    if (candidate === value) return true;
    if (candidate < value) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

/** The source files of these tsconfigs, declaration files left out. */
export function projectFilePaths(tsConfigFilePaths: string[]): string[] {
  const filePaths = new Set<string>();
  for (const tsConfigFilePath of tsConfigFilePaths) {
    const { config, error } = ts.readConfigFile(tsConfigFilePath, ts.sys.readFile);
    if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
    const dir = path.dirname(tsConfigFilePath);
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dir, undefined, tsConfigFilePath);
    for (const fileName of parsed.fileNames) {
      if (!fileName.endsWith('.d.ts')) filePaths.add(fileName);
    }
  }
  // Sorted, so an unlisted package is always reported at the same one of its
  // import sites however the tsconfigs happened to glob.
  return [...filePaths].sort((a, b) => a.localeCompare(b));
}
