import type { Identifier } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';

/**
 * True when `keyof T` appears anywhere for this type name. That is the code's
 * own signal that T's keys are enumerated or indexed dynamically, so per-member
 * reference counts can't be trusted and the whole type must stay silent.
 */
export function isKeyofTargeted(nameNode: Identifier): boolean {
  for (const ref of nameNode.findReferencesAsNodes()) {
    const typeRef = ref.getParentIfKind(SyntaxKind.TypeReference);
    const operator = typeRef?.getParentIfKind(SyntaxKind.TypeOperator);
    if (operator?.getOperator() === SyntaxKind.KeyOfKeyword) return true;
  }
  return false;
}
