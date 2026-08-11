import { Project } from 'ts-morph';

/**
 * Load one project from one or more tsconfigs. The first tsconfig provides the
 * compiler options (including path aliases); the rest only contribute their
 * source files, which is how a monorepo scan sees every package at once.
 */
export function loadProject(tsConfigFilePaths: string[]): Project {
  const [first, ...rest] = tsConfigFilePaths;
  const project = new Project({
    tsConfigFilePath: first,
    skipFileDependencyResolution: true,
  });
  for (const tsConfigFilePath of rest) {
    project.addSourceFilesFromTsConfig(tsConfigFilePath);
  }
  return project;
}
