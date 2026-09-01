import type {
  CallExpression,
  ForOfStatement,
  Identifier,
  Node,
  PropertyAccessExpression,
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
 * The rules a value answers to once a read reaches it.
 *
 * An object is read one property at a time, so a read that goes deeper stays
 * local. An array hands out elements, and each element is a shape of its own —
 * so `rows.map(send)` reads nothing of the array and everything of the shape
 * inside it. The two need different answers to the same question, and the read
 * check takes whichever set fits the value it is following.
 */
interface ValueRules {
  /** True when the value this expression yields keeps its shape local. */
  accessStaysLocal(access: Node): boolean;
  /** True when the value this binding holds keeps its shape local. */
  bindingStaysLocal(name: Identifier): boolean;
}

const OBJECT_RULES: ValueRules = {
  accessStaysLocal: accessValueStaysLocal,
  bindingStaysLocal: valueUsesStayLocal,
};

/** The same question asked of an array: what happens to the elements. */
export const ARRAY_RULES: ValueRules = {
  accessStaysLocal: arrayAccessStaysLocal,
  bindingStaysLocal: arrayUsesStayLocal,
};

/**
 * Array methods that hand each element to a callback and keep none of them in
 * what they return. The callback's first parameter is the element, and a
 * parameter that stays local cannot carry one out — so `rows.map(r => r.id)`
 * yields numbers, never rows.
 */
const ELEMENT_CALLBACK_METHODS = new Set(['forEach', 'map', 'flatMap', 'some', 'every', 'findIndex', 'findLastIndex']);

/** Methods that hand back an array of the same elements: the result faces the question the array did. */
const ELEMENT_ARRAY_METHODS = new Set(['filter']);

/** Methods that hand back one element: the result is read as the object it is. */
const ELEMENT_VALUE_METHODS = new Set(['find', 'findLast']);

/**
 * True when this array expression keeps its elements local: every element it
 * hands out is read one property at a time, and none of them leaves.
 *
 * Reading `.length` touches no element. Iterating binds one at a time, and
 * indexing names one without naming a member of it. Everything else —
 * `save(rows)`, `[...rows]`, `rows.sort()`, `rows.map(send)` — carries an
 * element somewhere a reference search cannot follow, and a member of that
 * shape could then be read with nothing to show for it.
 */
function arrayAccessStaysLocal(value: Node): boolean {
  const use = climbWrappers(value);
  const parent = use.getParent();
  if (!parent) return true;
  if (parent.isKind(SyntaxKind.ExpressionStatement)) return true;
  if (parent.isKind(SyntaxKind.ForOfStatement) && parent.getExpression() === use) {
    return forOfBindingStaysLocal(parent);
  }
  // `rows[0]` names an element. What happens to it is the object question.
  if (parent.isKind(SyntaxKind.ElementAccessExpression) && parent.getExpression() === use) {
    return accessValueStaysLocal(parent);
  }
  if (parent.isKind(SyntaxKind.PropertyAccessExpression) && parent.getExpression() === use) {
    return arrayMemberStaysLocal(parent);
  }
  if (parent.isKind(SyntaxKind.VariableDeclaration)) {
    const name = parent.getNameNode();
    // `const [first] = rows` binds an element through a pattern this check
    // does not follow, so the array is left untracked rather than guessed at.
    return name.isKind(SyntaxKind.Identifier) && arrayUsesStayLocal(name);
  }
  return false;
}

/** True when every use of this array binding keeps the elements local. */
export function arrayUsesStayLocal(name: Identifier): boolean {
  for (const ref of findReferencesAsNodes(name)) {
    const parent = ref.getParent();
    if (!parent) continue;
    if (isAliasDeclarationParent(parent)) continue;
    if (!arrayAccessStaysLocal(ref)) return false;
  }
  return true;
}

/** True when reaching this member of an array keeps the elements local. */
function arrayMemberStaysLocal(access: PropertyAccessExpression): boolean {
  const name = access.getName();
  if (name === 'length') return true;
  const call = access.getParentIfKind(SyntaxKind.CallExpression);
  if (!call || call.getExpression() !== access) return false;
  const yieldsArray = ELEMENT_ARRAY_METHODS.has(name);
  const yieldsElement = ELEMENT_VALUE_METHODS.has(name);
  if (!ELEMENT_CALLBACK_METHODS.has(name) && !yieldsArray && !yieldsElement) return false;

  // A callback written elsewhere takes the element into a body this check
  // would have to follow. Only one written here answers for what it is given.
  const callback = call.getArguments()[0];
  if (!callback?.isKind(SyntaxKind.ArrowFunction) && !callback?.isKind(SyntaxKind.FunctionExpression)) return false;
  const element = callback.getParameters()[0];
  const elementName = element?.getNameNode();
  // A destructured parameter reads the element property by property, which is
  // the reference the search is looking for. A callback that ignores the
  // element reads nothing of it at all.
  if (elementName?.isKind(SyntaxKind.Identifier) && !valueUsesStayLocal(elementName)) return false;

  if (yieldsArray) return arrayAccessStaysLocal(call);
  if (yieldsElement) return accessValueStaysLocal(call);
  // A callback method keeps no element in its result: the parameter that
  // stayed local could not carry one out.
  return true;
}

/** True when the binding a `for…of` fills keeps each element local. */
function forOfBindingStaysLocal(statement: ForOfStatement): boolean {
  const initializer = statement.getInitializer();
  if (!initializer.isKind(SyntaxKind.VariableDeclarationList)) return false;
  return initializer.getDeclarations().every(declaration => {
    const name = declaration.getNameNode();
    return !name.isKind(SyntaxKind.Identifier) || valueUsesStayLocal(name);
  });
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
export function propertyReadsStayLocal(
  member: PropertySignature | PropertyDeclaration | PropertyAssignment,
  rules: ValueRules = OBJECT_RULES
): boolean {
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
      if (!rules.accessStaysLocal(parent)) return false;
      read = true;
      continue;
    }
    // `v['outer']` names the property as plainly as `v.outer` does, and the
    // index resolves the string literal to it.
    if (parent.isKind(SyntaxKind.ElementAccessExpression) && parent.getArgumentExpression() === ref) {
      if (!rules.accessStaysLocal(parent)) return false;
      read = true;
      continue;
    }
    // `const { outer } = v` reads the property and names what it read. The
    // value is only as local as that binding is; a pattern that destructures
    // further never lets the value out at all.
    if (parent.isKind(SyntaxKind.BindingElement)) {
      const name = parent.getNameNode();
      if (name.isKind(SyntaxKind.Identifier) && !rules.bindingStaysLocal(name)) return false;
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

/**
 * True when the value carrying this write keeps the member readable from here.
 *
 * A write proves nothing on its own if the value goes somewhere this run
 * cannot read. `{ enter(node) { … } }` handed to graphql's `visit()` writes
 * `enter`, and the library reads it back on every traversal — from a package
 * whose source this run never holds, so no reference lands and the member
 * looks filled-in and forgotten. `expect(result).toEqual({ greeting: 'Hi' })`
 * is the same shape: the matcher reads `greeting` to compare it.
 *
 * The question is the callee, not the argument. A literal passed to a function
 * this project declares *and* implements is read where the reference search
 * already looks, and the verdict stands. One passed to a body this run does
 * not hold — a package, an ambient declaration, an overload with no
 * implementation — is not, and the member keeps the answer it had before.
 *
 * Everywhere else the value stays accountable. A literal assigned into a
 * stored slot, held in a local binding, or returned is read back through the
 * type that declares the member, which is what the reference search reads.
 *
 * Only a write inside an object literal is asked. An assignment writes through
 * a binding whose own type answers for the member already.
 */
export function writeValueStaysLocal(site: Node): boolean {
  const literal = enclosingObjectLiteral(site);
  return literal === undefined || !reachesUnreadableCallee(literal, new Set());
}

/** The object literal this write fills in — a property, a shorthand, or a method. */
function enclosingObjectLiteral(site: Node): Node | undefined {
  const member = site.getParent();
  if (!member) return undefined;
  if (
    member.isKind(SyntaxKind.PropertyAssignment) ||
    member.isKind(SyntaxKind.ShorthandPropertyAssignment) ||
    member.isKind(SyntaxKind.MethodDeclaration)
  ) {
    return member.getParentIfKind(SyntaxKind.ObjectLiteralExpression);
  }
  return undefined;
}

/** Follow a value forward to the calls it lands in, one hop at a time. */
function reachesUnreadableCallee(value: Node, seen: Set<Node>): boolean {
  if (seen.has(value)) return false;
  seen.add(value);

  const node = climbWrappers(value);
  const parent = node.getParent();
  if (!parent) return false;

  // A cast leaves the literal a value; where that value goes is the question.
  if (parent.isKind(SyntaxKind.AsExpression) || parent.isKind(SyntaxKind.SatisfiesExpression)) {
    return reachesUnreadableCallee(parent, seen);
  }
  // A value inside another literal, or inside an array, travels with it.
  if (parent.isKind(SyntaxKind.PropertyAssignment) || parent.isKind(SyntaxKind.ShorthandPropertyAssignment)) {
    const outer = parent.getParentIfKind(SyntaxKind.ObjectLiteralExpression);
    return outer !== undefined && reachesUnreadableCallee(outer, seen);
  }
  if (parent.isKind(SyntaxKind.ArrayLiteralExpression)) return reachesUnreadableCallee(parent, seen);
  // The hop that matters: an argument is read by whatever the callee does.
  if (parent.isKind(SyntaxKind.CallExpression) || parent.isKind(SyntaxKind.NewExpression)) {
    return parent.getExpression() !== node && !calleeBodyIsReadable(parent.getExpression());
  }
  // A binding carries the value on to each of its own uses.
  if (parent.isKind(SyntaxKind.VariableDeclaration)) {
    const name = parent.getNameNode();
    if (!name.isKind(SyntaxKind.Identifier)) return false;
    return findReferencesAsNodes(name).some(ref => reachesUnreadableCallee(ref, seen));
  }
  return false;
}

/** True when this run holds an implementation of the callee to read. */
function calleeBodyIsReadable(callee: Node): boolean {
  const symbol = callee.getSymbol();
  if (!symbol) return false;
  // An import binds the name to a specifier; the declaration is at the far end.
  const target = symbol.getAliasedSymbol() ?? symbol;
  return target.getDeclarations().some(decl => !decl.getSourceFile().isDeclarationFile() && hasBody(decl));
}

function hasBody(decl: Node): boolean {
  if (decl.isKind(SyntaxKind.VariableDeclaration)) {
    const initializer = decl.getInitializer();
    return initializer !== undefined && hasBody(initializer);
  }
  if (decl.isKind(SyntaxKind.ClassDeclaration) || decl.isKind(SyntaxKind.ClassExpression)) return true;
  const body = 'getBody' in decl ? (decl as { getBody(): Node | undefined }).getBody() : undefined;
  return body !== undefined;
}
