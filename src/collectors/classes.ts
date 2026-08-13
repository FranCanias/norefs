import type {
  ClassDeclaration,
  Expression,
  Identifier,
  Node,
  PropertyNamedNode,
  SourceFile,
  Symbol as TsSymbol,
  Type,
} from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import { findReferencesAsNodes } from '../engine/references';
import type { Candidate } from './candidate';
import { toCandidate } from './candidate';
import { mergeNames } from './constraints';
import { isKeyofTargeted } from './dynamic-usage';
import { callableEscapes, getCallableNameNode } from './escape';
import type { CollectContext } from './index';

export function collectClassCandidates(sourceFile: SourceFile, ctx: CollectContext): Candidate[] {
  const candidates: Candidate[] = [];
  for (const cls of sourceFile.getClasses()) {
    if (ctx.dynamic.suppressed.has(cls)) continue;
    if (hasDecorators(cls)) continue;

    const nameNode = cls.getNameNode();
    if (!nameNode) continue;
    let targeted = ctx.keyofTargeted.get(cls);
    if (targeted === undefined) {
      targeted = isKeyofTargeted(nameNode);
      ctx.keyofTargeted.set(cls, targeted);
    }
    if (targeted) continue;
    if (classEscapesTracking(cls, ctx.classEscapes)) continue;

    const skip = mergeNames(ctx.dynamic.probed.get(cls), ctx.constrained.get(cls));
    const context = `class \`${cls.getName()}\``;
    for (const member of cls.getMembers()) {
      const candidate = toCandidate(member, context, false, skip);
      if (candidate) candidates.push(candidate);
    }
    for (const ctor of cls.getConstructors()) {
      for (const param of ctor.getParameters()) {
        if (!param.isParameterProperty()) continue;
        if (!param.getNameNode().isKind(SyntaxKind.Identifier)) continue;
        if (skip?.has(param.getName())) continue;
        candidates.push({ member: param as unknown as PropertyNamedNode & Node, context, anonymous: false });
      }
    }
  }
  return candidates;
}

/**
 * Decorators hand the class to a framework that reads members through
 * reflection or metadata, invisibly to reference search. Skip the whole class.
 */
function hasDecorators(cls: ClassDeclaration): boolean {
  if (cls.getDecorators().length > 0) return true;
  return cls
    .getMembers()
    .some(member => 'getDecorators' in member && (member as { getDecorators(): unknown[] }).getDecorators().length > 0);
}

/**
 * True when instances of this class (or of a subclass) escape into a type that
 * is not the class itself or its declared heritage. A structural implementation
 * — `new StoreImpl()` returned as interface `Store` without an `implements`
 * clause — is called through the interface, so its members collect zero
 * references while being used at runtime. Only declared heritage merges
 * reference groups, so anything else must silence the class.
 */
function classEscapesTracking(cls: ClassDeclaration, cache: Map<Node, boolean>): boolean {
  const cached = cache.get(cls);
  if (cached !== undefined) return cached;

  // Seed conservatively so a cycle between mutually-constructing classes
  // resolves to "escapes" instead of recursing forever.
  cache.set(cls, true);
  let escapes = classItselfEscapes(cls, cache);
  if (!escapes) {
    escapes = derivedClasses(cls).some(derived => classEscapesTracking(derived, cache));
  }
  cache.set(cls, escapes);
  return escapes;
}

/**
 * The classes that directly extend this one, found through the project-wide
 * reference index. ts-morph's own `getDerivedClasses` asks the language
 * service per class, which rebuilds an import tracker every call. Recursion
 * in `classEscapesTracking` covers the transitive subclasses.
 */
function derivedClasses(cls: ClassDeclaration): ClassDeclaration[] {
  const nameNode = cls.getNameNode();
  if (!nameNode) return [];
  const derived: ClassDeclaration[] = [];
  for (const ref of findReferencesAsNodes(nameNode)) {
    const expression = ref.getParentWhileKind(SyntaxKind.PropertyAccessExpression) ?? ref;
    const heritage = expression.getParentIfKind(SyntaxKind.ExpressionWithTypeArguments)?.getParent();
    if (!heritage?.isKind(SyntaxKind.HeritageClause) || heritage.getToken() !== SyntaxKind.ExtendsKeyword) continue;
    const owner = heritage.getParentIfKind(SyntaxKind.ClassDeclaration);
    if (owner) derived.push(owner);
  }
  return derived;
}

const NEUTRAL_REF_PARENTS = new Set<SyntaxKind>([
  SyntaxKind.TypeReference,
  SyntaxKind.TypeQuery,
  SyntaxKind.ExpressionWithTypeArguments,
  SyntaxKind.ImportSpecifier,
  SyntaxKind.ExportSpecifier,
  SyntaxKind.ImportClause,
  SyntaxKind.NamespaceImport,
  SyntaxKind.ExportAssignment,
]);

function classItselfEscapes(cls: ClassDeclaration, cache: Map<Node, boolean>): boolean {
  const nameNode = cls.getNameNode();
  if (!nameNode) return true;
  const allowed = allowedTypeSymbols(cls);

  for (const ref of findReferencesAsNodes(nameNode)) {
    const parent = ref.getParent();
    if (!parent) continue;
    if (NEUTRAL_REF_PARENTS.has(parent.getKind())) continue;
    if (parent.isKind(SyntaxKind.PropertyAccessExpression) && parent.getExpression() === ref) continue;
    if (parent.isKind(SyntaxKind.BinaryExpression) && parent.getOperatorToken().isKind(SyntaxKind.InstanceOfKeyword)) {
      continue;
    }
    if (parent.isKind(SyntaxKind.NewExpression) && parent.getExpression() === ref) {
      if (constructedValueEscapes(parent, allowed, cache)) return true;
      continue;
    }
    return true;
  }
  return false;
}

/** The class itself plus every declared base and implemented interface, recursively. */
function allowedTypeSymbols(cls: ClassDeclaration, out = new Set<TsSymbol>()): Set<TsSymbol> {
  const symbol = cls.getSymbol();
  if (symbol) out.add(symbol);
  for (const impl of cls.getImplements()) {
    for (const s of [impl.getType().getSymbol(), impl.getType().getAliasSymbol()]) {
      if (s) out.add(s);
    }
  }
  const base = cls.getBaseClass();
  if (base && !out.has(base.getSymbolOrThrow())) allowedTypeSymbols(base, out);
  return out;
}

function typeIsAllowed(type: Type, allowed: Set<TsSymbol>, depth = 0): boolean {
  if (depth > 3) return false;
  if (type.isUnion()) {
    return type
      .getUnionTypes()
      .every(part => part.isNull() || part.isUndefined() || typeIsAllowed(part, allowed, depth + 1));
  }
  for (const s of [type.getSymbol(), type.getAliasSymbol()]) {
    if (s && allowed.has(s)) return true;
  }
  return false;
}

/**
 * Follow a `new X(…)` expression to the slot that receives the instance. The
 * value keeps its tracking only while the receiving type is the class or its
 * declared heritage.
 */
function constructedValueEscapes(newExpr: Node, allowed: Set<TsSymbol>, cache: Map<Node, boolean>): boolean {
  let expr: Node = newExpr;
  for (;;) {
    const parent = expr.getParent();
    if (!parent) return true;
    if (parent.isKind(SyntaxKind.ParenthesizedExpression) || parent.isKind(SyntaxKind.NonNullExpression)) {
      expr = parent;
      continue;
    }
    if (parent.isKind(SyntaxKind.AsExpression) || parent.isKind(SyntaxKind.SatisfiesExpression)) {
      if (!typeIsAllowed(parent.getType(), allowed)) return true;
      expr = parent;
      continue;
    }
    break;
  }

  const parent = expr.getParentOrThrow();
  if (parent.isKind(SyntaxKind.PropertyAccessExpression) && parent.getExpression() === expr) return false;
  if (parent.isKind(SyntaxKind.SpreadAssignment) || parent.isKind(SyntaxKind.SpreadElement)) return false;
  if (parent.isKind(SyntaxKind.ExpressionStatement)) return false;

  const contextual = (expr as Expression).getContextualType();
  if (contextual && !typeIsAllowed(contextual, allowed)) return true;

  // A returned instance keeps its class type only while the function handing it
  // out is itself visible to reference search. A method of a structurally
  // escaping class is called through the interface twin, so its return value is
  // laundered even when the return type names the class.
  if (parent.isKind(SyntaxKind.ReturnStatement) || parent.isKind(SyntaxKind.ArrowFunction)) {
    return returnedInstanceEscapes(parent, cache);
  }
  if (contextual) return false;

  if (parent.isKind(SyntaxKind.VariableDeclaration)) {
    const varName = parent.getNameNode();
    if (!varName.isKind(SyntaxKind.Identifier)) return true;
    return variableEscapes(varName, allowed);
  }
  return true;
}

const FUNCTION_LIKE_KINDS = [
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
] as const;

function returnedInstanceEscapes(returnSite: Node, cache: Map<Node, boolean>): boolean {
  const fn = returnSite.isKind(SyntaxKind.ArrowFunction)
    ? returnSite
    : returnSite.getFirstAncestor(a => FUNCTION_LIKE_KINDS.some(kind => a.isKind(kind)));
  if (!fn) return true;

  if (
    fn.isKind(SyntaxKind.MethodDeclaration) ||
    fn.isKind(SyntaxKind.GetAccessor) ||
    fn.isKind(SyntaxKind.SetAccessor)
  ) {
    const owner = fn.getParent();
    if (!owner?.isKind(SyntaxKind.ClassDeclaration)) return true;
    if (classEscapesTracking(owner, cache)) return true;
  }

  const name = getCallableNameNode(fn);
  if (!name) return true;
  return callableEscapes(name);
}

/** True when any later use of the variable hands the instance to a differently-typed slot. */
function variableEscapes(varName: Identifier, allowed: Set<TsSymbol>): boolean {
  for (const ref of findReferencesAsNodes(varName)) {
    const parent = ref.getParent();
    if (!parent) continue;
    if (parent.isKind(SyntaxKind.PropertyAccessExpression) && parent.getExpression() === ref) continue;
    if (parent.isKind(SyntaxKind.BinaryExpression)) {
      const op = parent.getOperatorToken().getKind();
      if (op === SyntaxKind.InstanceOfKeyword) continue;
      if (op === SyntaxKind.EqualsToken && parent.getLeft() === ref) continue;
    }
    const contextual = (ref as Expression).getContextualType?.();
    if (contextual) {
      if (!typeIsAllowed(contextual, allowed)) return true;
      continue;
    }
    if (parent.isKind(SyntaxKind.ExpressionStatement)) continue;
    return true;
  }
  return false;
}
