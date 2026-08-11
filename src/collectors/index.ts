import type { Node, Project, SourceFile } from 'ts-morph';
import type { Candidate } from './candidate';
import type { DynamicConsumptionIndex } from './dynamic-index';
import { buildDynamicConsumptionIndex } from './dynamic-index';
import { collectInterfaceCandidates } from './interfaces';
import { collectReturnedObjectCandidates } from './returned-objects';
import { collectTypeLiteralCandidates } from './type-literals';

export type { Candidate } from './candidate';

export interface CollectContext {
  dynamic: DynamicConsumptionIndex;
  /** Cache for isKeyofTargeted, which costs a find-references call per declaration. */
  keyofTargeted: Map<Node, boolean>;
}

const collectors: Array<(sourceFile: SourceFile, ctx: CollectContext) => Candidate[]> = [
  collectInterfaceCandidates,
  collectTypeLiteralCandidates,
  collectReturnedObjectCandidates,
];

export interface CollectOptions {
  /** Only collect candidates from files under this absolute path prefix. Reference resolution still uses the whole project. */
  scopeDir?: string;
}

export function collectCandidates(project: Project, options: CollectOptions = {}): Candidate[] {
  const ctx: CollectContext = { dynamic: buildDynamicConsumptionIndex(project), keyofTargeted: new Map() };
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
