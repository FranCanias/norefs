import type { Project, SourceFile } from 'ts-morph';
import type { Candidate } from './candidate';
import { collectInterfaceCandidates } from './interfaces';
import { collectReturnedObjectCandidates } from './returned-objects';
import { collectTypeLiteralCandidates } from './type-literals';

export type { Candidate } from './candidate';

const collectors: Array<(sourceFile: SourceFile) => Candidate[]> = [
  collectInterfaceCandidates,
  collectTypeLiteralCandidates,
  collectReturnedObjectCandidates,
];

export interface CollectOptions {
  /** Only collect candidates from files under this absolute path prefix. Reference resolution still uses the whole project. */
  scopeDir?: string;
}

export function collectCandidates(project: Project, options: CollectOptions = {}): Candidate[] {
  const candidates: Candidate[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    if (sourceFile.isDeclarationFile()) continue;
    if (options.scopeDir && !sourceFile.getFilePath().startsWith(options.scopeDir)) continue;
    for (const collector of collectors) {
      candidates.push(...collector(sourceFile));
    }
  }
  return candidates;
}
