import { Project } from 'ts-morph';

export function loadProject(tsConfigFilePath: string): Project {
  return new Project({
    tsConfigFilePath,
    skipFileDependencyResolution: true,
  });
}
