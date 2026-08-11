import type { CallExpression, Identifier, Node, PropertyDeclaration, PropertySignature } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';

/**
 * Conservative escape analysis shared by the collectors. A value "stays local"
 * when every use is a property read, a string-keyed element access, or a
 * destructuring. Anything else — bare argument, shorthand forwarding, aliasing,
 * returning onward — means its properties may be consumed without per-property
 * references, so reference counts can't be trusted.
 */

export function getCallableNameNode(fn: Node): Identifier | undefined {
  if (fn.isKind(SyntaxKind.FunctionDeclaration)) return fn.getNameNode();
  if (fn.isKind(SyntaxKind.MethodDeclaration)) {
    const name = fn.getNameNode();
    return name.isKind(SyntaxKind.Identifier) ? name : undefined;
  }
  const parent = fn.getParent();
  if (parent?.isKind(SyntaxKind.VariableDeclaration)) {
    const name = parent.getNameNode();
    if (name.isKind(SyntaxKind.Identifier)) return name;
  }
  return undefined;
}

/** True when some call result of this function/method leaves local view as a whole. */
export function callableEscapes(nameNode: Identifier): boolean {
  for (const ref of nameNode.findReferencesAsNodes()) {
    const parent = ref.getParent();
    if (!parent) continue;
    if (isAliasDeclarationParent(parent)) continue;

    let callee: Node = ref;
    const propAccess = ref.getParentIfKind(SyntaxKind.PropertyAccessExpression);
    if (propAccess && propAccess.getNameNode() === ref) callee = propAccess;

    const call = callee.getParentIfKind(SyntaxKind.CallExpression);
    if (!call || call.getExpression() !== callee) return true;
    if (!callResultStaysLocal(call)) return true;
  }
  return false;
}

/** True when every use of this binding is a local property read or a boolean test. */
export function valueUsesStayLocal(name: Identifier): boolean {
  for (const ref of name.findReferencesAsNodes()) {
    const use = climbWrappers(ref);
    const parent = use.getParent();
    if (!parent) continue;
    if (parent.isKind(SyntaxKind.PropertyAccessExpression) && parent.getExpression() === use) continue;
    if (isStringKeyedElementAccess(parent, use)) continue;
    if (parent.isKind(SyntaxKind.VariableDeclaration) && !parent.getNameNode().isKind(SyntaxKind.Identifier)) {
      continue;
    }
    if (parent.isKind(SyntaxKind.IfStatement) && parent.getExpression() === use) continue;
    if (parent.isKind(SyntaxKind.ConditionalExpression) && parent.getCondition() === use) continue;
    if (parent.isKind(SyntaxKind.PrefixUnaryExpression) && parent.getOperatorToken() === SyntaxKind.ExclamationToken) {
      continue;
    }
    return false;
  }
  return true;
}

/**
 * True when the value of an `as` / `satisfies` cast keeps all uses local. A
 * cast that flows onward as a whole — spread into a combined array, passed as
 * a bare argument — can have its members consumed through a different
 * declaration of the same structural type, invisibly to reference search.
 */
export function castValueStaysLocal(cast: Node): boolean {
  const consumer = climbWrappers(cast);
  const parent = consumer.getParent();
  if (!parent) return true;
  if (parent.isKind(SyntaxKind.PropertyAccessExpression) && parent.getExpression() === consumer) return true;
  if (isStringKeyedElementAccess(parent, consumer)) return true;
  if (parent.isKind(SyntaxKind.VariableDeclaration)) {
    const name = parent.getNameNode();
    // A destructured cast is read property by property at the binding.
    if (!name.isKind(SyntaxKind.Identifier)) return true;
    return valueUsesStayLocal(name);
  }
  return false;
}

/**
 * True when every read of this property keeps the value local. Writes into the
 * property (object-literal assignments) are fine; a read whose value then flows
 * onward as a whole (assigned into a differently-typed object, passed along)
 * means members of the property's own type can't be tracked.
 */
export function propertyValueStaysLocal(member: PropertySignature | PropertyDeclaration): boolean {
  for (const ref of member.findReferencesAsNodes()) {
    const parent = ref.getParent();
    if (!parent) continue;
    if (parent.isKind(SyntaxKind.ShorthandPropertyAssignment)) continue;
    if (parent.isKind(SyntaxKind.PropertyAssignment) && parent.getNameNode() === ref) continue;
    if (
      parent.isKind(SyntaxKind.PropertySignature) ||
      parent.isKind(SyntaxKind.PropertyDeclaration) ||
      parent.isKind(SyntaxKind.MethodSignature)
    ) {
      continue;
    }
    if (parent.isKind(SyntaxKind.PropertyAccessExpression) && parent.getNameNode() === ref) {
      if (accessValueStaysLocal(parent)) continue;
    }
    return false;
  }
  return true;
}

function accessValueStaysLocal(access: Node): boolean {
  const use = climbWrappers(access);
  const parent = use.getParent();
  if (!parent) return true;
  if (parent.isKind(SyntaxKind.PropertyAccessExpression) && parent.getExpression() === use) return true;
  if (isStringKeyedElementAccess(parent, use)) return true;
  if (parent.isKind(SyntaxKind.ExpressionStatement)) return true;
  if (parent.isKind(SyntaxKind.ForOfStatement) && parent.getExpression() === use) return true;
  if (parent.isKind(SyntaxKind.CallExpression) && parent.getExpression() === use) return true;
  if (parent.isKind(SyntaxKind.VariableDeclaration)) {
    const name = parent.getNameNode();
    return name.isKind(SyntaxKind.Identifier) ? valueUsesStayLocal(name) : true;
  }
  return false;
}

function callResultStaysLocal(call: CallExpression): boolean {
  const consumer = climbWrappers(call);
  const parent = consumer.getParent();
  if (!parent) return true;
  if (parent.isKind(SyntaxKind.PropertyAccessExpression) && parent.getExpression() === consumer) return true;
  if (isStringKeyedElementAccess(parent, consumer)) return true;
  if (parent.isKind(SyntaxKind.ExpressionStatement)) return true;
  if (parent.isKind(SyntaxKind.VariableDeclaration)) {
    const name = parent.getNameNode();
    if (!name.isKind(SyntaxKind.Identifier)) return true;
    return valueUsesStayLocal(name);
  }
  return false;
}

function isAliasDeclarationParent(parent: Node): boolean {
  return (
    parent.isKind(SyntaxKind.ImportSpecifier) ||
    parent.isKind(SyntaxKind.ExportSpecifier) ||
    parent.isKind(SyntaxKind.ImportClause) ||
    parent.isKind(SyntaxKind.NamespaceImport) ||
    parent.isKind(SyntaxKind.ExportAssignment)
  );
}

function climbWrappers(node: Node): Node {
  let current = node;
  while (true) {
    const parent = current.getParent();
    if (
      (parent?.isKind(SyntaxKind.ParenthesizedExpression) || parent?.isKind(SyntaxKind.NonNullExpression)) &&
      parent.getExpression() === current
    ) {
      current = parent;
      continue;
    }
    if (parent?.isKind(SyntaxKind.AwaitExpression) && parent.getExpression() === current) {
      current = parent;
      continue;
    }
    return current;
  }
}

function isStringKeyedElementAccess(parent: Node, expression: Node): boolean {
  return (
    parent.isKind(SyntaxKind.ElementAccessExpression) &&
    parent.getExpression() === expression &&
    (parent.getArgumentExpression()?.isKind(SyntaxKind.StringLiteral) ?? false)
  );
}
