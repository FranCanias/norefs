import type { Identifier } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import { findReferencesAsNodes } from '../lookup/references';

/**
 * True when `keyof T` or `keyof typeof T` appears anywhere for this name. That
 * is the code's own signal that T's keys are enumerated or indexed dynamically,
 * so per-member reference counts can't be trusted and the whole declaration
 * must stay silent.
 */
export function isKeyofTargeted(nameNode: Identifier): boolean {
  for (const ref of findReferencesAsNodes(nameNode)) {
    const wrapper = ref.getParentIfKind(SyntaxKind.TypeReference) ?? ref.getParentIfKind(SyntaxKind.TypeQuery);
    const operator = wrapper?.getParentIfKind(SyntaxKind.TypeOperator);
    if (operator?.getOperator() === SyntaxKind.KeyOfKeyword) return true;
  }
  return false;
}
