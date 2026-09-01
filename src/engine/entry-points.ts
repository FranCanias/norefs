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
   * The manifest named this file, so the package ships it.
   *
   * Two kinds of entry point keep a file alive without saying that much. A
   * tool's config names paths that nothing here evaluates, and vitest's
   * `coverage.exclude` lists the opposite of an entry point. A `"./*"` subpath
   * pattern names no file at all — it says every module is reachable, and a
   * `gulpfile.ts` beside the sources answers to it as readily as the sources
   * do. Either one is strong enough to keep a file from being called dead,
   * which costs a finding when it is wrong, and too weak to put the file on
   * the shipping path, which costs a claim about somebody's install.
   */
  shipping: boolean;
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

  // Only a mapping that finds nothing pays for this, so it is read once and
  // only when it is asked for.
  let rebuiltRoots: string[] | undefined;
  const roots = (): string[] => (rebuiltRoots ??= sourceRootsOf(packageDir, known));

  const found = new Map<string, { source: string; shipping: boolean }>();
  const add = (candidate: string, fromDir: string, source: string, directoryIndex = false, shipping = true): void => {
    const resolved = resolveToKnown(candidate, fromDir, packageDir, outDir, sourceRoot, known, directoryIndex, roots);
    if (resolved && !found.has(resolved)) found.set(resolved, { source, shipping });
  };
  const addPattern = (candidate: string, source: string): void => {
    for (const filePath of expandPattern(candidate, packageDir, outDir, sourceRoot, known, rootDirs, roots)) {
      if (!found.has(filePath)) found.set(filePath, { source, shipping: false });
    }
  };

  collectManifest(packageDir, reader, add, addPattern);
  for (const config of reader.configs(packageDir)) {
    // A settings file is read for the packages it names, and a path in it is
    // as often something to leave out as something to start from.
    if (config.namesOnly) continue;
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
      add(written, config.dir, source, true, false);
    }
  }
  return [...found].map(([filePath, { source, shipping }]) => ({ filePath, source, shipping }));
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
  directoryIndex: boolean,
  roots: () => string[]
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
  for (const base of bases) {
    // A tsconfig's `outDir` describes this path only when the path is under
    // it. A workspace package under a root tsconfig builds into its own
    // `dist/`, and the root's `outDir` says nothing about that one.
    const under = outDir !== undefined && (base === outDir || base.startsWith(`${outDir}${path.sep}`));
    const builtIn = under ? outDir : builtDirOf(base, packageDir, roots());
    if (builtIn === undefined) continue;
    const rebuilt = rebuiltFrom(base, builtIn, roots(), known, shapedLikeAPath, directoryIndex);
    if (rebuilt) return rebuilt;
  }
  return undefined;
}

/**
 * The directory a written path says the build lands in, when no tsconfig says.
 *
 * `noEmit: true` and no `outDir` is what a bundler-built package writes, and
 * its manifest still names `./dist/index.mjs`. The manifest wrote `dist/` down
 * either way, so the first directory of the path is the build's — provided the
 * run holds nothing in it. A directory holding a file the program holds is
 * source by demonstration, and a path into it that resolved to nothing is a
 * missing file rather than a built one.
 */
function builtDirOf(base: string, packageDir: string, roots: string[]): string | undefined {
  const relative = path.relative(packageDir, base);
  const [first, second] = relative.split(path.sep);
  if (!first || first === '..' || second === undefined) return undefined;
  const dir = path.join(packageDir, first);
  return roots.includes(dir) ? undefined : dir;
}

/**
 * The source of a built file, when the tsconfig's own mapping finds nothing —
 * or when there is no mapping to try.
 *
 * `outDir` and `rootDir` describe the build only where `tsc` is the build. A
 * package built by a bundler keeps a tsconfig for the type check alone, and it
 * is free to say anything: swr writes `outDir: "./dist"` with `rootDir: "./"`
 * and builds `src/index/index.ts` into `dist/index/index.js`, so the mapping
 * lands on a path no file has. h3 writes no `outDir` at all, and its manifest
 * names `./dist/_entries/node.mjs` all the same. Either way nothing resolves,
 * and a whole source tree is called dead.
 *
 * So the second guess drops `rootDir` and tries the package's source roots
 * instead. Two roots answering at once is no answer — the file that ships
 * would be a coin toss — so that case is left alone, and the warning about a
 * run with no entry point stands.
 */
function rebuiltFrom(
  base: string,
  outDir: string,
  roots: string[],
  known: Set<string>,
  shapedLikeAPath: boolean,
  directoryIndex: boolean
): string | undefined {
  if (base !== outDir && !base.startsWith(`${outDir}${path.sep}`)) return undefined;
  const built = path.relative(outDir, base);
  const hits = new Set<string>();
  for (const root of roots) {
    for (const sourcePath of sourceCandidates(
      path.join(root, built),
      undefined,
      root,
      shapedLikeAPath,
      directoryIndex
    )) {
      if (known.has(sourcePath)) hits.add(sourcePath);
    }
  }
  const [only] = hits;
  return hits.size === 1 ? only : undefined;
}

/**
 * Where a package could be keeping its source: each directory directly under
 * it that holds a file this run reads. The package root itself is left out,
 * because every built path under it is the built path itself. The configured
 * `rootDir` stays in — it is the guess that already failed, so it can answer
 * nothing new, and leaving it in costs one lookup that misses.
 */
function sourceRootsOf(packageDir: string, known: Set<string>): string[] {
  const roots = new Set<string>();
  const prefix = packageDir.endsWith(path.sep) ? packageDir : `${packageDir}${path.sep}`;
  for (const filePath of known) {
    if (!filePath.startsWith(prefix)) continue;
    const [first, second] = filePath.slice(prefix.length).split(path.sep);
    if (first === undefined || second === undefined) continue;
    roots.add(path.join(packageDir, first));
  }
  return [...roots].sort();
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
  rootDirs: string[],
  roots: () => string[]
): string[] {
  if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) return [];
  const base = candidate.startsWith('/') ? path.join(packageDir, candidate) : path.resolve(packageDir, candidate);

  // A pattern into a build directory no tsconfig names takes the same guess a
  // path does, and every source root is a place the guess can land.
  const mappings: Array<[string | undefined, string]> = [[outDir, sourceRoot]];
  if (outDir === undefined) {
    const builtIn = builtDirOf(base, packageDir, roots());
    if (builtIn !== undefined) for (const root of roots()) mappings.push([builtIn, root]);
  }

  const found: string[] = [];
  for (const [from, to] of mappings) {
    for (const pattern of sourceCandidates(base, from, to, true, false)) {
      if (!pattern.includes('*')) continue;
      const matcher = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
      for (const filePath of known) {
        if (matcher.test(filePath) && !isHarnessFile(filePath, rootDirs) && !found.includes(filePath)) {
          found.push(filePath);
        }
      }
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
      // A build can drop the `index.` prefix on its way out: bunchee writes
      // `src/index/index.react-server.ts` to `dist/index/react-server.mjs`.
      const prefixed = path.join(path.dirname(stem), `index.${path.basename(stem)}`);
      for (const extension of SOURCE_EXTENSIONS) {
        candidates.add(stem + extension);
        candidates.add(prefixed + extension);
      }
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
