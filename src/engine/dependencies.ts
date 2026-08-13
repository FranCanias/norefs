import { builtinModules } from 'node:module';
import path from 'node:path';
import { minimatch } from 'minimatch';
import type { Finding } from '../types';

const BUILTINS = new Set(builtinModules);

/** An import that names a package rather than project code. */
export interface DependencyUse {
  filePath: string;
  /** The specifier as written: "react", "lodash/fp". */
  text: string;
  /** Offset of the literal, for the finding's position and its suppression check. */
  start: number;
}

/** What the checks need to read the manifests and place a finding. */
export interface DependencyContext {
  fileExists(filePath: string): boolean;
  readFile(filePath: string): string | undefined;
  isSuppressedAt(filePath: string, offset: number): boolean;
  positionAt(filePath: string, offset: number): { line: number; column: number };
}

interface Manifest {
  filePath: string;
  dir: string;
  text: string;
  /** Names in "dependencies" — the only section reported when unused. */
  dependencies: string[];
  /** Names in every dependency section; imports of these are never unlisted. */
  listed: Set<string>;
  used: Set<string>;
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
  scopeDir: string | undefined,
  ignore: string[],
  aliasPatterns: string[],
  context: DependencyContext
): Finding[] {
  const manifests: Manifest[] = [];
  for (const dir of rootDirs) {
    const manifest = readManifest(context, dir);
    if (manifest) manifests.push(manifest);
  }
  if (manifests.length === 0) return [];

  const listedAnywhere = new Set(manifests.flatMap(m => [...m.listed]));
  const findings: Finding[] = [];
  const reportedUnlisted = new Set<string>();

  for (const use of uses) {
    const specifier = stripQuerySuffix(use.text);
    if (matchesAlias(specifier, aliasPatterns)) continue;
    const name = packageName(specifier);
    if (!name) continue;
    for (const owner of owningManifests(use.filePath, manifests)) owner.used.add(name);

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
    for (const name of manifest.dependencies) {
      if (name.startsWith('@types/') || isIgnored(name, ignore) || manifest.used.has(name)) continue;
      const { line, column } = manifestPosition(manifest.text, name);
      findings.push({
        kind: 'dependency',
        filePath: manifest.filePath,
        line,
        column,
        name,
        context: '',
        anonymous: false,
        verdict: 'dead',
      });
    }
  }
  return findings;
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
  return { filePath, dir, text, dependencies: names('dependencies'), listed, used: new Set() };
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

function manifestPosition(text: string, name: string): { line: number; column: number } {
  const lines = text.split('\n');
  const index = lines.findIndex(line => line.includes(`"${name}"`));
  if (index === -1) return { line: 1, column: 1 };
  return { line: index + 1, column: lines[index].indexOf(`"${name}"`) + 1 };
}
