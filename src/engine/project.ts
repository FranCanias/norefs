import path from 'node:path';
import type { ResolutionHostFactory } from 'ts-morph';
import { Project, ts } from 'ts-morph';

export interface PackageConfig {
  /** Directory of the tsconfig; it owns every file underneath it. */
  dir: string;
  options: ts.CompilerOptions;
}

/**
 * Parse the compiler options of each tsconfig, sorted deepest directory
 * first so the nearest tsconfig wins when packages nest.
 */
export function loadPackages(tsConfigFilePaths: string[]): PackageConfig[] {
  return tsConfigFilePaths
    .map(filePath => {
      const resolved = path.resolve(filePath);
      return { dir: path.dirname(resolved), options: readCompilerOptions(resolved) };
    })
    .sort((a, b) => b.dir.length - a.dir.length);
}

/** The options of the package owning this directory, if any package does. */
export function optionsForDir(packages: PackageConfig[], dir: string): ts.CompilerOptions | undefined {
  return packages.find(pkg => dir === pkg.dir || dir.startsWith(`${pkg.dir}/`))?.options;
}

/** Every `paths` alias pattern in play; specifiers matching one name project code, not packages. */
export function pathAliasPatterns(packages: PackageConfig[], fallback: ts.CompilerOptions): string[] {
  const patterns = new Set<string>();
  for (const options of [fallback, ...packages.map(pkg => pkg.options)]) {
    for (const pattern of Object.keys(options.paths ?? {})) patterns.add(pattern);
  }
  return [...patterns];
}

/**
 * Load one project from one or more tsconfigs. The first tsconfig provides
 * the program-level options; each file resolves its imports with the options
 * of the tsconfig that owns it, so per-package `paths` aliases work. One
 * program (rather than one per package) keeps cross-package reference search
 * intact.
 */
export function loadProject(tsConfigFilePaths: string[]): Project {
  const [first, ...rest] = tsConfigFilePaths;
  const project = new Project({
    tsConfigFilePath: first,
    skipFileDependencyResolution: true,
    resolutionHost: rest.length > 0 ? perPackageResolution(loadPackages(tsConfigFilePaths)) : undefined,
  });
  for (const tsConfigFilePath of rest) {
    project.addSourceFilesFromTsConfig(tsConfigFilePath);
  }
  return project;
}

function perPackageResolution(packages: PackageConfig[]): ResolutionHostFactory {
  return (moduleResolutionHost, getCompilerOptions) => ({
    resolveModuleNames: (moduleNames, containingFile) => {
      const options = optionsForDir(packages, path.dirname(containingFile)) ?? getCompilerOptions();
      return moduleNames.map(
        moduleName => ts.resolveModuleName(moduleName, containingFile, options, moduleResolutionHost).resolvedModule
      );
    },
  });
}

function readCompilerOptions(tsConfigFilePath: string): ts.CompilerOptions {
  const { config, error } = ts.readConfigFile(tsConfigFilePath, ts.sys.readFile);
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  const dir = path.dirname(tsConfigFilePath);
  return ts.parseJsonConfigFileContent(config, ts.sys, dir, undefined, tsConfigFilePath).options;
}
