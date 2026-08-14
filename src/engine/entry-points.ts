import path from 'node:path';
import type { ts } from 'ts-morph';
import type { ReadOnlyFileSystem } from './file-system';
import { commandTokens, scriptsOf } from './scripts';

/** An entry point and the thing that named it, so a run can be audited. */
export interface EntryPoint {
  filePath: string;
  /** Where it came from: `package.json scripts.dev`, `vite.config.ts`, … */
  source: string;
}

/** Directories no tool reads its inputs from. Walking them is wasted work. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  '.output',
]);

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
const OUTPUT_EXTENSION = /\.(?:d\.ts|d\.mts|d\.cts|js|jsx|mjs|cjs)$/;
const CONFIG_NAME = /\.config\.[cm]?[jt]sx?$/;
const SCRIPT_SRC = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
const QUOTED = /(['"`])((?:\\.|(?!\1)[^\\\r\n])*)\1/g;

/**
 * The entry points a package declares outside its own import graph.
 *
 * A build tool is told where to start, and it is told in a file that norefs can
 * read: `package.json` names `main`, `bin`, `exports`, and scripts that run
 * source files by path; `index.html` points a bundler at its module; a
 * `*.config.ts` names inputs, setup files and roots as plain strings. Reading
 * those beats asking a user to keep the same list a second time by hand — the
 * hand-kept copy is the one that goes stale when the build changes.
 *
 * Nothing here evaluates a config. A path string in a tool's config that lands
 * on a file this project holds is taken at face value. That is the whole rule,
 * and it covers the tools without knowing one from another.
 */
export function packageEntryPoints(
  packageDir: string,
  fallbackSourceRoot: string,
  compilerOptions: ts.CompilerOptions,
  known: Set<string>,
  fileSystem: ReadOnlyFileSystem
): EntryPoint[] {
  const outDir = compilerOptions.outDir ? path.resolve(packageDir, compilerOptions.outDir) : undefined;
  const sourceRoot = compilerOptions.rootDir ? path.resolve(packageDir, compilerOptions.rootDir) : fallbackSourceRoot;

  const found = new Map<string, string>();
  const add = (candidate: string, fromDir: string, source: string): void => {
    const resolved = resolveToKnown(candidate, fromDir, packageDir, outDir, sourceRoot, known);
    if (resolved && !found.has(resolved)) found.set(resolved, source);
  };

  collectManifest(packageDir, fileSystem, add);
  for (const filePath of toolFiles(packageDir, fileSystem)) {
    const text = fileSystem.readFile(filePath);
    if (text === undefined) continue;
    const dir = path.dirname(filePath);
    const label = path.relative(packageDir, filePath) || path.basename(filePath);
    if (filePath.endsWith('.html')) {
      for (const [, src] of text.matchAll(SCRIPT_SRC)) add(src, dir, `<script src> in ${label}`);
    } else {
      for (const [, , quoted] of text.matchAll(QUOTED)) add(quoted, dir, `a path named in ${label}`);
    }
  }
  return [...found].map(([filePath, source]) => ({ filePath, source }));
}

/** `main`, `bin`, `exports`, and any script that runs a source file by path. */
function collectManifest(
  packageDir: string,
  fileSystem: ReadOnlyFileSystem,
  add: (candidate: string, fromDir: string, source: string) => void
): void {
  const text = fileSystem.readFile(path.join(packageDir, 'package.json'));
  if (text === undefined) return;
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return;
  }
  if (typeof manifest !== 'object' || manifest === null) return;
  const data = manifest as Record<string, unknown>;

  for (const field of ['main', 'bin', 'exports']) {
    const paths = new Set<string>();
    collectStrings(data[field], paths);
    for (const candidate of paths) add(candidate, packageDir, `package.json ${field}`);
  }

  for (const { name, command } of scriptsOf(data)) {
    for (const token of commandTokens(command)) add(token, packageDir, `package.json scripts.${name}`);
  }
}

/** Every `*.config.*` and `*.html` under the package, build output skipped. */
function toolFiles(packageDir: string, fileSystem: ReadOnlyFileSystem): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const child of fileSystem.readDir(dir)) {
      const name = path.basename(child.path);
      if (child.isDirectory) {
        if (!SKIP_DIRS.has(name) && !name.startsWith('.')) walk(child.path);
        continue;
      }
      if (name.endsWith('.html') || CONFIG_NAME.test(name)) found.push(child.path);
    }
  };
  walk(packageDir);
  return found.sort((a, b) => a.localeCompare(b));
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

/**
 * The project file a written path names, or nothing. A leading `/` is the
 * bundler's "from the package root", not the disk's. A path into the compiled
 * output maps back to source through outDir and rootDir, so `main: dist/app.js`
 * finds `src/app.ts`.
 */
function resolveToKnown(
  candidate: string,
  fromDir: string,
  packageDir: string,
  outDir: string | undefined,
  sourceRoot: string,
  known: Set<string>
): string | undefined {
  if (candidate.length === 0 || candidate.includes('*') || /^[a-z][a-z0-9+.-]*:/i.test(candidate)) return undefined;

  const bases = candidate.startsWith('/')
    ? [path.join(packageDir, candidate), candidate]
    : [path.resolve(fromDir, candidate), path.resolve(packageDir, candidate)];

  for (const base of bases) {
    for (const sourcePath of sourceCandidates(base, outDir, sourceRoot)) {
      if (known.has(sourcePath)) return sourcePath;
    }
  }
  return undefined;
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
