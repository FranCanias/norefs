import type {
  CallExpression,
  Identifier,
  Node,
  PropertyAssignment,
  PropertyDeclaration,
  PropertySignature,
} from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import { findReferencesAsNodes } from '../lookup/references';

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
  for (const ref of findReferencesAsNodes(nameNode)) {
    const parent = ref.getParent();
    if (!parent) continue;
    if (isAliasDeclarationParent(parent)) continue;

    const call = callTo(ref);
    if (!call) return true;
    if (!callResultStaysLocal(call)) return true;
  }
  return false;
}

/** The call this reference is the callee of — `dump(…)`, `utils.dump(…)` — and nothing else. */
export function callTo(ref: Node): CallExpression | undefined {
  let callee: Node = ref;
  const access = ref.getParentIfKind(SyntaxKind.PropertyAccessExpression);
  if (access?.getNameNode() === ref) callee = access;
  const call = callee.getParentIfKind(SyntaxKind.CallExpression);
  return call?.getExpression() === callee ? call : undefined;
}

/** True when every use of this binding is a local property read or a boolean test. */
export function valueUsesStayLocal(name: Identifier): boolean {
  for (const ref of findReferencesAsNodes(name)) {
    const use = climbWrappers(ref);
    const parent = use.getParent();
    if (!parent) continue;
    // An import or export specifier is not a use, it is the same binding under
    // another name — and the index resolves past it, so the uses it leads to
    // are in this list already. Reading it as an escape would make every
    // exported binding untrackable.
    if (isAliasDeclarationParent(parent)) continue;
    if (parent.isKind(SyntaxKind.PropertyAccessExpression) && parent.getExpression() === use) continue;
    if (isStringKeyedElementAccess(parent, use)) continue;
    if (parent.isKind(SyntaxKind.VariableDeclaration) && !parent.getNameNode().isKind(SyntaxKind.Identifier)) {
      continue;
    }
    // `'a' in value` reads one named key and says nothing about the rest, which
    // is what the dynamic index files as a probe. A computed key reads a key
    // nobody wrote down, and that index has already suppressed the whole type.
    if (parent.isKind(SyntaxKind.BinaryExpression) && parent.getOperatorToken().getKind() === SyntaxKind.InKeyword) {
      if (parent.getRight() === use && parent.getLeft().isKind(SyntaxKind.StringLiteral)) continue;
      return false;
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
 * True when something reads this property and every read keeps the value
 * local. A read that flows onward as a whole — assigned into a
 * differently-typed object, passed along as an argument — carries the
 * property's own shape with it, and a member of that shape can then be
 * consumed with no reference to show for it.
 *
 * Three shapes count as a local read: a further property access, a
 * string-keyed index, and a destructuring whose binding stays local in turn.
 * Writes into the property are not reads and decide nothing either way.
 *
 * No read at all fails the test rather than passing it vacuously. Nothing
 * reaches inside a property nobody reads, so the property itself is the
 * finding — and reporting the members under it would say one death twice and
 * hand `--fix` two edits for one deletion.
 */
export function propertyReadsStayLocal(member: PropertySignature | PropertyDeclaration | PropertyAssignment): boolean {
  let read = false;
  for (const ref of findReferencesAsNodes(member.getNameNode())) {
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
      if (!accessValueStaysLocal(parent)) return false;
      read = true;
      continue;
    }
    // `v['outer']` names the property as plainly as `v.outer` does, and the
    // index resolves the string literal to it.
    if (parent.isKind(SyntaxKind.ElementAccessExpression) && parent.getArgumentExpression() === ref) {
      if (!accessValueStaysLocal(parent)) return false;
      read = true;
      continue;
    }
    // `const { outer } = v` reads the property and names what it read. The
    // value is only as local as that binding is; a pattern that destructures
    // further never lets the value out at all.
    if (parent.isKind(SyntaxKind.BindingElement)) {
      const name = parent.getNameNode();
      if (name.isKind(SyntaxKind.Identifier) && !valueUsesStayLocal(name)) return false;
      read = true;
      continue;
    }
    return false;
  }
  return read;
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
