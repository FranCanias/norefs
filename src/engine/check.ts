import type { PropertyNamedNode } from 'ts-morph';
import { referenceIndex } from './reference-index';
import { findReferencesAsNodes } from './references';

export function isUnused(member: PropertyNamedNode): boolean {
  const nameNode = member.getNameNode();
  if (findReferencesAsNodes(nameNode).length > 0) return false;
  // Zero references still leaves a member that answers a base type's
  // declaration, which has to stay for the owner to keep compiling.
  return !referenceIndex(nameNode.getProject()).isRequiredByBaseType(nameNode);
}
