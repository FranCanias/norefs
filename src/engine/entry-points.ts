import path from 'node:path';
import type { ts } from 'ts-morph';
import { isHarnessFile } from './reachability';
import { commandTokens, scriptsOf } from './scripts';
import { escapeRegExp } from './text';
import type { ConfigReader } from './tool-configs';

/** An entry point and the thing that named it, so a run can be audited. */
export interface EntryPoint {
  filePath: string;
  /** Where it came from: `package.json scripts.dev`, `vite.config.ts`, … */
  source: string;
  /**
   * A tool's config named it, rather than the manifest.
   *
   * Nothing here evaluates a config, so a path in one is read at face value —
   * and vitest's `coverage.exclude` lists paths that are the opposite of an
   * entry point. That is strong enough to keep a file alive, which costs a
   * finding when it is wrong, and too weak to say the file is what the
   * package ships, which costs a claim about somebody's install.
   */
  harness: boolean;
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
const OUTPUT_EXTENSION = /\.(?:d\.ts|d\.mts|d\.cts|js|jsx|mjs|cjs)$/;

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
  reader: ConfigReader,
  rootDirs: string[] = [fallbackSourceRoot]
): EntryPoint[] {
  const outDir = compilerOptions.outDir ? path.resolve(packageDir, compilerOptions.outDir) : undefined;
  const sourceRoot = compilerOptions.rootDir ? path.resolve(packageDir, compilerOptions.rootDir) : fallbackSourceRoot;

  const found = new Map<string, { source: string; harness: boolean }>();
  const add = (candidate: string, fromDir: string, source: string, directoryIndex = false, harness = false): void => {
    const resolved = resolveToKnown(candidate, fromDir, packageDir, outDir, sourceRoot, known, directoryIndex);
    if (resolved && !found.has(resolved)) found.set(resolved, { source, harness });
  };
  const addPattern = (candidate: string, source: string): void => {
    for (const filePath of expandPattern(candidate, packageDir, outDir, sourceRoot, known, rootDirs)) {
      if (!found.has(filePath)) found.set(filePath, { source, harness: false });
    }
  };

  collectManifest(packageDir, reader, add, addPattern);
  for (const config of reader.configs(packageDir)) {
    const source = config.html ? `<script src> in ${config.label}` : `a path named in ${config.label}`;
    // What the config imports is already an edge in the graph, and the config is
    // already a root of it — but only when the program holds the config itself.
    // A `.js` config, or one the tsconfig never includes, is no root of
    // anything, so the file it imports has no importer at all.
    const isRoot = known.has(config.filePath);
    for (const written of config.strings) {
      if (isRoot && config.imported.has(written)) continue;
      // A config writes a module path the way an import writes it, so the
      // directory whose `index` is the module counts here.
      add(written, config.dir, source, true, true);
    }
  }
  return [...found].map(([filePath, { source, harness }]) => ({ filePath, source, harness }));
}

/** `main`, `bin`, `exports`, and any script that runs a source file by path. */
function collectManifest(
  packageDir: string,
  reader: ConfigReader,
  add: (candidate: string, fromDir: string, source: string, directoryIndex?: boolean) => void,
  addPattern: (candidate: string, source: string) => void
): void {
  const text = reader.readFile(path.join(packageDir, 'package.json'));
  if (text === undefined) return;
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return;
  }
  if (typeof manifest !== 'object' || manifest === null) return;
  const data = manifest as Record<string, unknown>;

  for (const field of ['main', 'types', 'bin', 'exports']) {
    const paths = new Set<string>();
    collectStrings(data[field], paths);
    for (const candidate of paths) {
      if (candidate.includes('*')) addPattern(candidate, `package.json ${field}`);
      else add(candidate, packageDir, `package.json ${field}`);
    }
  }

  for (const { name, command } of scriptsOf(data)) {
    for (const token of commandTokens(command)) add(token, packageDir, `package.json scripts.${name}`);
  }
}

/** Strings in main ("dist/index.js"), bin ({name: path}), and exports (nested conditions). */
function collectStrings(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    out.add(value);
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
  known: Set<string>,
  directoryIndex: boolean
): string | undefined {
  if (candidate.length === 0 || candidate.includes('*') || /^[a-z][a-z0-9+.-]*:/i.test(candidate)) return undefined;

  const bases = candidate.startsWith('/')
    ? [path.join(packageDir, candidate), candidate]
    : [path.resolve(fromDir, candidate), path.resolve(packageDir, candidate)];

  // A config writes a target the way an import writes it, extension and all —
  // or without one. Guessing the rest only makes sense for a string shaped like
  // a path: a bare word is a word, and `environment: 'jsdom'` must not find a
  // jsdom.ts next door.
  const shapedLikeAPath = /[\\/]/.test(candidate);
  for (const base of bases) {
    for (const sourcePath of sourceCandidates(base, outDir, sourceRoot, shapedLikeAPath, directoryIndex)) {
      if (known.has(sourcePath)) return sourcePath;
    }
  }
  return undefined;
}

/**
 * The files a subpath pattern publishes.
 *
 * `"./*": "./*.js"` says every module in the package is reachable from
 * outside it, and names none of them. There is no list to read, so the
 * pattern is matched against the files the run holds — through the same
 * outDir and rootDir mapping a written path goes through, because a pattern
 * points at built output for the same reason a path does.
 *
 * A harness file is never published, whatever the pattern's shape. A `*`
 * matches across directories, the way the resolver reads one, so `./*.js`
 * left to itself would take the test tree with it.
 */
function expandPattern(
  candidate: string,
  packageDir: string,
  outDir: string | undefined,
  sourceRoot: string,
  known: Set<string>,
  rootDirs: string[]
): string[] {
  if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) return [];
  const base = candidate.startsWith('/') ? path.join(packageDir, candidate) : path.resolve(packageDir, candidate);

  const found: string[] = [];
  for (const pattern of sourceCandidates(base, outDir, sourceRoot, true, false)) {
    if (!pattern.includes('*')) continue;
    const matcher = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
    for (const filePath of known) {
      if (matcher.test(filePath) && !isHarnessFile(filePath, rootDirs)) found.push(filePath);
    }
  }
  return found;
}

/** The source files a written path can correspond to, including the path itself. */
function sourceCandidates(
  filePath: string,
  outDir: string | undefined,
  sourceRoot: string,
  shapedLikeAPath: boolean,
  directoryIndex: boolean
): string[] {
  const bases = new Set<string>([filePath]);
  if (outDir && (filePath === outDir || filePath.startsWith(`${outDir}${path.sep}`))) {
    bases.add(path.join(sourceRoot, path.relative(outDir, filePath)));
  }
  const candidates = new Set<string>(bases);
  for (const base of bases) {
    if (OUTPUT_EXTENSION.test(base)) {
      const stem = base.replace(OUTPUT_EXTENSION, '');
      for (const extension of SOURCE_EXTENSIONS) candidates.add(stem + extension);
      continue;
    }
    if (!shapedLikeAPath) continue;
    for (const extension of SOURCE_EXTENSIONS) {
      candidates.add(base + extension);
      // A directory is a module only where a module is what gets written. In a
      // script it is a place to look: `eslint src` scans a tree, and reading it
      // as `src/index.ts` would publish that file's exports as API.
      if (directoryIndex) candidates.add(path.join(base, `index${extension}`));
    }
  }
  return [...candidates];
}
