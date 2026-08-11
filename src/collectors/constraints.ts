import type { Node, Project, SourceFile, Type } from 'ts-morph';
import { SymbolFlags, SyntaxKind } from 'ts-morph';

/**
 * A member can have zero references and still be load-bearing: when its owner
 * type must stay assignable to another declared type that requires a member of
 * the same name, removing it breaks compilation. Example: `interface Derived
 * extends Base { items: DerivedItem[] }` overrides `items: BaseItem[]`, so
 * `DerivedItem` must keep every required member of `BaseItem` even if nothing
 * ever reads them through `DerivedItem`.
 *
 * This index records those required member names per owner declaration
 * (interface, type literal, or class). Constraint sources: property overrides
 * under a declared heritage clause (interface extends, class extends and
 * implements) and type predicates (`x is T` constrains T by x's type).
 */
export type ConstraintIndex = Map<Node, Set<string>>;

const MAX_DEPTH = 4;

export function buildConstraintIndex(project: Project): ConstraintIndex {
  const index: ConstraintIndex = new Map();
  for (const sourceFile of project.getSourceFiles()) {
    if (sourceFile.isDeclarationFile()) continue;
    collectHeritageConstraints(sourceFile, index);
    collectPredicateConstraints(sourceFile, index);
  }
  return index;
}

/** Union of a candidate owner's probed names and constraint-required names. */
export function mergeNames(a: Set<string> | undefined, b: Set<string> | undefined): Set<string> | undefined {
  if (!a || a.size === 0) return b;
  if (!b || b.size === 0) return a;
  return new Set([...a, ...b]);
}

function collectHeritageConstraints(sourceFile: SourceFile, index: ConstraintIndex): void {
  for (const iface of sourceFile.getInterfaces()) {
    const bases = iface.getBaseTypes();
    if (bases.length === 0) continue;
    for (const member of iface.getMembers()) {
      if (!member.isKind(SyntaxKind.PropertySignature) && !member.isKind(SyntaxKind.MethodSignature)) continue;
      constrainOverride(member, member.getName(), bases, index);
    }
  }

  for (const cls of sourceFile.getClasses()) {
    const heritage = cls.getImplements().map(impl => impl.getType());
    const base = cls.getExtends();
    if (base) heritage.push(base.getType());
    if (heritage.length === 0) continue;
    for (const member of cls.getInstanceMembers()) {
      constrainOverride(member, member.getName(), heritage, index);
    }
  }
}

function constrainOverride(member: Node, name: string, heritage: Type[], index: ConstraintIndex): void {
  for (const baseType of heritage) {
    const baseProp = baseType.getProperty(name);
    if (!baseProp) continue;
    const baseDecl = baseProp.getDeclarations()[0];
    if (!baseDecl) continue;
    constrain(member.getType(), baseProp.getTypeAtLocation(baseDecl), index, 0);
  }
}

function collectPredicateConstraints(sourceFile: SourceFile, index: ConstraintIndex): void {
  for (const predicate of sourceFile.getDescendantsOfKind(SyntaxKind.TypePredicate)) {
    const typeNode = predicate.getTypeNode();
    if (!typeNode) continue;
    const paramName = predicate.getParameterNameNode();
    if (!paramName.isKind(SyntaxKind.Identifier)) continue;
    const signature = predicate.getParent();
    if (!('getParameters' in signature)) continue;
    const param = (signature as { getParameters(): Array<{ getName(): string; getType(): Type }> })
      .getParameters()
      .find(p => p.getName() === paramName.getText());
    if (!param) continue;
    constrain(typeNode.getType(), param.getType(), index, 0);
  }
}

/**
 * Record that `sub` must stay assignable to `sup`: every required member of
 * `sup` is load-bearing on `sub`'s declarations. Recurses into array elements,
 * matching type arguments, and same-named members, so the constraint reaches
 * nested types (`DerivedItem[]` vs `BaseItem[]`). Unions constrain pairwise —
 * over-marking only costs findings, never correctness.
 */
function constrain(sub: Type, sup: Type, index: ConstraintIndex, depth: number): void {
  if (depth > MAX_DEPTH) return;
  for (const s of sub.isUnion() ? sub.getUnionTypes() : [sub]) {
    for (const t of sup.isUnion() ? sup.getUnionTypes() : [sup]) {
      constrainSingle(s, t, index, depth);
    }
  }
}

function constrainSingle(sub: Type, sup: Type, index: ConstraintIndex, depth: number): void {
  const subElement = sub.getArrayElementType();
  const supElement = sup.getArrayElementType();
  if (subElement && supElement) {
    constrain(subElement, supElement, index, depth + 1);
    return;
  }

  const subSymbol = sub.getSymbol();
  if (subSymbol && subSymbol === sup.getSymbol()) {
    const subArgs = sub.getTypeArguments();
    const supArgs = sup.getTypeArguments();
    if (subArgs.length === supArgs.length) {
      for (let i = 0; i < subArgs.length; i++) constrain(subArgs[i], supArgs[i], index, depth + 1);
    }
    return;
  }

  const owners = (subSymbol?.getDeclarations() ?? []).filter(
    decl =>
      decl.isKind(SyntaxKind.InterfaceDeclaration) ||
      decl.isKind(SyntaxKind.TypeLiteral) ||
      decl.isKind(SyntaxKind.ClassDeclaration)
  );
  if (owners.length === 0) return;

  for (const prop of sup.getProperties()) {
    if ((prop.getFlags() & SymbolFlags.Optional) === 0) {
      for (const owner of owners) {
        const names = index.get(owner) ?? new Set<string>();
        names.add(prop.getName());
        index.set(owner, names);
      }
    }
    const subProp = sub.getProperty(prop.getName());
    const subDecl = subProp?.getDeclarations()[0];
    const supDecl = prop.getDeclarations()[0];
    if (!subProp || !subDecl || !supDecl) continue;
    constrain(subProp.getTypeAtLocation(subDecl), prop.getTypeAtLocation(supDecl), index, depth + 1);
  }
}
