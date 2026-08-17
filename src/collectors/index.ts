import type { Project, SourceFile } from 'ts-morph';
import type { Candidate, CollectContext } from './candidate';
import { collectClassCandidates } from './classes';
import { collectConstObjectCandidates } from './const-objects';
import { buildConstraintIndex } from './constraints';
import { buildDynamicConsumptionIndex } from './dynamic-index';
import { collectEnumCandidates } from './enums';
import { collectInterfaceCandidates } from './interfaces';
import { collectReturnedObjectCandidates } from './returned-objects';
import { collectTypeLiteralCandidates } from './type-literals';

export type { Candidate, CollectContext } from './candidate';

const collectors: Array<(sourceFile: SourceFile, ctx: CollectContext) => Candidate[]> = [
  collectInterfaceCandidates,
  collectTypeLiteralCandidates,
  collectReturnedObjectCandidates,
  collectEnumCandidates,
  collectConstObjectCandidates,
  collectClassCandidates,
];

interface CollectOptions {
  /** Only collect candidates from files under this absolute path prefix. Reference resolution still uses the whole project. */
  scopeDir?: string;
}

export function collectCandidates(project: Project, options: CollectOptions = {}): Candidate[] {
  const ctx: CollectContext = {
    dynamic: buildDynamicConsumptionIndex(project),
    constrained: buildConstraintIndex(project),
    keyofTargeted: new Map(),
    classEscapes: new Map(),
  };
  const candidates: Candidate[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    if (sourceFile.isDeclarationFile()) continue;
    if (options.scopeDir && !sourceFile.getFilePath().startsWith(options.scopeDir)) continue;
    for (const collector of collectors) {
      candidates.push(...collector(sourceFile, ctx));
    }
  }
  return candidates;
}
