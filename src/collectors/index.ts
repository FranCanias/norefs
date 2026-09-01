import type { Node, Project, SourceFile } from 'ts-morph';
import { isOwnDeclarationFile } from '../lookup/files';
import type { Candidate, CollectContext } from './candidate';
import { collectClassCandidates } from './classes';
import { collectConstObjectCandidates } from './const-objects';
import { buildConstraintIndex } from './constraints';
import { buildDynamicConsumptionIndex } from './dynamic-index';
import { isKeyofTargeted } from './dynamic-usage';
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
  scopeDir?: string | undefined;
}

export function collectCandidates(project: Project, options: CollectOptions = {}): Candidate[] {
  const keyofTargeted = new Map<Node, boolean>();
  const ctx: CollectContext = {
    dynamic: buildDynamicConsumptionIndex(project),
    constrained: buildConstraintIndex(project),
    isKeyofTargeted: (declaration, nameNode) => {
      let targeted = keyofTargeted.get(declaration);
      if (targeted === undefined) {
        targeted = isKeyofTargeted(nameNode);
        keyofTargeted.set(declaration, targeted);
      }
      return targeted;
    },
    classEscapes: new Map(),
  };
  const candidates: Candidate[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    // A package's own `.d.ts` describes code this project did not write. The
    // project's own describes the project, and its members answer for
    // themselves like any others.
    if (sourceFile.isDeclarationFile() && !isOwnDeclarationFile(sourceFile)) continue;
    if (options.scopeDir && !sourceFile.getFilePath().startsWith(options.scopeDir)) continue;
    for (const collector of collectors) {
      candidates.push(...collector(sourceFile, ctx));
    }
  }
  return candidates;
}
