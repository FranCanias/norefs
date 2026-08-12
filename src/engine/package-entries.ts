import path from 'node:path';
import type { Project, ts } from 'ts-morph';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
const OUTPUT_EXTENSION = /\.(?:d\.ts|d\.mts|d\.cts|js|jsx|mjs|cjs)$/;

/**
 * Entry files a package.json names: main, bin, and exports. A path that
 * points into the compiled output is mapped back to source through the
 * package's own tsconfig outDir and rootDir. Only paths that resolve to a
 * project source file count.
 */
export function packageEntries(
  project: Project,
  packageDir: string,
  fallbackSourceRoot: string,
  compilerOptions: ts.CompilerOptions
): string[] {
  const fileSystem = project.getFileSystem();
  const manifestPath = path.join(packageDir, 'package.json');
  if (!fileSystem.fileExistsSync(manifestPath)) return [];

  let manifest: unknown;
  try {
    manifest = JSON.parse(fileSystem.readFileSync(manifestPath));
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
    const resolved = path.resolve(packageDir, candidate);
    for (const sourcePath of sourceCandidates(resolved, outDir, sourceRoot)) {
      const sourceFile = project.getSourceFile(sourcePath);
      if (sourceFile) entries.add(sourceFile.getFilePath());
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
