import { builtinModules } from 'node:module';
import path from 'node:path';
import { minimatch } from 'minimatch';
import { ts } from 'ts-morph';
import type { Finding, Verdict } from '../types';
import { isHarnessFile } from './reachability';
import { commandTokens, scriptsOf } from './scripts';
import { escapeRegExp, stripQuerySuffix } from './text';

const BUILTINS = new Set(builtinModules);

/** An import that names a package rather than project code. */
export interface DependencyUse {
  filePath: string;
  /** The specifier as written: "react", "lodash/fp". */
  text: string;
  /** Offset of the literal, for the finding's position and its suppression check. */
  start: number;
  /** The compiler erases this import, so it needs nothing installed at run time. */
  typeOnly: boolean;
  /**
   * The specifier resolved to project code rather than into a package. A
   * workspace dependency linked by path reads this way and is still the
   * package being used; so does a `baseUrl` import that names no package at
   * all. Which one it is, the manifest decides — so a use like this can say a
   * listed name is used, and can never ask for a name to be listed.
   */
  internal: boolean;
  /**
   * The file sits beside the program rather than in it — a test the tsconfig
   * excludes, a script nobody compiles. Nothing in it was analyzed, so it can
   * say a listed name is used, and can never ask for a name to be listed.
   */
  outside?: boolean | undefined;
}

/** What the checks need to read the manifests and place a finding. */
interface DependencyContext {
  fileExists(filePath: string): boolean;
  readFile(filePath: string): string | undefined;
  isSuppressedAt(filePath: string, offset: number): boolean;
  positionAt(filePath: string, offset: number): { line: number; column: number };
  /** Every string written in this package's tool configs, imports included. */
  configStrings(dir: string): string[];
  /** Packages this package's own build leaves for the run time to provide. */
  bundlerExternals(dir: string): Set<string> | undefined;
}

interface Manifest {
  filePath: string;
  dir: string;
  text: string;
  /** Names in "dependencies": what the package ships with. */
  dependencies: string[];
  /** Names in "devDependencies": what building and testing it needs. */
  devDependencies: string[];
  /** Names in every dependency section; imports of these are never unlisted. */
  listed: Set<string>;
  /** Names in "peerDependencies": what the consumer installs, not this package. */
  peer: Set<string>;
  used: Set<string>;
  /**
   * Names imported by a file beside the program rather than in it. The import
   * is real, so the package is used; nothing in that file was analyzed, so
   * when it is needed is a question this run cannot answer.
   */
  usedOutside: Set<string>;
  /** Names imported from a file that is not a test, spec, story, bench, or config. */
  usedInProduction: Set<string>;
  /**
   * The same, minus the imports the compiler erases. A package a shipped file
   * reads for types alone is absent from the build output, so an install
   * without it still runs.
   */
  neededAtRuntime: Set<string>;
  /** Names a script runs, matched against what each package declares as its binary. */
  usedByScript: Set<string>;
  /** Names a tool config writes: `environment: 'jsdom'` is jsdom being loaded. */
  usedByConfig: Set<string>;
  /** Plugins a used package's peer list says that package loads. */
  pluggedInto: Set<string>;
  /**
   * True for `"private": true`: a package npm refuses to publish. Nobody
   * installs it, so which section a name sits in decides nothing.
   */
  private: boolean;
}

/**
 * Two package.json checks: dependencies nothing imports, and imports of
 * packages no scanned package.json lists. devDependencies are consumed by
 * tooling the import graph cannot see, so they count as listed but are never
 * reported unused; the same goes for peer and optional dependencies, which
 * exist for consumers. @types packages are consumed by the compiler itself.
 *
 * The uses arrive in file order, so an unlisted package is reported at the
 * first import that names it.
 *
 * `packageDirs` holds every manifest the run answers for: the directories it
 * was pointed at, and the workspace packages under them whose files it holds.
 */
export function analyzeDependencies(
  uses: DependencyUse[],
  packageDirs: string[],
  options: {
    scopeDir?: string | undefined;
    /** Dependency names or globs never reported. */
    ignore: string[];
    /** tsconfig `paths` patterns: an alias into project code, never a package. */
    aliasPatterns: string[];
    /**
     * The shipping code path alone. A harness file is absent, so what it
     * imports is not usage — and devDependencies, which exist to build and
     * test, are outside the question this run is asking.
     */
    production?: boolean | undefined;
    /**
     * Files no chain of imports from an entry point reaches.
     *
     * Which section a package belongs in is a claim about when it is needed,
     * and a file the shipped product cannot reach never needs anything. A
     * name tells you a test — `*.test.ts` — and reachability tells you the
     * helper directory beside it: valibot's `src/vitest/` is named after the
     * tool it wraps, imported by tests alone, and the report used to advise
     * shipping a test framework in `dependencies` on the strength of it.
     *
     * Empty when the run resolved no entry point, because then nothing is
     * reachable and the answer would be that nothing ships.
     */
    offShippingPath?: ReadonlySet<string> | undefined;
  },
  context: DependencyContext
): Finding[] {
  const { scopeDir, ignore, aliasPatterns, production, offShippingPath } = options;
  const manifests: Manifest[] = [];
  for (const dir of packageDirs) {
    const manifest = readManifest(context, dir);
    if (manifest) manifests.push(manifest);
  }
  if (manifests.length === 0) return [];

  const listedAnywhere = new Set(manifests.flatMap(m => [...m.listed]));
  // In a monorepo, the workspace root lists the hoisted tooling. Ancestor
  // manifests satisfy the unlisted check, but their own dependencies are
  // consumed by packages this scan cannot see, so they are never reported —
  // which is why the names are all that gets read here. Working out what uses
  // them would mean reading a tree this run was never pointed at.
  for (const dir of packageDirs) {
    for (let parent = path.dirname(dir); parent !== path.dirname(parent); parent = path.dirname(parent)) {
      const found = readSections(context, parent);
      if (found) for (const name of listedNames(found.sections)) listedAnywhere.add(name);
    }
  }
  const findings: Finding[] = [];
  const reportedUnlisted = new Set<string>();

  for (const use of uses) {
    // A production run treats the harness as absent, so its imports are not
    // usage — which also makes every use that gets this far a shipped one.
    const shipped = !isHarnessFile(use.filePath, packageDirs) && offShippingPath?.has(use.filePath) !== true;
    if (production && !shipped) continue;
    const specifier = stripQuerySuffix(use.text);
    // A `paths` alias is project code, and a package can share its name: valtio
    // aliases `valtio` to its own `src/` while its website lists `valtio` as a
    // dependency and imports it. The manifest decides which it is, the way it
    // does for a specifier that resolved into the repo — so an aliased import
    // can say a listed name is used, and can never ask for one to be listed.
    const aliased = matchesAlias(specifier, aliasPatterns);
    const name = packageName(specifier);
    if (!name) continue;
    for (const owner of owningManifests(use.filePath, manifests)) {
      if (use.outside) {
        owner.usedOutside.add(name);
        continue;
      }
      owner.used.add(name);
      if (!shipped) continue;
      owner.usedInProduction.add(name);
      if (!use.typeOnly) owner.neededAtRuntime.add(name);
    }

    if (use.internal || use.outside || aliased) continue;
    if (listedAnywhere.has(name) || listedAnywhere.has(typesPackage(name))) continue;
    if (reportedUnlisted.has(name) || isIgnored(name, ignore)) continue;
    if (scopeDir && !use.filePath.startsWith(scopeDir)) continue;
    if (context.isSuppressedAt(use.filePath, use.start)) continue;
    reportedUnlisted.add(name);
    const { line, column } = context.positionAt(use.filePath, use.start);
    findings.push({
      kind: 'unlisted',
      filePath: use.filePath,
      line,
      column,
      name,
      context: '',
      anonymous: false,
    });
  }

  // Which hosts load which plugins depends on which hosts are used, so it is
  // answered once the uses are all in.
  for (const manifest of manifests) collectPluginPeers(manifest, context);

  for (const manifest of manifests) {
    const sections = production ? (['dependencies'] as const) : (['dependencies', 'devDependencies'] as const);
    for (const section of sections) {
      for (const name of manifest[section]) {
        // @types packages are consumed by the compiler, which no import shows.
        if (name.startsWith('@types/') || isIgnored(name, ignore)) continue;
        const at = manifestPosition(manifest.text, section, name);
        const place = (finding: { kind: 'dependency' | 'misplaced'; verdict?: Verdict; evidence: string }) =>
          findings.push({ ...finding, filePath: manifest.filePath, ...at, name, context: section, anonymous: false });

        const imported = manifest.used.has(name) || manifest.usedOutside.has(name);
        // Four things count as using a package, and only one is an import: a
        // script that runs its command, a tool config that names it, or a host
        // this project uses whose peer list says it loads it.
        const invisible =
          !imported &&
          !manifest.usedByScript.has(name) &&
          !manifest.usedByConfig.has(name) &&
          !manifest.pluggedInto.has(name);
        if (invisible) {
          // A devDependency the peer list names too is not this package's to
          // install: the consumer brings it, and the dev listing is how the
          // package builds and tests against the peer it declares. The pairing
          // is why the line is there, so no import has to be.
          if (section === 'devDependencies' && manifest.peer.has(name)) continue;
          if (!unusedIsProvable(manifest, name, section, context)) continue;
          place({
            kind: 'dependency',
            verdict: 'dead',
            // A production run never looked at the harness, so it cannot say
            // the whole source tree is silent — only the half it read.
            evidence: production
              ? 'no file on the shipping path imports it, no script runs it, and no config or host names it'
              : 'no source file imports it, no script runs it, and no config or host names it',
          });
          continue;
        }

        // A package the program never saw imported, named only by a file
        // beside it, is used — and which section it belongs in is a claim
        // about when it is needed, which only a file this run read can settle.
        if (!manifest.used.has(name) && manifest.usedOutside.has(name)) continue;

        // Which section a package sits in is a claim about when it is needed.
        // Getting it wrong one way ships a broken install; the other way ships
        // weight nobody uses. A production run cannot say: it never looked at
        // the half of the code that would decide it.
        if (production) continue;
        // Neither claim can be made about a package that never ships. A
        // private workspace — the repo root, an integration-test package —
        // is installed by nobody, and every name in it is installed the same
        // way whichever section holds it.
        if (manifest.private) continue;

        if (section === 'devDependencies') {
          // Only a runtime import breaks the install. `import type` is erased,
          // so a devDependency the shipped code reads for types alone is where
          // it belongs — and moving it would ship weight the output never loads.
          if (!manifest.neededAtRuntime.has(name)) continue;
          // Unless no install is what provides it in the first place.
          if (providedByEnvironment(manifest.dir, name, context)) continue;
          // A peer dependency is the consumer's to install, and listing it
          // here as well is how a package builds and tests against its own
          // peer. Whoever installs the package brings it, so an install
          // without dev dependencies is missing nothing.
          if (manifest.peer.has(name)) continue;
          // Nor when the build inlines it. A bundler is told what to leave for
          // the run time, and everything else it is handed ends up inside the
          // output file. A name the list omits ships with the package.
          const externals = context.bundlerExternals(manifest.dir);
          if (externals && !externals.has(name)) continue;
          place({
            kind: 'misplaced',
            evidence: 'production code imports it, so an install without dev dependencies is missing it',
          });
          continue;
        }

        // Shipped and used by the shipping path: the section is right.
        if (manifest.usedInProduction.has(name)) continue;

        // Nothing on the shipping path uses it. A script can be the consumer's
        // own — `start`, `postinstall` — and a host that loads a plugin may be
        // shipped itself, so neither of those settles the section.
        if (!manifest.usedByScript.has(name) && !manifest.pluggedInto.has(name)) {
          place({
            kind: 'misplaced',
            evidence: 'only test, spec, story, bench, and config files use it, so it ships for nothing',
          });
        }
      }
    }
  }
  return findings;
}

/**
 * Whether "nothing uses it" is something this run can actually establish.
 *
 * A package's binaries live in its own manifest, and a package that is not
 * installed has none to read — so a devDependency run by a command whose name
 * differs from the package's would look unused when it is not. `dependencies`
 * has been reported without that evidence since the check existed, and the
 * shape it would miss (a build tool shipped to consumers) barely occurs. The
 * new claim is the one that waits for proof.
 */
function unusedIsProvable(
  manifest: Manifest,
  name: string,
  section: 'dependencies' | 'devDependencies',
  context: DependencyContext
): boolean {
  return section === 'dependencies' || installedPackage(manifest.dir, name, context) !== undefined;
}

/**
 * True when the package declares itself as an ambient module.
 *
 * `import { app } from 'electron'` reads a `declare module 'electron'` block in
 * electron's own types. That is the shape of an API the host supplies: the
 * binary that loads the code brings the module with it, and no file in
 * node_modules is what the import lands on at run time. An editor's extension
 * API says it the same way.
 *
 * Which section such a package belongs in is decided by whatever packages the
 * app — electron-builder wants `electron` in `devDependencies`, and reads it
 * from there to pick the runtime it bundles. An install that omits dev
 * dependencies is not what puts the module in place, so the claim that such an
 * install would be missing it has nothing behind it, and norefs does not make
 * it.
 *
 * That is all this decides, and deliberately so. An ordinary package writes
 * `declare module` too — it is how a library that predates ES modules ships its
 * types, and `@xterm/headless`, `node-pty` and `toml` all do it while being
 * exactly what they look like. The signal is strong enough to withhold a claim
 * and far too weak to make one, so it is only ever read in the direction that
 * reports nothing.
 */
function providedByEnvironment(dir: string, name: string, context: DependencyContext): boolean {
  const found = installedPackage(dir, name, context);
  if (!found) return false;
  const data = found.data as { types?: unknown; typings?: unknown };
  const types = [data.types, data.typings].find(entry => typeof entry === 'string');
  if (types === undefined) return false;
  const typesPath = path.resolve(found.dir, types);
  const text = context.fileExists(typesPath) ? context.readFile(typesPath) : undefined;
  if (text === undefined) return false;
  const quoted = escapeRegExp(name);
  return new RegExp(`declare\\s+module\\s+['"]${quoted}['"]`).test(text);
}

/** A package.json at this directory, parsed, or nothing when there is none to read. */
function readSections(
  context: DependencyContext,
  dir: string
): { filePath: string; text: string; sections: Record<string, unknown> } | undefined {
  const filePath = path.join(dir, 'package.json');
  if (!context.fileExists(filePath)) return undefined;
  const text = context.readFile(filePath);
  if (text === undefined) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null) return undefined;
  return { filePath, text, sections: data as Record<string, unknown> };
}

/** Every name in every dependency section: what a manifest satisfies. */
function listedNames(sections: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const section = sections[key];
    if (typeof section === 'object' && section !== null) for (const name of Object.keys(section)) names.add(name);
  }
  return names;
}

function readManifest(context: DependencyContext, dir: string): Manifest | undefined {
  const found = readSections(context, dir);
  if (!found) return undefined;
  const { filePath, text, sections } = found;
  const names = (key: string): string[] => {
    const section = sections[key];
    return typeof section === 'object' && section !== null ? Object.keys(section) : [];
  };
  const manifest: Manifest = {
    filePath,
    dir,
    text,
    dependencies: names('dependencies'),
    devDependencies: names('devDependencies'),
    listed: listedNames(sections),
    peer: new Set(names('peerDependencies')),
    used: new Set(),
    usedOutside: new Set(),
    usedInProduction: new Set(),
    neededAtRuntime: new Set(),
    usedByScript: new Set(),
    usedByConfig: new Set(),
    pluggedInto: new Set(),
    private: sections['private'] === true,
  };
  // One map of every command this project can run, built once and read by
  // both: a script and a git hook name a binary the same way.
  const commands = runnableCommands(manifest, context);
  collectScriptUse(manifest, sections, commands);
  collectConfigUse(manifest, sections, context, commands);
  collectEmittedHelpers(manifest, context);
  return manifest;
}

/**
 * Every command name this project can run, and the package behind it.
 *
 * A package's own name counts, and so does each binary it declares — `tsgo` is
 * `@typescript/native-preview`, and nothing but that package's manifest says
 * so. What is not installed declares nothing, and a package whose binaries are
 * unknown is never called unused: see `unusedIsProvable`.
 */
function runnableCommands(manifest: Manifest, context: DependencyContext): Map<string, string> {
  const owner = new Map<string, string>();
  for (const name of manifest.listed) {
    owner.set(name, name);
    for (const binary of declaredBinaries(manifest.dir, name, context)) owner.set(binary, name);
  }
  return owner;
}

/**
 * The packages this manifest's own tool configs name.
 *
 * `environment: 'jsdom'` loads jsdom. An ESLint config imports its plugins, and
 * the compiler never sees that file. Neither package is imported by anything on
 * the import graph, and both are in use — the config says so, in the same
 * plain string a bundler input is written in. A string that matches no listed
 * package is dropped, which is every other string in the file.
 */
function collectConfigUse(
  manifest: Manifest,
  sections: Record<string, unknown>,
  context: DependencyContext,
  commands: Map<string, string>
): void {
  const written = [
    ...context.configStrings(manifest.dir),
    ...tsconfigPackages(manifest.dir, context),
    ...manifestConfigStrings(manifest, sections),
  ];
  for (const value of written) {
    // A config value can be a command-line argument — ava runs
    // `--import=tsx/esm` — so the same splitting a script gets applies, and a
    // plain string comes back through it unchanged.
    for (const token of [value, ...commandTokens(value)]) {
      const name = packageName(stripQuerySuffix(token));
      if (name && manifest.listed.has(name)) manifest.usedByConfig.add(name);
      // A hook and a workflow run a command, the same as a script does, and
      // a command is rarely spelled the way its package is.
      const behind = commands.get(token);
      if (behind) manifest.usedByConfig.add(behind);
    }
  }
}

/**
 * The manifest's own configuration blocks.
 *
 * A tool's config file is often not a file: `"lint-staged": { … }` and
 * `"ava": { … }` sit in package.json, and the key is the tool's name. So a
 * top-level key that names a package this manifest lists is that package being
 * configured — which is the same evidence a `.lint-stagedrc` would be — and
 * the strings inside the block are read the way a config file's are.
 *
 * Only a block whose key names a listed package is read. Every other key is
 * npm's own, and `"keywords": ["react"]` is a word about the package rather
 * than a package in use.
 */
function manifestConfigStrings(manifest: Manifest, sections: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const [key, value] of Object.entries(sections)) {
    if (!manifest.listed.has(key)) continue;
    found.push(key);
    collectStrings(value, found);
  }
  return found;
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (typeof value === 'object' && value !== null)
    for (const nested of Object.values(value)) collectStrings(nested, out);
}

/** The package's own tsconfig, parsed, or nothing when there is none to read. */
interface TsConfig {
  extends?: unknown;
  compilerOptions?: { types?: unknown; plugins?: unknown; importHelpers?: unknown };
}

function readTsConfig(dir: string, context: DependencyContext): TsConfig | undefined {
  const filePath = path.join(dir, 'tsconfig.json');
  if (!context.fileExists(filePath)) return undefined;
  const text = context.readFile(filePath);
  if (text === undefined) return undefined;
  // A tsconfig carries comments and trailing commas, so the compiler's own
  // reader does the parsing.
  const { config, error } = ts.parseConfigFileTextToJson(filePath, text);
  if (error || typeof config !== 'object' || config === null) return undefined;
  return config as TsConfig;
}

/**
 * The packages this package's own tsconfig names.
 *
 * `extends: "@sindresorhus/tsconfig"` is a package the build needs, and no
 * import will ever name it. `types: ["node", "@withfig/autocomplete-types"]`
 * is the compiler being told to load those, which is the same statement a
 * `/// <reference types>` makes and already counts as. `plugins: [{ name:
 * "@effect/language-service" }]` is a third: the compiler loads what that
 * array names exactly as it loads what `types` names.
 *
 * It is read here rather than through the tool-config reader because a
 * tsconfig is not a tool config: its `include` globs are patterns, not paths
 * to anything an entry-point walk should publish.
 */
function tsconfigPackages(dir: string, context: DependencyContext): string[] {
  const config = readTsConfig(dir, context);
  if (!config) return [];
  const found: string[] = [];
  if (typeof config.extends === 'string') found.push(config.extends);
  else if (Array.isArray(config.extends)) found.push(...config.extends.filter(entry => typeof entry === 'string'));
  const types = config.compilerOptions?.types;
  if (Array.isArray(types)) found.push(...types.filter(entry => typeof entry === 'string'));
  const plugins = config.compilerOptions?.plugins;
  if (Array.isArray(plugins)) {
    for (const plugin of plugins) {
      const name = (plugin as { name?: unknown } | null)?.name;
      if (typeof name === 'string') found.push(name);
    }
  }
  return found;
}

/**
 * The helper library the compiler emits calls to.
 *
 * `importHelpers` turns every downlevelled spread, decorator and `await` into
 * a `tslib` call in the output file. Nothing in the source says so, and the
 * package ships with the code — so this is not a config naming a tool, it is
 * the built output importing a package, and it answers the section question
 * the same way an import would. Which package is not a guess: the option
 * names `tslib` and nothing else.
 */
function collectEmittedHelpers(manifest: Manifest, context: DependencyContext): void {
  if (!manifest.listed.has('tslib')) return;
  if (readTsConfig(manifest.dir, context)?.compilerOptions?.importHelpers !== true) return;
  manifest.used.add('tslib');
  manifest.usedInProduction.add('tslib');
  manifest.neededAtRuntime.add('tslib');
}

/**
 * The plugins a host loads on its own.
 *
 * `bufferutil` runs behind `ws` and `jsdom` behind a test environment: nothing
 * imports them, no script names them, and both are in use. What they have in
 * common is written in the host's own manifest — a package that lists them as
 * peer dependencies, which is how the ecosystem says "that one loads me". So
 * this reads the same evidence the binaries came from, an installed package's
 * own package.json, and only for a host this project actually uses.
 *
 * The plugin says it too, and for `@vitest/coverage-v8` it is the only one who
 * does: it runs behind `--coverage`, and vitest's peer list has never named
 * it. Its own list names vitest. So a package answers here when both halves of
 * the statement hold — it is published under the host's own name, and it
 * declares that host as the peer it plugs into. One half alone is not enough:
 * `@typescript/typescript6` shares typescript's scope and is a compiler of its
 * own, and plenty of packages declare a peer without being anybody's plugin.
 */
function collectPluginPeers(manifest: Manifest, context: DependencyContext): void {
  for (const host of manifest.listed) {
    // A host imported only by a file beside the program is a host in use all
    // the same: a test the tsconfig excludes loads `@testing-library/react`,
    // and that is what loads `@testing-library/dom`.
    const used =
      manifest.used.has(host) ||
      manifest.usedOutside.has(host) ||
      manifest.usedByScript.has(host) ||
      manifest.usedByConfig.has(host);
    if (!used) continue;
    for (const name of manifest.listed) {
      if (!name.startsWith(`@${host}/`)) continue;
      if (declaresPeer(manifest.dir, name, host, context)) manifest.pluggedInto.add(name);
    }
    const peers = (installedPackage(manifest.dir, host, context)?.data as { peerDependencies?: unknown })
      ?.peerDependencies;
    if (typeof peers !== 'object' || peers === null) continue;
    for (const name of Object.keys(peers)) {
      if (name !== host && manifest.listed.has(name)) manifest.pluggedInto.add(name);
    }
  }
}

/**
 * The packages this manifest's own scripts run.
 *
 * `"build": "tsc -p tsconfig.json"` uses TypeScript, and no import says so —
 * which is why a tool that only reads the import graph has to treat every
 * devDependency as untouchable. The scripts already name it, so norefs reads
 * them: a token that matches a listed package's name, or a binary that package
 * declares, is that package being used.
 *
 * Every command comes from `runnableCommands`, which reads each installed
 * package's own manifest — so nothing here is a guess about which tool owns
 * which command.
 */
function collectScriptUse(manifest: Manifest, data: Record<string, unknown>, owner: Map<string, string>): void {
  const scripts = scriptsOf(data);
  if (scripts.length === 0) return;

  for (const { command } of scripts) {
    for (const token of commandTokens(command)) {
      // A token can be a deep path into a package — `--import=tsx/esm` loads
      // tsx — so the package it names counts as well as the token itself.
      const name = owner.get(token) ?? owner.get(binaryPathName(token)) ?? owner.get(packageName(token) ?? '');
      if (name) manifest.usedByScript.add(name);
    }
  }
}

/** True when this installed package declares `host` among its own peers. */
function declaresPeer(fromDir: string, name: string, host: string, context: DependencyContext): boolean {
  const peers = (installedPackage(fromDir, name, context)?.data as { peerDependencies?: unknown })?.peerDependencies;
  return typeof peers === 'object' && peers !== null && host in peers;
}

/**
 * The command a token written as a path into `node_modules/.bin` runs.
 * `node ./node_modules/.bin/tsd` is `tsd`, spelled the long way because the
 * script needs to hand node a flag the shim would swallow.
 */
function binaryPathName(token: string): string {
  return /(?:^|[\\/])node_modules[\\/]\.bin[\\/]([^\\/]+)$/.exec(token)?.[1] ?? '';
}

/**
 * The command names an installed package declares, from its own package.json
 * `bin` field. Node hoists, so the search climbs the way a require would.
 */
function declaredBinaries(fromDir: string, name: string, context: DependencyContext): string[] {
  const found = installedPackage(fromDir, name, context);
  if (found === undefined) return [];
  const bin = (found.data as { bin?: unknown }).bin;
  // A string `bin` is published under the package's own unscoped name.
  if (typeof bin === 'string') return [name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name];
  if (typeof bin === 'object' && bin !== null) return Object.keys(bin);
  return [];
}

/**
 * An installed package's own manifest and the directory holding it, or nothing
 * when it is not installed. The directory comes back because a path inside that
 * manifest — the types entry — is relative to it.
 */
function installedPackage(
  fromDir: string,
  name: string,
  context: DependencyContext
): { dir: string; data: unknown } | undefined {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const packageDir = path.join(dir, 'node_modules', name);
    const filePath = path.join(packageDir, 'package.json');
    // readFile throws on a path that is not there; fileExists is the guard
    // every other reader in this file uses.
    const text = context.fileExists(filePath) ? context.readFile(filePath) : undefined;
    if (text !== undefined) {
      try {
        return { dir: packageDir, data: JSON.parse(text) };
      } catch {
        return undefined;
      }
    }
    if (dir === path.dirname(dir)) return undefined;
  }
}

/** Manifests whose directory contains the file; every manifest when none does. */
function owningManifests(filePath: string, manifests: Manifest[]): Manifest[] {
  const owners = manifests.filter(m => filePath.startsWith(`${m.dir}/`) || filePath.startsWith(`${m.dir}${path.sep}`));
  return owners.length > 0 ? owners : manifests;
}

/** True when the specifier matches a tsconfig `paths` pattern: an alias into project code, never a package. */
function matchesAlias(specifier: string, patterns: string[]): boolean {
  return patterns.some(pattern => {
    const star = pattern.indexOf('*');
    if (star === -1) return specifier === pattern;
    return (
      specifier.length >= pattern.length - 1 &&
      specifier.startsWith(pattern.slice(0, star)) &&
      specifier.endsWith(pattern.slice(star + 1))
    );
  });
}

function packageName(specifier: string): string | undefined {
  // '.'/'/' are file paths, '#' is a Node subpath import: all project code.
  if (/^[./#]/.test(specifier)) return undefined;
  // A scheme names the host, not a package: `node:fs`, `bun:sqlite`,
  // `cloudflare:workers`. npm resolves none of them, so no manifest can list
  // one and calling it unlisted asks for a line nobody can write.
  if (/^[a-z][\w+.-]*:/.test(specifier)) return undefined;
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) {
    // A scoped name needs a real scope and a real name; '@/x' is an alias, not a package.
    const [scope = '', second] = parts;
    if (scope.length < 2 || !second) return undefined;
    return parts.slice(0, 2).join('/');
  }
  const name = parts[0];
  if (!name || BUILTINS.has(name)) return undefined;
  return name;
}

/** The DefinitelyTyped package for a name: react → @types/react, @scope/x → @types/scope__x. */
function typesPackage(name: string): string {
  return name.startsWith('@') ? `@types/${name.slice(1).replace('/', '__')}` : `@types/${name}`;
}

function isIgnored(name: string, ignore: string[]): boolean {
  return ignore.some(pattern => minimatch(name, pattern));
}

/**
 * Where a name sits inside a section. The search starts at the section's own
 * key, because a package name also appears in the script that runs it, and a
 * finding about `devDependencies` that points into `scripts` is a finding
 * pointing at the wrong line.
 */
function manifestPosition(text: string, section: string, name: string): { line: number; column: number } {
  const lines = text.split('\n');
  const from = lines.findIndex(line => line.includes(`"${section}"`));
  const index = lines.findIndex((line, at) => at >= Math.max(from, 0) && line.includes(`"${name}"`));
  const found = lines[index];
  if (found === undefined) return { line: 1, column: 1 };
  return { line: index + 1, column: found.indexOf(`"${name}"`) + 1 };
}
