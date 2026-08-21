import type { Node, ObjectLiteralElementLike, ObjectLiteralExpression } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import type { Candidate, CollectContext } from './candidate';
import { toCandidate } from './candidate';
import { mergeNames } from './constraints';
import { propertyReadsStayLocal } from './escape';

/**
 * The members of an object literal, and of every literal nested inside it that
 * the reads let the analysis reach.
 *
 * A nested literal is a shape of its own and its members die on their own
 * terms — but only where the property holding it is read, and every read keeps
 * the value local. `cfg.outer` handed to anything else takes the whole inner
 * shape with it, and a member of that shape can then be consumed with no
 * reference to show for it. So the descent stops at the first property that
 * lets its value out, and everything under that property stays silent.
 *
 * `label` names the literal at each depth: the empty path is the literal
 * itself, `['outer']` the one a property in. `answered` names the top-level
 * members some other literal of the same value already accounts for.
 */
export function collectLiteralMembers(
  literal: ObjectLiteralExpression,
  ctx: CollectContext,
  anonymous: boolean,
  label: (path: string[]) => string,
  answered?: Set<string>
): Candidate[] {
  const candidates: Candidate[] = [];

  const walk = (current: ObjectLiteralExpression, path: string[]): void => {
    const probed = ctx.dynamic.probed.get(current);
    // Only this literal's own members have a sibling shape to answer for them.
    // A literal nested inside is reached through a property that is read here,
    // which is this shape and no other.
    const skip = path.length === 0 ? mergeNames(probed, answered) : probed;
    const context = label(path);
    for (const property of current.getProperties()) {
      const candidate = toCandidate(property, context, anonymous, skip);
      if (candidate) candidates.push(candidate);
      const nested = trackableNestedLiteral(property, ctx);
      if (nested) walk(nested.literal, [...path, nested.name]);
    }
  };

  walk(literal, []);
  return candidates;
}

/**
 * The literal this expression puts in charge of its own shape: the literal
 * itself, or one behind an `as const`. `as Config` and `satisfies Config` hand
 * the shape to a named type, and that type is what the type collectors report.
 */
export function selfShapedLiteral(node: Node | undefined): ObjectLiteralExpression | undefined {
  if (!node) return undefined;
  if (node.isKind(SyntaxKind.ParenthesizedExpression)) return selfShapedLiteral(node.getExpression());
  if (node.isKind(SyntaxKind.AsExpression)) {
    return node.getTypeNode()?.getText() === 'const' ? selfShapedLiteral(node.getExpression()) : undefined;
  }
  return node.isKind(SyntaxKind.ObjectLiteralExpression) ? node : undefined;
}

/** The nested literal a property holds, when its members can be counted, and the name to reach it by. */
function trackableNestedLiteral(
  property: Node,
  ctx: CollectContext
): { name: string; literal: ObjectLiteralExpression } | undefined {
  if (!property.isKind(SyntaxKind.PropertyAssignment)) return undefined;
  const name = writtenKey(property.getNameNode());
  if (name === undefined) return undefined;

  const literal = selfShapedLiteral(property.getInitializer());
  if (!literal) return undefined;
  // Cheapest first: a literal already known to hand out its keys wholesale
  // costs nothing to skip, where the read check costs a reference query.
  if (ctx.dynamic.suppressed.has(literal)) return undefined;

  return propertyReadsStayLocal(property) ? { name, literal } : undefined;
}

/**
 * The key a property writes down, with the node that writes it. A spread names
 * nothing, and neither does a key the source computes.
 */
export function writtenProperty(property: ObjectLiteralElementLike): { key: string; nameNode: Node } | undefined {
  if (property.isKind(SyntaxKind.SpreadAssignment)) return undefined;
  const nameNode = property.getNameNode();
  const key = writtenKey(nameNode);
  return key === undefined ? undefined : { key, nameNode };
}

/** The key as the source writes it, for a name a reader can follow back. A computed key has none. */
function writtenKey(nameNode: Node): string | undefined {
  if (nameNode.isKind(SyntaxKind.Identifier)) return nameNode.getText();
  if (nameNode.isKind(SyntaxKind.StringLiteral)) return nameNode.getLiteralValue();
  return undefined;
}
