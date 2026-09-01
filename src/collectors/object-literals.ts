import type {
  ArrayLiteralExpression,
  Node,
  ObjectLiteralElementLike,
  ObjectLiteralExpression,
  PropertyAssignment,
  VariableDeclaration,
} from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import { findReferencesAsNodes } from '../lookup/references';
import type { Candidate, CollectContext } from './candidate';
import { toCandidate } from './candidate';
import { mergeNames } from './constraints';
import { ARRAY_RULES, propertyReadsStayLocal } from './escape';

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
 * A property can hold several shapes at once — an array of literals is one
 * shape per element — and they answer together. The checker keeps one
 * declaration per name across identical shapes, so a name some sibling holds a
 * read on is alive on all of them.
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

  // `siblings` names what the shapes beside this one already answer for. Only
  // a shape that has siblings has any: a literal reached through a property of
  // its own is this shape and no other.
  const walk = (current: ObjectLiteralExpression, path: string[], siblings: Set<string> | undefined): void => {
    const skip = mergeNames(ctx.dynamic.probed.get(current), siblings);
    const context = label(path);
    for (const property of current.getProperties()) {
      const candidate = toCandidate(property, context, anonymous, skip);
      if (candidate) candidates.push(candidate);
      const nested = trackableNestedLiterals(property, ctx);
      if (!nested) continue;
      const answeredHere = namesReadElsewhere(nested.literals);
      for (const shape of nested.literals) walk(shape, [...path, nested.name], answeredHere);
    }
  };

  walk(literal, [], answered);
  return candidates;
}

/**
 * Names another literal of the same value already answers for.
 *
 * Two branches returning the same shape are one type by the time the checker
 * is done with them, so every read of a shared name lands on the single
 * declaration it kept. The others hold zero references and are alive all the
 * same. A name more than one literal writes is therefore reported only when
 * every one of those declarations is unread, and this is the set where that
 * does not hold.
 *
 * The elements of an array literal are the same story told in one expression.
 */
export function namesReadElsewhere(literals: ObjectLiteralExpression[]): Set<string> | undefined {
  if (literals.length < 2) return undefined;
  const declared = new Map<string, Node[]>();
  for (const literal of literals) {
    for (const property of literal.getProperties()) {
      const written = writtenProperty(property);
      if (!written) continue;
      const nodes = declared.get(written.key);
      if (nodes) nodes.push(written.nameNode);
      else declared.set(written.key, [written.nameNode]);
    }
  }

  const read = new Set<string>();
  for (const [name, nameNodes] of declared) {
    if (nameNodes.length < 2) continue;
    if (nameNodes.some(nameNode => findReferencesAsNodes(nameNode).length > 0)) read.add(name);
  }
  return read.size > 0 ? read : undefined;
}

/**
 * Past the wrappers that leave a literal in charge of its own shape:
 * parentheses and `as const`. `as Config` and `satisfies Config` hand the
 * shape to a named type, and that type is what the type collectors report.
 */
function selfShapedValue(node: Node | undefined): Node | undefined {
  if (!node) return undefined;
  if (node.isKind(SyntaxKind.ParenthesizedExpression)) return selfShapedValue(node.getExpression());
  if (node.isKind(SyntaxKind.AsExpression)) {
    return node.getTypeNode()?.getText() === 'const' ? selfShapedValue(node.getExpression()) : undefined;
  }
  return node;
}

/** The literal this expression puts in charge of its own shape. */
function selfShapedLiteral(node: Node | undefined): ObjectLiteralExpression | undefined {
  const value = selfShapedValue(node);
  return value?.isKind(SyntaxKind.ObjectLiteralExpression) ? value : undefined;
}

/** The same, for an array of them. */
function selfShapedArray(node: Node | undefined): ArrayLiteralExpression | undefined {
  const value = selfShapedValue(node);
  return value?.isKind(SyntaxKind.ArrayLiteralExpression) ? value : undefined;
}

/**
 * The shapes this literal answers alongside, when it is an element of an array
 * literal: one shape per element, the wrappers a value may wear aside.
 */
export function arraySiblingShapes(literal: ObjectLiteralExpression): ObjectLiteralExpression[] {
  let current: Node = literal;
  let parent = current.getParent();
  while (parent?.isKind(SyntaxKind.ParenthesizedExpression) || parent?.isKind(SyntaxKind.AsExpression)) {
    current = parent;
    parent = current.getParent();
  }
  if (!parent?.isKind(SyntaxKind.ArrayLiteralExpression)) return [];
  const shapes: ObjectLiteralExpression[] = [];
  for (const element of parent.getElements()) {
    const shape = selfShapedLiteral(element);
    if (shape) shapes.push(shape);
  }
  return shapes;
}

/**
 * The shapes a property or a binding holds outright: one literal, or the
 * elements of an array of them. Structure only — whether the reads let the
 * analysis inside is a separate question each caller asks its own way.
 */
export function shapesHeldBy(holder: PropertyAssignment | VariableDeclaration): HeldShapes | undefined {
  const initializer = holder.getInitializer();
  const single = selfShapedLiteral(initializer);
  if (single) return { literals: [single], array: false };
  const elements = elementLiterals(initializer);
  return elements ? { literals: elements, array: true } : undefined;
}

interface HeldShapes {
  literals: ObjectLiteralExpression[];
  /** True when they arrive as elements of an array, which is read for its elements. */
  array: boolean;
}

/**
 * The shapes a property holds when their members can be counted, and the name
 * to reach them by.
 */
function trackableNestedLiterals(
  property: Node,
  ctx: CollectContext
): { name: string; literals: ObjectLiteralExpression[] } | undefined {
  if (!property.isKind(SyntaxKind.PropertyAssignment)) return undefined;
  const name = writtenKey(property.getNameNode());
  if (name === undefined) return undefined;

  const held = shapesHeldBy(property);
  if (!held) return undefined;
  // Cheapest first: a literal already known to hand out its keys wholesale
  // costs nothing to skip, where the read check costs a reference query.
  if (held.literals.some(literal => ctx.dynamic.suppressed.has(literal))) return undefined;

  // An array is read for its elements, and an element is the shape in
  // question — so it answers a question of its own about where they go.
  return propertyReadsStayLocal(property, held.array ? ARRAY_RULES : undefined)
    ? { name, literals: held.literals }
    : undefined;
}

/**
 * The object literals an array holds, when every element is one. An element of
 * any other shape puts a value here this check cannot read, and a read could
 * land on it — so the array answers for nothing rather than for some of it.
 */
function elementLiterals(initializer: Node | undefined): ObjectLiteralExpression[] | undefined {
  const array = selfShapedArray(initializer);
  if (!array) return undefined;
  const literals: ObjectLiteralExpression[] = [];
  for (const element of array.getElements()) {
    const literal = selfShapedLiteral(element);
    if (!literal) return undefined;
    literals.push(literal);
  }
  return literals.length > 0 ? literals : undefined;
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
