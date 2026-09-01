import path from 'node:path';
import { minimatch } from 'minimatch';
import type { ReadOnlyFileSystem } from './file-system';
import { diskFileSystem } from './file-system';

/** The packages a workspace declares, and what declared them. */
interface Workspace {
  /** The tsconfig of each declared package that has one. These are the projects. */
  tsConfigPaths: string[];
  /** Every declared package's directory, whether or not it holds a tsconfig. */
  packageDirs: string[];
  /** What named the packages: `pnpm-workspace.yaml` or `package.json workspaces`. */
  source: string;
  /** Declared packages holding no tsconfig.json. Nothing analyzes them. */
  withoutTsConfig: string[];
}

/**
 * The workspace a directory declares, or nothing.
 *
 * A monorepo already says where its packages are, in the file its package
 * manager reads. Asking for the same list again as repeated `--project` flags
 * is asking you to keep a copy — and a copy of the build's own list is the copy
 * that goes stale when a package is added.
 *
 * Same rule as the entry points: nothing is executed, a declaration is read for
 * the globs it holds, and a glob that matches no package directory is dropped.
 * The failure mode stays one-directional. A missed package is a package nobody
 * analyzed, which reports nothing; there is no way to invent one, because every
 * project here is a tsconfig.json that exists on disk.
 */
export function findWorkspace(rootDir: string, fileSystem: ReadOnlyFileSystem = diskFileSystem): Workspace | undefined {
  const declaration = declaredPatterns(rootDir, fileSystem);
  if (!declaration) return undefined;

  const include = declaration.patterns.filter(pattern => !pattern.startsWith('!'));
  const exclude = declaration.patterns.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1));
  if (include.length === 0) return undefined;

  const tsConfigPaths: string[] = [];
  const withoutTsConfig: string[] = [];
  const packageDirs: string[] = [];
  for (const dir of packageDirectories(rootDir, fileSystem)) {
    const relative = path.relative(rootDir, dir).split(path.sep).join('/');
    if (!include.some(pattern => minimatch(relative, pattern))) continue;
    if (exclude.some(pattern => minimatch(relative, pattern))) continue;
    packageDirs.push(dir);
    const tsConfig = path.join(dir, 'tsconfig.json');
    if (fileSystem.readFile(tsConfig) === undefined) withoutTsConfig.push(relative);
    else tsConfigPaths.push(tsConfig);
  }
  if (tsConfigPaths.length === 0 && withoutTsConfig.length === 0) return undefined;
  return {
    tsConfigPaths: tsConfigPaths.sort(),
    packageDirs: packageDirs.sort(),
    source: declaration.source,
    withoutTsConfig: withoutTsConfig.sort(),
  };
}

/** The globs a workspace declaration holds. pnpm's file wins where both exist. */
function declaredPatterns(
  rootDir: string,
  fileSystem: ReadOnlyFileSystem
): { patterns: string[]; source: string } | undefined {
  for (const name of ['pnpm-workspace.yaml', 'pnpm-workspace.yml']) {
    const text = fileSystem.readFile(path.join(rootDir, name));
    if (text === undefined) continue;
    const patterns = yamlPackages(text);
    if (patterns.length > 0) return { patterns, source: name };
  }

  const manifest = fileSystem.readFile(path.join(rootDir, 'package.json'));
  if (manifest === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest);
  } catch {
    return undefined;
  }
  // npm and yarn take a list; yarn also takes `{ packages: [...] }`.
  const declared = (parsed as { workspaces?: unknown }).workspaces;
  const list = Array.isArray(declared) ? declared : (declared as { packages?: unknown } | undefined)?.packages;
  if (!Array.isArray(list)) return undefined;
  const patterns = list.filter((item): item is string => typeof item === 'string');
  return patterns.length > 0 ? { patterns, source: 'package.json workspaces' } : undefined;
}

/**
 * The other packages of the workspace a run was pointed inside.
 *
 * A tsconfig names one package; the repository is the project. A sibling
 * package importing this one is code beside the program in exactly the sense
 * the outside scan means — the only reason it went unread is that the walk
 * started where the tsconfig sits, and where a tsconfig sits is a layout
 * decision rather than a boundary of the code.
 *
 * Nothing comes back when no ancestor declares a workspace, or when the run
 * already holds every package it declares. The climb stops at the first
 * declaration it meets, because a workspace inside a workspace is the inner
 * one's business.
 */
export function workspaceSiblings(rootDirs: string[], fileSystem: ReadOnlyFileSystem = diskFileSystem): string[] {
  const found = new Set<string>();
  const climbed = new Set<string>();
  for (const rootDir of rootDirs) {
    for (let dir = path.dirname(rootDir); dir !== path.dirname(dir); dir = path.dirname(dir)) {
      if (climbed.has(dir)) break;
      climbed.add(dir);
      const workspace = findWorkspace(dir, fileSystem);
      if (!workspace) continue;
      for (const packageDir of workspace.packageDirs) found.add(packageDir);
      break;
    }
  }
  return [...found]
    .filter(dir => !rootDirs.some(root => dir === root || dir.startsWith(`${root}/`) || root.startsWith(`${dir}/`)))
    .sort((a, b) => a.localeCompare(b));
}

const MAX_PACKAGE_DEPTH = 5;

/**
 * Every directory under the root that holds a package.json.
 *
 * The walk stops at each one it finds: a workspace package does not live inside
 * another workspace package, so descending further only costs time. That is
 * what keeps this cheap on a large repository — the walk only ever covers the
 * directories *above* the packages.
 *
 * Only `node_modules` and dot-directories are refused, and they are refused
 * because neither can hold a workspace member: one holds dependencies, the
 * other holds tooling state. Nothing else is judged by its name. A package
 * called `build` or `dist` is still a package, and the declaration is what says
 * which directories count — guessing from names here would drop a real one.
 */
function packageDirectories(rootDir: string, fileSystem: ReadOnlyFileSystem): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    // No real layout buries a package this deep, and a cap means a surprising
    // tree costs a bounded walk rather than an unbounded one.
    if (depth > MAX_PACKAGE_DEPTH) return;
    for (const entry of fileSystem.readDir(dir)) {
      if (!entry.isDirectory) continue;
      const name = path.basename(entry.path);
      if (name === 'node_modules' || name.startsWith('.')) continue;
      if (fileSystem.readFile(path.join(entry.path, 'package.json')) !== undefined) found.push(entry.path);
      else walk(entry.path, depth + 1);
    }
  };
  walk(rootDir, 0);
  return found;
}

/**
 * The `packages:` list of a pnpm-workspace.yaml.
 *
 * This reads one key; it is not a YAML parser, and norefs takes no YAML
 * dependency for it. That key's whole job is to hold a list of directory globs,
 * in one of the two forms pnpm documents — a block sequence under the key, or a
 * flow sequence on it — and a reader that stops at the next key gets both
 * right. What it cannot read it drops, and a dropped glob leaves a package
 * unanalyzed rather than inventing one.
 */
function yamlPackages(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex(line => /^packages\s*:/.test(line));
  const header = lines[start];
  if (header === undefined) return [];

  const inline = header.slice(header.indexOf(':') + 1).trim();
  if (inline.startsWith('[')) {
    const close = inline.lastIndexOf(']');
    return (close === -1 ? inline.slice(1) : inline.slice(1, close))
      .split(',')
      .map(scalar)
      .filter(item => item.length > 0);
  }

  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    // Anything that is not another sequence item is the next key: the list ends.
    if (!trimmed.startsWith('-')) break;
    const value = scalar(trimmed.slice(1));
    if (value.length > 0) items.push(value);
  }
  return items;
}

/** One YAML scalar: quoted or bare, with any trailing comment dropped. */
function scalar(text: string): string {
  const trimmed = text.trim();
  const quote = trimmed[0];
  if (quote === "'" || quote === '"') {
    const end = trimmed.indexOf(quote, 1);
    return end === -1 ? '' : trimmed.slice(1, end);
  }
  const comment = trimmed.indexOf(' #');
  return (comment === -1 ? trimmed : trimmed.slice(0, comment)).trim();
}
