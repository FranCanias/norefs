import type { Node, Project, SourceFile, Type, TypeLiteralNode } from 'ts-morph';
import { SymbolFlags, SyntaxKind } from 'ts-morph';
import { forEachDescendantOfKinds } from '../lookup/descendants';
import { isOwnDeclarationFile } from '../lookup/files';

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
 * implements), type predicates (`x is T` constrains T by x's type), and
 * type-level reads — a property named in a written type literal that the type
 * system matches structurally against another type.
 */
export type ConstraintIndex = Map<Node, Set<string>>;

const MAX_DEPTH = 4;

export function buildConstraintIndex(project: Project): ConstraintIndex {
  const index: ConstraintIndex = new Map();
  for (const sourceFile of project.getSourceFiles()) {
    // `interface Bridge extends Channel` keeps Channel's members load-bearing
    // wherever it is written, and a project's own `.d.ts` is one of the places.
    if (sourceFile.isDeclarationFile() && !isOwnDeclarationFile(sourceFile)) continue;
    collectHeritageConstraints(sourceFile, index);
    collectWalkConstraints(sourceFile, index);
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

/** Every node kind the merged walk below dispatches on: one pass finds them all. */
const WALKED_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.TypePredicate,
  SyntaxKind.ConditionalType,
  SyntaxKind.TypeReference,
  SyntaxKind.CallExpression,
  SyntaxKind.NewExpression,
  SyntaxKind.ExpressionWithTypeArguments,
]);

/**
 * Type-level reads. Some properties are never touched at runtime and are still
 * read on every compile, because the type system matches a written type literal
 * against another type and the property names decide the answer:
 *
 * ```ts
 * type Daily = Extract<Schedule, { type: 'DAILY' }>;   // `type` picks the branch
 * function hasId(r: Recipe): r is Recipe & { id: string };  // `id` is what narrows
 * pickFirst<Row>(rows);   // Row satisfies `T extends { id: string }` through `id`
 * ```
 *
 * Delete `type` from the filter and `Extract` matches the whole union; delete it
 * from `Schedule`'s members and the filter matches nothing. The name is doing
 * work on both sides of the match, so it counts as a read on both sides.
 *
 * Only written type arguments are matched here. An inferred one — `pickFirst(rows)`
 * — passes the value itself into the call, and the escape check already stops
 * tracking members of a value that leaves whole.
 */
function collectWalkConstraints(sourceFile: SourceFile, index: ConstraintIndex): void {
  forEachDescendantOfKinds(sourceFile, WALKED_KINDS, node => {
    if (node.isKind(SyntaxKind.TypePredicate)) {
      const asserted = node.getTypeNode();
      const narrowed = predicateParameterType(node);
      if (asserted && narrowed) {
        constrain(asserted.getType(), narrowed, index, 0);
        creditLiterals(asserted, narrowed, index);
      }
      return;
    }
    if (node.isKind(SyntaxKind.ConditionalType)) {
      matchStructurally(node.getCheckType(), node.getExtendsType(), index);
      return;
    }
    if (node.isKind(SyntaxKind.TypeReference)) {
      const pair = conditionalAliasArguments(node);
      if (pair) matchStructurally(pair[0], pair[1], index);
      creditConstraints(node.getTypeArguments(), node.getTypeName(), index);
      return;
    }
    if (
      node.isKind(SyntaxKind.CallExpression) ||
      node.isKind(SyntaxKind.NewExpression) ||
      node.isKind(SyntaxKind.ExpressionWithTypeArguments)
    ) {
      creditConstraints(node.getTypeArguments(), node.getExpression(), index);
    }
  });
}

/**
 * `pickFirst<Row>(…)` against `<T extends { id: string }>`: the constraint names
 * `id`, and the argument is what has to have it. Nothing reads `id` at runtime
 * through a `Row`, and removing it stops the file compiling.
 */
function creditConstraints(args: Node[], target: Node, index: ConstraintIndex): void {
  if (args.length === 0) return;
  const parameters = typeParametersOf(target);
  const parameterNames = new Set(parameters.map(parameter => parameter.getName()));
  for (const [i, parameter] of parameters.entries()) {
    const arg = args[i];
    if (!arg) break;
    const constraint = parameter.getConstraint();
    if (!constraint) continue;
    creditLiterals(constraint, arg.getType(), index);
    if (mentionsTypeParameter(constraint, parameterNames)) creditEveryMember(arg.getType(), index);
  }
}

/**
 * A constraint written in terms of another type parameter —
 * `Defaults extends Omit<Required<Options>, RequiredKeysOf<Options>>` — is a
 * shape only instantiation settles. It plainly requires members, and which
 * ones is not written anywhere this can read, so every member of the argument
 * counts as required.
 *
 * Guessing the other way would report a name the compiler checks on every
 * build. This is the bargain the whole file strikes: over-marking costs a
 * finding, and calling load-bearing code dead costs a build.
 */
function creditEveryMember(against: Type, index: ConstraintIndex): void {
  const owners = new Set<Node>();
  collectOwners(against, owners, 0);
  if (owners.size === 0) return;
  for (const symbol of against.getProperties()) {
    for (const owner of owners) record(owner, symbol.getName(), index);
  }
}

/** True when a constraint names one of the type parameters declared beside it. */
function mentionsTypeParameter(constraint: Node, parameterNames: Set<string>): boolean {
  const names = [constraint, ...constraint.getDescendantsOfKind(SyntaxKind.TypeReference)];
  return names.some(node => node.isKind(SyntaxKind.TypeReference) && parameterNames.has(node.getTypeName().getText()));
}

/** The two things this file needs from a type parameter, across every kind of declaration that has them. */
interface ConstrainedParameter {
  getConstraint(): Node | undefined;
  getName(): string;
}

function typeParametersOf(target: Node): ConstrainedParameter[] {
  const symbol = target.getSymbol();
  for (const decl of (symbol?.getAliasedSymbol() ?? symbol)?.getDeclarations() ?? []) {
    if (!('getTypeParameters' in decl)) continue;
    const parameters = (decl as { getTypeParameters(): ConstrainedParameter[] }).getTypeParameters();
    if (parameters.length > 0) return parameters;
  }
  return [];
}

/**
 * `Extract<Schedule, { type: 'DAILY' }>` is the same match as
 * `Schedule extends { type: 'DAILY' } ? …`, one alias away. When a reference
 * names an alias whose body is a conditional type over its own parameters,
 * return the call-site arguments standing in those two positions. This resolves
 * `Extract` and `Exclude` without naming them — any conditional alias works.
 */
function conditionalAliasArguments(reference: Node): [Node, Node] | undefined {
  if (!reference.isKind(SyntaxKind.TypeReference)) return undefined;
  const args = reference.getTypeArguments();
  if (args.length === 0) return undefined;

  const name = reference.getTypeName();
  if (!name.isKind(SyntaxKind.Identifier)) return undefined;
  const alias = name
    .getSymbol()
    ?.getDeclarations()
    .find(decl => decl.isKind(SyntaxKind.TypeAliasDeclaration));
  if (!alias?.isKind(SyntaxKind.TypeAliasDeclaration)) return undefined;

  const body = alias.getTypeNode();
  if (!body?.isKind(SyntaxKind.ConditionalType)) return undefined;

  const parameters = alias.getTypeParameters().map(p => p.getName());
  const argumentFor = (node: Node): Node | undefined => {
    if (!node.isKind(SyntaxKind.TypeReference)) return undefined;
    const position = parameters.indexOf(node.getTypeName().getText());
    return position === -1 ? undefined : args[position];
  };

  const check = argumentFor(body.getCheckType());
  const extend = argumentFor(body.getExtendsType());
  return check && extend ? [check, extend] : undefined;
}

function predicateParameterType(predicate: Node): Type | undefined {
  if (!predicate.isKind(SyntaxKind.TypePredicate)) return undefined;
  const paramName = predicate.getParameterNameNode();
  if (!paramName.isKind(SyntaxKind.Identifier)) return undefined;
  const signature = predicate.getParent();
  if (!('getParameters' in signature)) return undefined;
  return (signature as { getParameters(): Array<{ getName(): string; getType(): Type }> })
    .getParameters()
    .find(p => p.getName() === paramName.getText())
    ?.getType();
}

/** Both operands of a match read each other's names, so credit each side with the other's literals. */
function matchStructurally(left: Node, right: Node, index: ConstraintIndex): void {
  creditLiterals(left, right.getType(), index);
  creditLiterals(right, left.getType(), index);
}

/**
 * Credit every name written in `source`'s type literals to those literals and to
 * the declarations behind `against`. Literals at the top level of the type
 * expression are matched against `against` itself; one nested inside a member is
 * matched against that member's type, one level down, which is where its own
 * names are doing their work.
 */
function creditLiterals(source: Node, against: Type, index: ConstraintIndex, depth = 0): void {
  if (depth > MAX_DEPTH) return;
  const literals = topLevelLiterals(source);
  if (literals.length === 0) return;

  const owners = new Set<Node>();
  collectOwners(against, owners, 0);

  for (const literal of literals) {
    for (const member of literal.getMembers()) {
      const name = memberName(member);
      if (!name) continue;
      record(literal, name, index);
      for (const owner of owners) record(owner, name, index);
      creditNested(member, name, against, index, depth);
    }
  }
}

/**
 * A filter can name a property one level in: `Extract<Event, { payload: { kind:
 * 'RENAME' } }>` matches on `kind`, and the type it matches `kind` against is
 * whatever `payload` holds. So the nested literal descends with the property it
 * was written under — the same read as a top-level one, one step deeper.
 */
function creditNested(member: Node, name: string, against: Type, index: ConstraintIndex, depth: number): void {
  if (!member.isKind(SyntaxKind.PropertySignature)) return;
  const written = member.getTypeNode();
  if (!written) return;
  for (const type of propertyTypes(against, name, 0)) {
    // `{ steps: { done: boolean }[] }` against `Step[]`: the literal describes
    // one element, so both sides shed their array together. One side alone
    // would match a bare literal against an element type — a filter that can
    // never select anything, crediting a name to a type nothing read it on.
    const element = type.getArrayElementType();
    const shed = element !== undefined && written.isKind(SyntaxKind.ArrayType);
    const node = shed ? written.getElementTypeNode() : written;
    if (node) creditLiterals(node, shed ? element : type, index, depth + 1);
  }
}

/** The types a property of this name can hold, across every part of a union or intersection. */
function propertyTypes(type: Type, name: string, depth: number): Type[] {
  if (depth > MAX_DEPTH) return [];
  if (type.isUnion()) return type.getUnionTypes().flatMap(part => propertyTypes(part, name, depth + 1));
  if (type.isIntersection()) {
    return type.getIntersectionTypes().flatMap(part => propertyTypes(part, name, depth + 1));
  }
  const property = type.getProperty(name);
  const declaration = property?.getDeclarations()[0];
  return property && declaration ? [property.getTypeAtLocation(declaration)] : [];
}

function topLevelLiterals(node: Node, out: TypeLiteralNode[] = []): TypeLiteralNode[] {
  if (node.isKind(SyntaxKind.TypeLiteral)) out.push(node);
  else if (node.isKind(SyntaxKind.ParenthesizedType)) topLevelLiterals(node.getTypeNode(), out);
  else if (node.isKind(SyntaxKind.UnionType) || node.isKind(SyntaxKind.IntersectionType)) {
    for (const part of node.getTypeNodes()) topLevelLiterals(part, out);
  }
  return out;
}

function memberName(member: Node): string | undefined {
  if (!member.isKind(SyntaxKind.PropertySignature) && !member.isKind(SyntaxKind.MethodSignature)) return undefined;
  const nameNode = member.getNameNode();
  if (nameNode.isKind(SyntaxKind.ComputedPropertyName)) return undefined;
  return nameNode.isKind(SyntaxKind.StringLiteral) ? nameNode.getLiteralValue() : nameNode.getText();
}

function collectOwners(type: Type, out: Set<Node>, depth: number): void {
  if (depth > MAX_DEPTH) return;
  if (type.isUnion()) {
    for (const part of type.getUnionTypes()) collectOwners(part, out, depth + 1);
    return;
  }
  if (type.isIntersection()) {
    for (const part of type.getIntersectionTypes()) collectOwners(part, out, depth + 1);
    return;
  }
  for (const symbol of [type.getAliasSymbol(), type.getSymbol()]) {
    for (const decl of symbol?.getDeclarations() ?? []) {
      if (
        decl.isKind(SyntaxKind.InterfaceDeclaration) ||
        decl.isKind(SyntaxKind.TypeLiteral) ||
        decl.isKind(SyntaxKind.ClassDeclaration)
      ) {
        out.add(decl);
      }
    }
  }
}

function record(owner: Node, name: string, index: ConstraintIndex): void {
  const names = index.get(owner) ?? new Set<string>();
  names.add(name);
  index.set(owner, names);
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
      for (const [i, subArg] of subArgs.entries()) constrain(subArg, supArgs[i]!, index, depth + 1);
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
