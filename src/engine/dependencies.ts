import { builtinModules } from 'node:module';
import path from 'node:path';
import { minimatch } from 'minimatch';
import type { Finding } from '../types';
import { isHarnessFile } from './reachability';
import { commandTokens, scriptsOf } from './scripts';

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
    scopeDir?: string;
    /** Dependency names or globs never reported. */
    ignore: string[];
    /** tsconfig `paths` patterns: an alias into project code, never a package. */
    aliasPatterns: string[];
    /**
     * The shipping code path alone. A harness file is absent, so what it
     * imports is not usage — and devDependencies, which exist to build and
     * test, are outside the question this run is asking.
     */
    production?: boolean;
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
  // consumed by packages this scan cannot see, so they are never reported.
  for (const dir of rootDirs) {
    for (let parent = path.dirname(dir); parent !== path.dirname(parent); parent = path.dirname(parent)) {
      const manifest = readManifest(context, parent);
      if (manifest) for (const name of manifest.listed) listedAnywhere.add(name);
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

  for (const manifest of manifests) {
    const sections = production ? (['dependencies'] as const) : (['dependencies', 'devDependencies'] as const);
    for (const section of sections) {
      for (const name of manifest[section]) {
        // @types packages are consumed by the compiler, which no import shows.
        if (name.startsWith('@types/') || isIgnored(name, ignore)) continue;
        const at = manifestPosition(manifest.text, section, name);
        const place = (finding: Omit<Finding, 'filePath' | 'line' | 'column' | 'name' | 'context' | 'anonymous'>) =>
          findings.push({ ...finding, filePath: manifest.filePath, ...at, name, context: section, anonymous: false });

        const imported = manifest.used.has(name);
        if (!imported && !manifest.usedByScript.has(name)) {
          if (!unusedIsProvable(manifest, name, section, context)) continue;
          place({
            kind: 'dependency',
            verdict: 'dead',
            // A production run never looked at the harness, so it cannot say
            // the whole source tree is silent — only the half it read.
            evidence: production
              ? 'no file on the shipping path imports it and no script runs it'
              : 'no source file imports it and no script runs it',
          });
          continue;
        }

        // Which section a package sits in is a claim about when it is needed.
        // Getting it wrong one way ships a broken install; the other way ships
        // weight nobody uses. A production run cannot say: it never looked at
        // the half of the code that would decide it.
        if (production) continue;
        // Only a runtime import breaks the install. `import type` is erased, so
        // a devDependency the shipped code reads for types alone is where it
        // belongs — and moving it would ship weight the output never loads.
        if (section === 'devDependencies' && manifest.neededAtRuntime.has(name)) {
          place({
            kind: 'misplaced',
            evidence: 'production code imports it, so an install without dev dependencies is missing it',
          });
        } else if (section === 'dependencies' && imported && !manifest.usedInProduction.has(name)) {
          place({
            kind: 'misplaced',
            evidence: 'only test, spec, story, bench, and config files import it, so it ships for nothing',
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
  return section === 'dependencies' || installedManifest(manifest.dir, name, context) !== undefined;
}

function readManifest(context: DependencyContext, dir: string): Manifest | undefined {
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
  const sections = data as Record<string, unknown>;
  const names = (key: string): string[] => {
    const section = sections[key];
    return typeof section === 'object' && section !== null ? Object.keys(section) : [];
  };
  const listed = new Set([
    ...names('dependencies'),
    ...names('devDependencies'),
    ...names('peerDependencies'),
    ...names('optionalDependencies'),
  ]);
  const manifest: Manifest = {
    filePath,
    dir,
    text,
    dependencies: names('dependencies'),
    devDependencies: names('devDependencies'),
    listed,
    used: new Set(),
    usedInProduction: new Set(),
    neededAtRuntime: new Set(),
    usedByScript: new Set(),
  };
  collectScriptUse(manifest, sections, context);
  return manifest;
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
  const data = installedManifest(fromDir, name, context);
  if (data === undefined) return [];
  const bin = (data as { bin?: unknown }).bin;
  // A string `bin` is published under the package's own unscoped name.
  if (typeof bin === 'string') return [name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name];
  if (typeof bin === 'object' && bin !== null) return Object.keys(bin);
  return [];
}

/** An installed package's own manifest, or nothing when it is not installed. */
function installedManifest(fromDir: string, name: string, context: DependencyContext): unknown {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const filePath = path.join(dir, 'node_modules', name, 'package.json');
    // readFile throws on a path that is not there; fileExists is the guard
    // every other reader in this file uses.
    const text = context.fileExists(filePath) ? context.readFile(filePath) : undefined;
    if (text !== undefined) {
      try {
        return JSON.parse(text);
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

/**
 * Bundler-only query suffixes like Vite's `?react`, `?raw`, `?worker` are not
 * part of the module name and break resolution when left on.
 */
export function stripQuerySuffix(specifier: string): string {
  const query = specifier.indexOf('?');
  return query === -1 ? specifier : specifier.slice(0, query);
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
    if (parts[0].length < 2 || !parts[1]) return undefined;
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
  if (index === -1) return { line: 1, column: 1 };
  return { line: index + 1, column: lines[index].indexOf(`"${name}"`) + 1 };
}
