import path from 'node:path';
import type { ReadOnlyFileSystem } from './file-system';

/**
 * The files that configure a build, and the strings written in them.
 *
 * A build tool is told what to do in a file norefs can read, and two readers
 * want what those files say. The entry-point reader looks for paths: a bundler
 * input, an alias target, a setup file. The dependency reader looks for package
 * names: `environment: 'jsdom'` is jsdom being loaded, and an ESLint config
 * naming a plugin is that plugin being used. Neither evaluates a config, and
 * both drop every string they cannot place — which is what makes reading them
 * this loosely safe.
 *
 * One walk answers both, so the walk lives here.
 */

/** A config file's name: something, then `.config`, then an extension. */
const CONFIG_NAME = /\.config\.[cm]?[jt]sx?$/;

/**
 * The same, with the segments a build adds for a second target:
 * `vite.config.server.ts` beside `vite.config.ts`.
 *
 * Product code writes that shape too — `form.config.schema.ts` is a schema, and
 * reading it as a build file loses every finding in what it imports. Nothing in
 * the name tells the two apart, so where the file sits does: a build keeps its
 * own configs at the package root, beside the manifest they belong to.
 */
const SECOND_TARGET_NAME = /\.config\.(?:[\w-]+\.)+[cm]?[jt]sx?$/;

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

const SCRIPT_SRC = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
const QUOTED = /(['"`])((?:\\.|(?!\1)[^\\\r\n])*)\1/g;

/** The three ways a config names a module it loads itself. */
const SPECIFIERS = [
  /\b(?:import|export)\b[^'"`;]*?\bfrom\s*(['"`])([^'"`]*)\1/g,
  /\bimport\s*(['"`])([^'"`]*)\1/g,
  /\b(?:require|import)\s*\(\s*(['"`])([^'"`]*)\1/g,
];

/** True when this file is a tool's configuration rather than product code. */
export function isToolConfig(filePath: string, packageDirs: readonly string[]): boolean {
  const name = path.basename(filePath);
  if (CONFIG_NAME.test(name)) return true;
  if (!SECOND_TARGET_NAME.test(name)) return false;
  const dir = path.dirname(filePath);
  return packageDirs.some(packageDir => dir === packageDir);
}

/** A config file, and everything written inside it as a string. */
interface ToolConfig {
  filePath: string;
  /** The directory it sits in: a path it names is relative to this one. */
  dir: string;
  /** Its name relative to the package, for a report that has to say where. */
  label: string;
  /** True for HTML, where the strings are `<script src>` values and nothing else. */
  html: boolean;
  /** Every string the file writes, in the order it writes them. */
  strings: string[];
  /**
   * The subset of them the config imports itself.
   *
   * A plugin a config imports is that package being used, so the dependency
   * reader wants these. The entry-point reader wants the rest: an import is
   * already an edge in the graph, and promoting its target to an entry point
   * would make that file's exports public API on the strength of one config
   * line.
   */
  imported: Set<string>;
}

/**
 * Every string a package's tool configs write, imports included: what the
 * dependency check matches against the names in package.json.
 */
export function configStrings(packageDir: string, fileSystem: ReadOnlyFileSystem): string[] {
  return toolConfigs(packageDir, fileSystem).flatMap(config => config.strings);
}

/** Every `*.config.*` and `*.html` under a package, build output skipped. */
export function toolConfigs(packageDir: string, fileSystem: ReadOnlyFileSystem): ToolConfig[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const child of fileSystem.readDir(dir)) {
      const name = path.basename(child.path);
      if (child.isDirectory) {
        if (!SKIP_DIRS.has(name) && !name.startsWith('.')) walk(child.path);
        continue;
      }
      if (name.endsWith('.html') || isToolConfig(child.path, [packageDir])) found.push(child.path);
    }
  };
  walk(packageDir);

  const configs: ToolConfig[] = [];
  for (const filePath of found.sort((a, b) => a.localeCompare(b))) {
    const text = fileSystem.readFile(filePath);
    if (text === undefined) continue;
    const html = filePath.endsWith('.html');
    const matches = text.matchAll(html ? SCRIPT_SRC : QUOTED);
    const imported = new Set<string>();
    if (!html) {
      for (const pattern of SPECIFIERS) {
        for (const [, , specifier] of text.matchAll(pattern)) imported.add(specifier);
      }
    }
    configs.push({
      filePath,
      dir: path.dirname(filePath),
      label: path.relative(packageDir, filePath) || path.basename(filePath),
      html,
      strings: [...matches].map(match => (html ? match[1] : match[2])),
      imported,
    });
  }
  return configs;
}
