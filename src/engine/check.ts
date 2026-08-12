import type { PropertyNamedNode } from 'ts-morph';
import { findReferencesAsNodes } from './references';

export function isUnused(member: PropertyNamedNode): boolean {
  return findReferencesAsNodes(member.getNameNode()).length === 0;
}
