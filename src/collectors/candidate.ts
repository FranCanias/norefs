import type { Node, PropertyNamedNode } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import type { ConstraintIndex } from './constraints';
import type { DynamicConsumptionIndex } from './dynamic-index';

/** What every collector reads: the project-wide indexes, and the caches they share. */
export interface CollectContext {
  dynamic: DynamicConsumptionIndex;
  /** Member names each declaration must keep to satisfy declared assignability constraints. */
  constrained: ConstraintIndex;
  /** Cache for isKeyofTargeted, which costs a find-references call per declaration. */
  keyofTargeted: Map<Node, boolean>;
  /** Cache for classEscapesTracking, which recurses into derived classes. */
  classEscapes: Map<Node, boolean>;
}

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
      // `{ outside }` is a property named `outside`, written the short way.
      !member.isKind(SyntaxKind.ShorthandPropertyAssignment) &&
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
