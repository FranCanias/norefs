import type { Node, PropertyNamedNode } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';

export interface Candidate {
  member: PropertyNamedNode & Node;
  context: string;
  anonymous: boolean;
}

export function toCandidate(
  member: Node,
  context: string,
  anonymous: boolean,
  probedNames?: Set<string>
): Candidate | undefined {
  if (!member.isKind(SyntaxKind.PropertySignature) && !member.isKind(SyntaxKind.MethodSignature)) {
    if (
      !member.isKind(SyntaxKind.PropertyAssignment) &&
      !member.isKind(SyntaxKind.MethodDeclaration) &&
      !member.isKind(SyntaxKind.GetAccessor) &&
      !member.isKind(SyntaxKind.SetAccessor) &&
      !member.isKind(SyntaxKind.PropertyDeclaration) &&
      !member.isKind(SyntaxKind.EnumMember)
    ) {
      return undefined;
    }
  }
  const named = member as unknown as PropertyNamedNode & Node;
  const nameNode = named.getNameNode();
  if (nameNode.getKind() === SyntaxKind.ComputedPropertyName) return undefined;
  const key = nameNode.isKind(SyntaxKind.StringLiteral) ? nameNode.getLiteralValue() : nameNode.getText();
  if (probedNames?.has(key)) return undefined;
  return { member: named, context, anonymous };
}
