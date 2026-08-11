import type { PropertyNamedNode } from 'ts-morph';

export function isUnused(member: PropertyNamedNode): boolean {
  return member.findReferencesAsNodes().length === 0;
}
