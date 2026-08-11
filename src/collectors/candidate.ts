import type { Node, PropertyNamedNode } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';

export interface Candidate {
  member: PropertyNamedNode & Node;
  context: string;
  anonymous: boolean;
}

export function toCandidate(member: Node, context: string, anonymous: boolean): Candidate | undefined {
  if (!member.isKind(SyntaxKind.PropertySignature) && !member.isKind(SyntaxKind.MethodSignature)) {
    if (
      !member.isKind(SyntaxKind.PropertyAssignment) &&
      !member.isKind(SyntaxKind.MethodDeclaration) &&
      !member.isKind(SyntaxKind.GetAccessor) &&
      !member.isKind(SyntaxKind.SetAccessor)
    ) {
      return undefined;
    }
  }
  const named = member as unknown as PropertyNamedNode & Node;
  if (named.getNameNode().getKind() === SyntaxKind.ComputedPropertyName) return undefined;
  return { member: named, context, anonymous };
}
