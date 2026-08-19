import { builtinModules } from 'node:module';
import path from 'node:path';
import { minimatch } from 'minimatch';
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
}

/** What the checks need to read the manifests and place a finding. */
interface DependencyContext {
  fileExists(filePath: string): boolean;
  readFile(filePath: string): string | undefined;
  isSuppressedAt(filePath: string, offset: number): boolean;
  positionAt(filePath: string, offset: number): { line: number; column: number };
  /** Every string written in this package's tool configs, imports included. */
  configStrings(dir: string): string[];
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
  used: Set<string>;
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
 */
export function analyzeDependencies(
  uses: DependencyUse[],
  rootDirs: string[],
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
  },
  context: DependencyContext
): Finding[] {
  const { scopeDir, ignore, aliasPatterns, production } = options;
  const manifests: Manifest[] = [];
  for (const dir of rootDirs) {
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
  for (const dir of rootDirs) {
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
    const shipped = !isHarnessFile(use.filePath, rootDirs);
    if (production && !shipped) continue;
    const specifier = stripQuerySuffix(use.text);
    if (matchesAlias(specifier, aliasPatterns)) continue;
    const name = packageName(specifier);
    if (!name) continue;
    for (const owner of owningManifests(use.filePath, manifests)) {
      owner.used.add(name);
      if (!shipped) continue;
      owner.usedInProduction.add(name);
      if (!use.typeOnly) owner.neededAtRuntime.add(name);
    }

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

        const imported = manifest.used.has(name);
        // Four things count as using a package, and only one is an import: a
        // script that runs its command, a tool config that names it, or a host
        // this project uses whose peer list says it loads it.
        const invisible =
          !imported &&
          !manifest.usedByScript.has(name) &&
          !manifest.usedByConfig.has(name) &&
          !manifest.pluggedInto.has(name);
        if (invisible) {
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

        // Which section a package sits in is a claim about when it is needed.
        // Getting it wrong one way ships a broken install; the other way ships
        // weight nobody uses. A production run cannot say: it never looked at
        // the half of the code that would decide it.
        if (production) continue;

        if (section === 'devDependencies') {
          // Only a runtime import breaks the install. `import type` is erased,
          // so a devDependency the shipped code reads for types alone is where
          // it belongs — and moving it would ship weight the output never loads.
          if (!manifest.neededAtRuntime.has(name)) continue;
          // Unless no install is what provides it in the first place.
          if (providedByEnvironment(manifest.dir, name, context)) continue;
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
    used: new Set(),
    usedInProduction: new Set(),
    neededAtRuntime: new Set(),
    usedByScript: new Set(),
    usedByConfig: new Set(),
    pluggedInto: new Set(),
  };
  collectScriptUse(manifest, sections, context);
  collectConfigUse(manifest, context);
  return manifest;
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
function collectConfigUse(manifest: Manifest, context: DependencyContext): void {
  for (const written of context.configStrings(manifest.dir)) {
    const name = packageName(stripQuerySuffix(written));
    if (name && manifest.listed.has(name)) manifest.usedByConfig.add(name);
  }
}

/**
 * The plugins a host loads on its own.
 *
 * `@vitest/coverage-v8` runs behind `--coverage`, `bufferutil` behind `ws`,
 * `jsdom` behind a test environment: nothing imports them, no script names them,
 * and all three are in use. What they have in common is written in the host's
 * own manifest — a package that lists them as peer dependencies, which is how
 * the ecosystem says "that one loads me". So this reads the same evidence the
 * binaries came from, an installed package's own package.json, and only for a
 * host this project actually uses.
 */
function collectPluginPeers(manifest: Manifest, context: DependencyContext): void {
  for (const host of manifest.listed) {
    const used = manifest.used.has(host) || manifest.usedByScript.has(host) || manifest.usedByConfig.has(host);
    if (!used) continue;
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
 * Every binary comes from the installed package's own manifest, so nothing here
 * is a guess about which tool owns which command. What is not installed has no
 * declared binaries to read, and a package whose binaries are unknown is never
 * called unused — see `unusedIsProvable`.
 */
function collectScriptUse(manifest: Manifest, data: Record<string, unknown>, context: DependencyContext): void {
  const scripts = scriptsOf(data);
  if (scripts.length === 0) return;

  const owner = new Map<string, string>();
  for (const name of manifest.listed) {
    owner.set(name, name);
    for (const binary of declaredBinaries(manifest.dir, name, context)) owner.set(binary, name);
  }

  for (const { command } of scripts) {
    for (const token of commandTokens(command)) {
      const name = owner.get(token);
      if (name) manifest.usedByScript.add(name);
    }
  }
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
  if (/^[./#]/.test(specifier) || specifier.startsWith('node:')) return undefined;
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
