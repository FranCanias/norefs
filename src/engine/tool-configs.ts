import path from 'node:path';
import type { ReadOnlyFileSystem } from './file-system';
import { configLiterals } from './scan';

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
 * Loosely is not carelessly: the strings come off the same token stream the
 * scanner reads source with, so a commented-out line is not a string. That
 * distinction is the whole difference between a config that says something and
 * one where somebody wrote a line down and turned it off.
 *
 * One walk answers both, so the walk lives here — and each package is walked
 * once, because both readers ask for the same package in the same run.
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
 * One run's view of the build files, holding what it has already walked.
 *
 * Both readers ask about the same packages in the same run, and a walk that
 * reads and tokenizes every config in a monorepo is not worth doing twice. The
 * memory lives on the reader rather than in this module, so it lasts exactly as
 * long as the run that made it — a watch rebuild gets a new one and sees the
 * files as they now are.
 */
export interface ConfigReader {
  /** The manifest and the like, for a caller that reads more than configs. */
  readFile(filePath: string): string | undefined;
  /** Every `*.config.*` and `*.html` under a package, build output skipped. */
  configs(packageDir: string): ToolConfig[];
  /**
   * Every string those configs write, imports included: what the dependency
   * check matches against the names in package.json.
   */
  strings(packageDir: string): string[];
}

export function configReader(fileSystem: ReadOnlyFileSystem): ConfigReader {
  const walked = new Map<string, ToolConfig[]>();
  const configs = (packageDir: string): ToolConfig[] => {
    let found = walked.get(packageDir);
    if (!found) {
      found = toolConfigs(packageDir, fileSystem);
      walked.set(packageDir, found);
    }
    return found;
  };
  return {
    readFile: filePath => fileSystem.readFile(filePath),
    configs,
    strings: packageDir => configs(packageDir).flatMap(config => config.strings),
  };
}

function toolConfigs(packageDir: string, fileSystem: ReadOnlyFileSystem): ToolConfig[] {
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
    // HTML has no token stream to read; its strings are the `<script src>`
    // values and nothing else, and it imports nothing of its own.
    const { strings, specifiers } = html
      ? { strings: [...text.matchAll(SCRIPT_SRC)].map(match => match[1]), specifiers: [] as string[] }
      : configLiterals(text);
    configs.push({
      filePath,
      dir: path.dirname(filePath),
      label: path.relative(packageDir, filePath) || path.basename(filePath),
      html,
      strings,
      imported: new Set(specifiers),
    });
  }
  return configs;
}
