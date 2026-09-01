import path from 'node:path';
import type { ReadOnlyFileSystem } from './file-system';
import type { ConfigKey } from './scan';
import { bundlerExternals, configLiterals } from './scan';
import { commandTokens, scriptsOf } from './scripts';

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

/**
 * A config file's name: something, then `.config`, then an extension.
 *
 * The extension can be a data one. `stryker.config.json` configures Stryker
 * exactly as `vitest.config.ts` configures vitest, and the plugin it names is
 * a package the project uses. Only the reading changes: a data file has no
 * token stream, so its strings come off the lines.
 */
const CONFIG_NAME = /\.config\.(?:[cm]?[jt]sx?|json|jsonc|json5|ya?ml|toml)$/;

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

/**
 * Directories a tool owns outright, where every file is that tool's input.
 *
 * A config is usually a file with the tool's name on it. These are the other
 * shape: the tool takes a directory, and what is written inside says what the
 * project runs. `.husky/pre-commit` runs `lint-staged`,
 * `.github/workflows/*.yml` runs `pkg-pr-new`, `.changeset/config.json` names
 * its changelog generator, `.vitepress/config.ts` imports the site's markdown
 * plugins and `.storybook/main.ts` lists its addons — and each of those
 * packages had nothing else in the repository to show for it. The compiler
 * holds a dot-directory only when `include` spells it out, and most never do.
 *
 * Named rather than shaped, twice over. A leading dot marks two different
 * things, and `.turbo` and `.next` are state a build wrote — reading those is
 * reading the past. And `.github` is not one tool's directory but GitHub's:
 * `workflows` and `actions` say what runs, while an issue template, a funding
 * file and dependabot's own ignore list are repository paperwork. Dependabot
 * names a package to say *not* to touch it, which is the opposite of using it.
 *
 * The first four sit at the package root, because that is where their tools
 * look. A site's directory sits wherever the site does: vitepress's own
 * scaffolder writes `docs/.vitepress/` with no manifest beside it, and a
 * Storybook can live under `apps/` the same way — so those two are known by
 * their name at any depth.
 */
const ROOT_TOOL_DIRS = new Set(['.changeset', '.husky', '.github/workflows', '.github/actions']);
const TOOL_DIR_NAMES = new Set(['.storybook', '.vitepress']);

/**
 * The files a tool loads from its own directory by name, and never through an
 * import. vitepress reads `config.ts` and `theme/index.ts`; Storybook reads
 * `main.ts`, `preview.ts` and `manager.ts`. Where a tsconfig holds one of
 * these — `include: [".vitepress/**"]` is how vue-tsc is pointed at a site —
 * it is an entry point, or the run calls the two files every site has dead.
 */
const LOADED_BY_NAME: Record<string, RegExp> = {
  '.vitepress': /^(?:config|theme\/index)\.[cm]?[jt]s$/,
  '.storybook': /^(?:main|preview|manager)\.[cm]?[jt]sx?$/,
};

/** Storybook's own config, whose `stories` globs say which files are stories. */
const STORYBOOK_MAIN = /^main\.[cm]?[jt]sx?$/;

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
  'cache',
  '.output',
]);

/**
 * The other name a tool's configuration goes by: a leading dot, the tool, `rc`,
 * and an optional extension — `.eslintrc.yaml`, `.babelrc`, `.prettierrc.json`.
 * The plugins an ESLint config names are packages the project uses, and reading
 * only `*.config.*` missed every project that writes its config this way.
 */
const RC_NAME = /^\.[\w-]+rc(\.[\w]+)?$/;

/** ESLint's config file, in both the shape it had and the shape it has. */
const ESLINT_CONFIG_NAME = /^(\.eslintrc(\.\w+)?|eslint\.config\.[cm]?[jt]sx?)$/;

/**
 * The blocks of a legacy ESLint config whose keys are not plugin names. `env:
 * { node: true, jest: true }` names ESLint's built-in environments, `globals`
 * names variables, and `settings: { react: { version } }` is a plugin's
 * settings keyed by its short name — none of them loads a package, and every
 * legacy config has at least one.
 */
const ESLINT_PLAIN_BLOCKS = new Set(['env', 'globals', 'settings']);

/** PostCSS's config file, where `plugins: { tailwindcss: {} }` loads each key by name. */
const POSTCSS_CONFIG_NAME = /^(?:postcss\.config\.[cm]?[jt]s|\.postcssrc(?:\.[cm]?js)?)$/;

/**
 * The packages behind the tools whose config file is named after neither the
 * package nor a binary it declares. `tailwind.config.js` is read by
 * `tailwindcss`, and the file's name is the only place the project writes
 * the tool down. A name that is a binary — `rspack.config.js` for
 * `@rspack/cli`, `playwright.config.ts` for `@playwright/test` — needs no
 * entry here: the dependency check already resolves a command through the
 * binaries each installed package declares.
 */
const TOOL_PACKAGES: Record<string, string> = {
  babel: '@babel/core',
  swc: '@swc/core',
  tailwind: 'tailwindcss',
};

/** Jest's config file, and the one Vitest borrows the option name from. */
const JEST_CONFIG_NAME = /^jest\.config\.[cm]?[jt]sx?$/;

/**
 * A package's own build script: the build written as code rather than as
 * config. It is read for one thing only — what the bundler leaves external —
 * so it never joins the configs whose every string counts as a package in use.
 */
const BUILD_NAME = /^build\.[cm]?[jt]sx?$/;

/**
 * The bundlers whose default is to inline. tsup, tsdown, bunchee, unbuild and
 * obuild all leave `dependencies` and `peerDependencies` for the run time and
 * compile every other import into the output — so a devDependency the shipped
 * code imports ships inside the file, and an install without dev dependencies
 * is missing nothing. changesets even writes the fact down as
 * `inlinedDependencies`.
 *
 * A package says which bundler builds it in one of two places: a config at
 * its root, or the script that runs the build. `build.config.ts` is unbuild's
 * and obuild's; bunchee has no config at all, and `"build": "tsup src/index.ts
 * --format esm,cjs"` is a tsup that never needed one.
 */
const INLINING_BUNDLER_CONFIG = /^(?:tsup|tsdown|build)\.config\.[cm]?[jt]s$/;
const INLINING_BUNDLERS = new Set(['tsup', 'tsdown', 'bunchee', 'unbuild', 'obuild']);

/** Extensions the JavaScript token scanner can read; the rest are data files. */
const CODE_EXTENSION = /\.[cm]?[jt]sx?$/;

const SCRIPT_SRC = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;

/** True when this file is a tool's configuration rather than product code. */
export function isToolConfig(filePath: string, packageDirs: readonly string[]): boolean {
  const name = path.basename(filePath);
  if (CONFIG_NAME.test(name) || RC_NAME.test(name)) return true;
  if (!SECOND_TARGET_NAME.test(name)) return false;
  const dir = path.dirname(filePath);
  return packageDirs.some(packageDir => dir === packageDir);
}

/**
 * The packages behind the short names an ESLint config writes.
 *
 * ESLint lets a config say `plugins: [import]`, `plugin:unicorn/recommended`
 * and `import/no-cycle`, and all three load `eslint-plugin-import` or
 * `eslint-plugin-unicorn`. `extends: "prettier"` is the same shorthand for a
 * shareable config, `eslint-config-prettier`. Nothing in the file spells
 * either package out, so matching the strings as written finds none of them
 * and the report calls every one a dead dependency.
 *
 * A short name can expand more than one way — `prettier` is a plugin, a
 * config, or the formatter itself — so this offers all of them. The dependency
 * check keeps only what the manifest lists, and drops the rest.
 */
function eslintPluginPackages(strings: string[]): string[] {
  const found: string[] = [];
  for (const written of strings) {
    const [first = '', second] = written.replace(/^plugin:/, '').split('/');
    if (!first.startsWith('@')) {
      if (/^[\w-]+$/.test(first)) {
        found.push(`eslint-plugin-${first}`, `eslint-config-${first}`, `eslint-import-resolver-${first}`);
      }
      continue;
    }
    found.push(`${first}/eslint-plugin`, `${first}/eslint-config`);
    if (second && /^[\w-]+$/.test(second)) {
      found.push(`${first}/eslint-plugin-${second}`, `${first}/eslint-config-${second}`);
    }
  }
  return found;
}

/**
 * The packages behind the icon collections unplugin-icons loads.
 *
 * `import Logo from '~icons/logos/github-icon'` loads `@iconify-json/logos`,
 * and the plugin spells the package nowhere the file does. The same
 * collection is written as `virtual:icons/logos/…` in the plugin's other
 * prefix. Nothing else in a site names the collection package.
 */
const ICON_IMPORT = /^(?:~icons|virtual:icons)\/([\w-]+)\//;

function iconCollectionPackages(strings: string[]): string[] {
  const found: string[] = [];
  for (const written of strings) {
    const collection = ICON_IMPORT.exec(written)?.[1];
    if (collection) found.push(`@iconify-json/${collection}`);
  }
  return found;
}

/**
 * The package behind the environment name a Jest config writes.
 *
 * `testEnvironment: 'jsdom'` loads `jest-environment-jsdom`, and jest spells
 * the package differently from the value — which is the whole reason the
 * string as written matches nothing. A name already shaped like a package
 * (`@edge-runtime/jest-environment`) needs no expansion and gets one anyway;
 * the unlisted one is dropped.
 */
function jestEnvironmentPackages(strings: string[]): string[] {
  return strings.filter(written => /^[\w-]+$/.test(written)).map(written => `jest-environment-${written}`);
}

/**
 * Every name a data config writes: quoted strings, and the bare scalars YAML
 * lets a list write without quotes (`plugins:\n  - unicorn`). Comments are cut
 * first, so a plugin somebody turned off stays off.
 *
 * Over-reading is safe in a data file and under-reading is not. The dependency
 * check drops every string it cannot match to a package name, so a stray word
 * costs nothing; a plugin name this misses becomes a package the report calls
 * unused. A config written as code is another matter — its bare words are the
 * code, and `import js from '@eslint/js'` must not expand to the import plugin
 * — so a code file's short names come off its token stream as object keys.
 */
function dataConfigStrings(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split('\n')) {
    const code = line.replace(/(^|\s)(#|\/\/).*$/, '');
    for (const match of code.matchAll(/["']([^"']*)["']|([@\w][\w./@-]*)/g)) {
      const value = match[1] ?? match[2];
      if (value) found.push(value);
    }
  }
  return found;
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
  /**
   * Read this one for the packages it names, never for the paths.
   *
   * A build config written as code is a file the build runs, and a path in it
   * is an input. A config written as data is a settings file, and the paths in
   * it are as often the opposite of an input: `ignore`, `exclude`, `scope`,
   * `mutate`. So is a file in a tool's own directory — a workflow names the
   * script it runs, and running a file in CI does not publish its exports.
   */
  namesOnly: boolean;
  /**
   * The tool that loads this file by its name, from its own directory —
   * `vitepress` for `.vitepress/config.ts`. Such a file is an entry point when
   * the program holds it.
   */
  loadedBy: string | undefined;
  /**
   * The globs Storybook's `main` config lists under `stories`, relative to
   * its directory. Every named export of a file they match is a story, which
   * makes each such file an entry point.
   */
  storyGlobs: string[];
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
  /**
   * The packages this package's own build leaves for the run time to provide.
   * Nothing comes back when no build file here says, which is most packages.
   */
  externals(packageDir: string): Set<string> | undefined;
}

export function configReader(fileSystem: ReadOnlyFileSystem): ConfigReader {
  const walked = new Map<string, Walk>();
  const walk = (packageDir: string): Walk => {
    let found = walked.get(packageDir);
    if (!found) {
      found = toolConfigs(packageDir, fileSystem);
      walked.set(packageDir, found);
    }
    return found;
  };
  return {
    readFile: filePath => fileSystem.readFile(filePath),
    configs: packageDir => walk(packageDir).configs,
    strings: packageDir => walk(packageDir).configs.flatMap(config => config.strings),
    externals: packageDir => walk(packageDir).externals,
  };
}

/** True when a root-anchored tool directory sits somewhere under this one. */
function leadsToAToolDir(relative: string): boolean {
  for (const owned of ROOT_TOOL_DIRS) {
    if (owned.startsWith(`${relative}/`)) return true;
  }
  return false;
}

/** The tool directory this file sits in, by name, or nothing. */
function toolDirOf(filePath: string): { name: string; dir: string } | undefined {
  for (let dir = path.dirname(filePath); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const name = path.basename(dir);
    if (TOOL_DIR_NAMES.has(name)) return { name, dir };
  }
  return undefined;
}

/** The tool that loads this file by name from its own directory, or nothing. */
function loadedByName(filePath: string): string | undefined {
  const owner = toolDirOf(filePath);
  if (!owner) return undefined;
  const inside = path.relative(owner.dir, filePath).split(path.sep).join('/');
  return LOADED_BY_NAME[owner.name]?.test(inside) ? owner.name.slice(1) : undefined;
}

/** True for `.storybook/main.*`, whichever `.storybook` it is. */
function isStorybookMain(filePath: string): boolean {
  return path.basename(path.dirname(filePath)) === '.storybook' && STORYBOOK_MAIN.test(path.basename(filePath));
}

/** One package's build files, read once. */
interface Walk {
  configs: ToolConfig[];
  externals: Set<string> | undefined;
}

function toolConfigs(packageDir: string, fileSystem: ReadOnlyFileSystem): Walk {
  const found: string[] = [];
  const builds: string[] = [];
  const ownedFiles: string[] = [];
  const walk = (dir: string, ownedByATool: boolean): void => {
    for (const child of fileSystem.readDir(dir)) {
      const name = path.basename(child.path);
      if (child.isDirectory) {
        if (SKIP_DIRS.has(name)) continue;
        const relative = path.relative(packageDir, child.path).split(path.sep).join('/');
        const owned = ownedByATool || ROOT_TOOL_DIRS.has(relative) || TOOL_DIR_NAMES.has(name);
        // A dot-directory is walked only on the way to a tool's own directory.
        if (owned || !name.startsWith('.') || leadsToAToolDir(relative)) walk(child.path, owned);
        continue;
      }
      if (ownedByATool) {
        found.push(child.path);
        ownedFiles.push(child.path);
      } else if (name.endsWith('.html') || isToolConfig(child.path, [packageDir])) found.push(child.path);
      else if (dir === packageDir && BUILD_NAME.test(name)) builds.push(child.path);
    }
  };
  walk(packageDir, false);

  const configs: ToolConfig[] = [];
  const inToolDir = new Set(ownedFiles);
  for (const filePath of found.sort((a, b) => a.localeCompare(b))) {
    const text = fileSystem.readFile(filePath);
    if (text === undefined) continue;
    const html = filePath.endsWith('.html');
    // HTML has no token stream to read; its strings are the `<script src>`
    // values and nothing else, and it imports nothing of its own. A YAML or
    // JSON config has none either, and imports nothing.
    const none: string[] = [];
    const noKeys: ConfigKey[] = [];
    const { strings, specifiers, keys } = html
      ? // SCRIPT_SRC's one group is not optional: every match captures it.
        { strings: [...text.matchAll(SCRIPT_SRC)].map(match => match[1]!), specifiers: none, keys: noKeys }
      : CODE_EXTENSION.test(filePath)
        ? configLiterals(text)
        : { strings: dataConfigStrings(text), specifiers: none, keys: noKeys };
    const name = path.basename(filePath);
    const inToolDirHere = inToolDir.has(filePath);
    configs.push({
      filePath,
      dir: path.dirname(filePath),
      label: path.relative(packageDir, filePath) || path.basename(filePath),
      html,
      namesOnly: inToolDirHere || (!html && !CODE_EXTENSION.test(filePath)),
      loadedBy: inToolDirHere ? loadedByName(filePath) : undefined,
      storyGlobs: inToolDirHere && isStorybookMain(filePath) ? strings.filter(written => written.includes('*')) : [],
      strings: [...strings, ...expansionsFor(name, strings, keys, inToolDirHere)],
      imported: new Set(specifiers),
    });
  }
  const manifest = readManifest(packageDir, fileSystem);
  return {
    configs,
    externals: externalPackages([...builds, ...configs.map(c => c.filePath)], packageDir, manifest, fileSystem),
  };
}

/** The package's own manifest, parsed, or nothing when there is none to read. */
function readManifest(packageDir: string, fileSystem: ReadOnlyFileSystem): Record<string, unknown> | undefined {
  const text = fileSystem.readFile(path.join(packageDir, 'package.json'));
  if (text === undefined) return undefined;
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return undefined;
  }
  return typeof manifest === 'object' && manifest !== null ? (manifest as Record<string, unknown>) : undefined;
}

/** The names a manifest's `dependencies` and `peerDependencies` sections hold. */
function runtimeDependencies(manifest: Record<string, unknown> | undefined): string[] {
  if (!manifest) return [];
  return ['dependencies', 'peerDependencies'].flatMap(key => {
    const section = manifest[key];
    return typeof section === 'object' && section !== null ? Object.keys(section) : [];
  });
}

/** True when a script of this manifest runs a bundler that inlines by default. */
function scriptsRunAnInliningBundler(manifest: Record<string, unknown> | undefined): boolean {
  return scriptsOf(manifest).some(({ command }) => commandTokens(command).some(token => INLINING_BUNDLERS.has(token)));
}

/**
 * The packages a config's short names stand for, when the tool reading it
 * expands them. Nothing else is added: a config norefs knows no expansion for
 * says exactly what it writes.
 *
 * ESLint's short names are not always strings. `'import/resolver': {
 * typescript: true }` writes the resolver as an object key, so the keys a code
 * config writes are offered too — except the keys of `env`, `globals` and
 * `settings`, which name environments, variables and a plugin's settings
 * rather than plugins. PostCSS goes the other way: every key of its `plugins`
 * block is a package, loaded by that name. A data config's bare scalars are
 * already among its strings. Only expansions leave here, never the words
 * themselves, and only the manifest's own names survive the expansion.
 *
 * The file's own name counts too. `postcss.config.js` is read by postcss and
 * `tailwind.config.js` by tailwindcss, and a config is often the one place a
 * project writes the tool down. A file in a tool's directory has no such
 * name, and is left to what it writes.
 */
function expansionsFor(name: string, strings: string[], keys: ConfigKey[], inToolDir: boolean): string[] {
  const found = [...(inToolDir ? [] : toolNamedBy(name)), ...iconCollectionPackages(strings)];
  if (ESLINT_CONFIG_NAME.test(name)) {
    const plugins = keys.filter(key => key.under === undefined || !ESLINT_PLAIN_BLOCKS.has(key.under));
    found.push(...eslintPluginPackages([...strings, ...plugins.map(key => key.name)]));
  } else if (JEST_CONFIG_NAME.test(name)) {
    found.push(...jestEnvironmentPackages(strings));
  } else if (POSTCSS_CONFIG_NAME.test(name)) {
    found.push(...keys.filter(key => key.under === 'plugins').map(key => key.name));
  }
  return found;
}

/** The package a config file's name says reads it: `vitest.config.ts` is vitest's. */
function toolNamedBy(name: string): string[] {
  const tool = /^(?:\.([\w-]+)rc(?:\.[\w]+)?|([\w-]+)\.config\.)/.exec(name);
  const short = tool?.[1] ?? tool?.[2];
  if (!short) return [];
  return [TOOL_PACKAGES[short] ?? short];
}

/**
 * What every build file in this package leaves external, put together.
 *
 * A package builds more than one output — a CLI, a library, an ESM copy — and
 * a name any one of them keeps external is a name the install still needs. So
 * the lists are added up, and one list this cannot read makes the whole answer
 * unknown rather than short.
 *
 * Only the files at the package root are read. A build deeper in the tree
 * belongs to something else — a fixture, an example — and what it inlines says
 * nothing about what this package ships.
 *
 * A bundler that inlines by default declares a list without writing one — its
 * config at the root, or the script that runs it, is the declaration. The
 * manifest's own `dependencies` and `peerDependencies` are external then, and
 * an explicit `external` adds to that rather than replacing it.
 */
function externalPackages(
  filePaths: string[],
  packageDir: string,
  manifest: Record<string, unknown> | undefined,
  fileSystem: ReadOnlyFileSystem
): Set<string> | undefined {
  const names = new Set<string>();
  let declared = false;
  if (scriptsRunAnInliningBundler(manifest)) {
    declared = true;
    for (const name of runtimeDependencies(manifest)) names.add(name);
  }
  for (const filePath of filePaths) {
    if (path.dirname(filePath) !== packageDir || !CODE_EXTENSION.test(filePath)) continue;
    const text = fileSystem.readFile(filePath);
    if (text === undefined) continue;
    if (INLINING_BUNDLER_CONFIG.test(path.basename(filePath))) {
      declared = true;
      for (const name of runtimeDependencies(manifest)) names.add(name);
    }
    const found = bundlerExternals(text);
    if (!found) continue;
    if (!found.known) return undefined;
    declared = true;
    for (const name of found.names) names.add(name);
  }
  return declared ? names : undefined;
}
