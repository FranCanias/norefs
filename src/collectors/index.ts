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

export function collectCandidates(project: Project): Candidate[] {
  const candidates: Candidate[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    if (sourceFile.isDeclarationFile()) continue;
    for (const collector of collectors) {
      candidates.push(...collector(sourceFile));
    }
  }
  return candidates;
}
