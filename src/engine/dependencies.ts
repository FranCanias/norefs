import { builtinModules } from 'node:module';
import path from 'node:path';
import { minimatch } from 'minimatch';
import type { Project, SourceFile, StringLiteral } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import type { Finding } from '../types';
import { isNodeSuppressed } from './suppress';

const BUILTINS = new Set(builtinModules);

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
 */
export function analyzeDependencies(
  project: Project,
  rootDirs: string[],
  scopeDir: string | undefined,
  ignore: string[]
): Finding[] {
  const manifests: Manifest[] = [];
  for (const dir of rootDirs) {
    const manifest = readManifest(project, dir);
    if (manifest) manifests.push(manifest);
  }
  if (manifests.length === 0) return [];

  const listedAnywhere = new Set(manifests.flatMap(m => [...m.listed]));
  const findings: Finding[] = [];
  const reportedUnlisted = new Set<string>();

  for (const sourceFile of project.getSourceFiles()) {
    if (sourceFile.isDeclarationFile()) continue;
    const owners = owningManifests(sourceFile, manifests);
    for (const specifier of moduleSpecifiers(sourceFile)) {
      const name = packageName(specifier.getLiteralText());
      if (!name) continue;
      for (const owner of owners) owner.used.add(name);

      if (listedAnywhere.has(name) || listedAnywhere.has(typesPackage(name))) continue;
      if (reportedUnlisted.has(name) || isIgnored(name, ignore)) continue;
      if (scopeDir && !sourceFile.getFilePath().startsWith(scopeDir)) continue;
      if (isNodeSuppressed(specifier)) continue;
      reportedUnlisted.add(name);
      const { line, column } = sourceFile.getLineAndColumnAtPos(specifier.getStart());
      findings.push({
        kind: 'unlisted',
        filePath: sourceFile.getFilePath(),
        line,
        column,
        name,
        context: '',
        anonymous: false,
      });
    }
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
      });
    }
  }
  return findings;
}

function readManifest(project: Project, dir: string): Manifest | undefined {
  const fileSystem = project.getFileSystem();
  const filePath = path.join(dir, 'package.json');
  if (!fileSystem.fileExistsSync(filePath)) return undefined;
  const text = fileSystem.readFileSync(filePath);
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
function owningManifests(sourceFile: SourceFile, manifests: Manifest[]): Manifest[] {
  const filePath = sourceFile.getFilePath();
  const owners = manifests.filter(m => filePath.startsWith(`${m.dir}/`) || filePath.startsWith(`${m.dir}${path.sep}`));
  return owners.length > 0 ? owners : manifests;
}

/**
 * Module specifier literals that point outside the project. A specifier that
 * resolves to a project source file is a relative import or a path alias, not
 * a package.
 */
function moduleSpecifiers(sourceFile: SourceFile): StringLiteral[] {
  return sourceFile.getImportStringLiterals().filter(literal => {
    const resolved = specifierTarget(literal);
    return !resolved || resolved.isInNodeModules();
  });
}

function specifierTarget(literal: StringLiteral): SourceFile | undefined {
  const parent = literal.getParent();
  if (parent?.isKind(SyntaxKind.ImportDeclaration)) return parent.getModuleSpecifierSourceFile();
  if (parent?.isKind(SyntaxKind.ExportDeclaration)) return parent.getModuleSpecifierSourceFile();
  return undefined;
}

function packageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return undefined;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
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
