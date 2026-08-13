import type { PropertyNamedNode, SourceFile } from 'ts-morph';
import { referenceIndex } from './reference-index';
import { findReferencesAsNodes } from './references';

type MemberUsage = 'used' | 'unused' | 'test-only';

/**
 * How a member is consumed. `test-only` means every reference sits in a
 * harness file: production code never touches it, tests keep it alive. A
 * member answering a base type's declaration is `used` whatever its count —
 * remove it and the owner stops compiling.
 */
export function memberUsage(member: PropertyNamedNode, isHarness: (sourceFile: SourceFile) => boolean): MemberUsage {
  const nameNode = member.getNameNode();
  const references = findReferencesAsNodes(nameNode);
  if (references.length > 0) {
    if (references.some(ref => !isHarness(ref.getSourceFile()))) return 'used';
    return referenceIndex(nameNode.getProject()).isRequiredByBaseType(nameNode) ? 'used' : 'test-only';
  }
  return referenceIndex(nameNode.getProject()).isRequiredByBaseType(nameNode) ? 'used' : 'unused';
}
