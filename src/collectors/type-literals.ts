import type { Node, ParameterDeclaration, SourceFile, TypeLiteralNode } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import { describeTypeLiteralContext } from '../engine/describe';
import type { Candidate } from './candidate';
import { toCandidate } from './candidate';
import { isKeyofTargeted } from './dynamic-usage';
import { callableEscapes, getCallableNameNode, propertyValueStaysLocal, valueUsesStayLocal } from './escape';
import type { CollectContext } from './index';

export function collectTypeLiteralCandidates(sourceFile: SourceFile, ctx: CollectContext): Candidate[] {
  const candidates: Candidate[] = [];
  for (const typeLiteral of sourceFile.getDescendantsOfKind(SyntaxKind.TypeLiteral)) {
    if (isGenericConstraint(typeLiteral)) continue;
    if (isUnderDynamicallyConsumedType(typeLiteral, ctx)) continue;

    const { owner, topTypeNode } = climbToOwner(typeLiteral);
    if (!owner?.isKind(SyntaxKind.TypeAliasDeclaration) && owner && bindingEscapesTracking(owner, topTypeNode)) {
      continue;
    }

    const probed = ctx.dynamic.probed.get(typeLiteral);
    const { label, anonymous } = describeTypeLiteralContext(typeLiteral);
    for (const member of typeLiteral.getMembers()) {
      const candidate = toCandidate(member, label, anonymous, probed);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

function isGenericConstraint(node: Node): boolean {
  return node.getFirstAncestor(a => a.isKind(SyntaxKind.TypeParameter)) !== undefined;
}

/**
 * True when this literal, or any type declaration it is nested inside, has its
 * keys consumed dynamically. Suppression must cascade: `keyof T` or
 * `JSON.stringify(v)` hands out nested values wholesale, so members of the
 * nested literals are just as untrackable as T's own.
 */
function isUnderDynamicallyConsumedType(typeLiteral: TypeLiteralNode, ctx: CollectContext): boolean {
  let node: Node | undefined = typeLiteral;
  while (node) {
    if (ctx.dynamic.suppressed.has(node)) return true;
    if (node.isKind(SyntaxKind.TypeAliasDeclaration) || node.isKind(SyntaxKind.InterfaceDeclaration)) {
      let targeted = ctx.keyofTargeted.get(node);
      if (targeted === undefined) {
        targeted = isKeyofTargeted(node.getNameNode());
        ctx.keyofTargeted.set(node, targeted);
      }
      if (targeted) return true;
    }
    node = node.getParent();
  }
  return false;
}

const TYPE_WRAPPER_KINDS = new Set<SyntaxKind>([
  SyntaxKind.TypeReference,
  SyntaxKind.ArrayType,
  SyntaxKind.TupleType,
  SyntaxKind.NamedTupleMember,
  SyntaxKind.OptionalType,
  SyntaxKind.RestType,
  SyntaxKind.UnionType,
  SyntaxKind.IntersectionType,
  SyntaxKind.ParenthesizedType,
  SyntaxKind.TypeOperator,
  SyntaxKind.IndexedAccessType,
  SyntaxKind.MappedType,
]);

/** Walk out of wrapping type nodes (Array<…>, unions, …) to the declaration that owns this literal. */
function climbToOwner(typeLiteral: TypeLiteralNode): { owner: Node | undefined; topTypeNode: Node } {
  let topTypeNode: Node = typeLiteral;
  let parent = topTypeNode.getParent();
  while (parent && TYPE_WRAPPER_KINDS.has(parent.getKind())) {
    topTypeNode = parent;
    parent = parent.getParent();
  }
  return { owner: parent, topTypeNode };
}

/**
 * True when the value this literal types can't be tracked property-by-property:
 * a whole-binding parameter or variable that escapes local view, a parameter of
 * a function type (implementations declare their own bindings), a return type
 * on a function whose result escapes, or the type of a property whose value
 * flows onward as a whole.
 */
function bindingEscapesTracking(owner: Node, topTypeNode: Node): boolean {
  if (owner.isKind(SyntaxKind.Parameter)) {
    if (isTypePositionParameter(owner)) return true;
    const name = owner.getNameNode();
    return name.isKind(SyntaxKind.Identifier) && !valueUsesStayLocal(name);
  }

  if (owner.isKind(SyntaxKind.VariableDeclaration)) {
    const name = owner.getNameNode();
    return name.isKind(SyntaxKind.Identifier) && !valueUsesStayLocal(name);
  }

  if (
    (owner.isKind(SyntaxKind.FunctionDeclaration) ||
      owner.isKind(SyntaxKind.ArrowFunction) ||
      owner.isKind(SyntaxKind.FunctionExpression) ||
      owner.isKind(SyntaxKind.MethodDeclaration)) &&
    owner.getReturnTypeNode() === topTypeNode
  ) {
    const name = getCallableNameNode(owner);
    return !name || callableEscapes(name);
  }

  if (owner.isKind(SyntaxKind.PropertySignature) || owner.isKind(SyntaxKind.PropertyDeclaration)) {
    return !propertyValueStaysLocal(owner);
  }

  return false;
}

function isTypePositionParameter(param: ParameterDeclaration): boolean {
  const holder = param.getParent();
  if (
    holder.isKind(SyntaxKind.FunctionType) ||
    holder.isKind(SyntaxKind.ConstructorType) ||
    holder.isKind(SyntaxKind.MethodSignature) ||
    holder.isKind(SyntaxKind.CallSignature) ||
    holder.isKind(SyntaxKind.ConstructSignature)
  ) {
    return true;
  }
  if (holder.isKind(SyntaxKind.FunctionDeclaration) || holder.isKind(SyntaxKind.MethodDeclaration)) {
    return holder.getBody() == null;
  }
  return false;
}
