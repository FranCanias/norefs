import type { Node, Project, SourceFile } from 'ts-morph';
import { ts } from 'ts-morph';

/**
 * Every reference in the project, indexed in one pass.
 *
 * The language service answers "where is this name used?" one declaration at a
 * time, and every answer rebuilds an import tracker and re-resolves every
 * module specifier in the project first: about 7 ms a call. noref asks the
 * question for nearly every declaration it finds — thousands of calls, most of
 * that time spent on the same setup over and over.
 *
 * So it asks the question the other way round. One walk over every identifier
 * in the project resolves each to the symbol it names and files the node under
 * it. After that, "where is this used?" is a map lookup.
 *
 * A reference reaches its declaration through more than a plain symbol match:
 * an import alias, a member of a union, an override of a base member, a
 * property of an object literal read through its contextual type, a
 * destructuring pattern. Each occurrence is filed under every symbol it can
 * stand for, and each query looks under every symbol its target can stand for.
 * Filing a node too widely costs a finding; filing it too narrowly would call
 * used code unused, so every uncertain case files wider.
 */
export interface IndexOptions {
  /**
   * Index what only member findings need: the contextual link from an
   * object-literal property or a JSX attribute to the member it writes.
   *
   * Working that link out means asking the checker for a contextual type,
   * which resolves the types of the surrounding call or component — most of
   * the cost of a run. Nothing but a member finding can rest on it: writing
   * `{ id: 1 }` is no use of an exported function named `id`. A run that asks
   * for exports, types, files, or dependencies alone leaves it out.
   */
  members: boolean;
}

export class ReferenceIndex {
  private readonly buckets = new Map<ts.Symbol, ts.Node[]>();
  private readonly related = new Map<ts.Symbol, ts.Symbol[]>();
  private readonly wrappers = new Map<ts.SourceFile, SourceFile>();
  private readonly checker: ts.TypeChecker;
  private readonly members: boolean;
  /**
   * Every member name a project file declares. A contextual occurrence — an
   * object-literal property, a JSX attribute, a destructured binding — can
   * only answer a member of the same name, and only project members are ever
   * asked about. An occurrence named like no project member (a config object
   * for a library, a prop of a third-party component) cannot change any
   * answer, so its contextual type is never worked out.
   */
  private readonly memberNames = new Set<string>();
  /**
   * Every name a query of this index can target. Each symbol an occurrence
   * is filed under shares the occurrence's name — an import alias is itself
   * a declared name — so an occurrence named like nothing in this set can
   * never be looked up, and is not worth resolving to a symbol at all.
   *
   * With members, collectors query local variables and functions too, so the
   * set is every declared name in the project. Without members, only the
   * module analysis queries the index — exported declarations, import and
   * export bindings, namespaces — and the set shrinks to the names those
   * statements touch.
   */
  private readonly queryableNames = new Set<string>();
  /** Contextual occurrences, held until every file's member names are in. */
  private pending: ts.Node[] = [];
  /** Intrinsic JSX tag symbols, per file — the JSX namespace can differ per file. */
  private readonly intrinsicTags = new Map<ts.SourceFile, Map<string, ts.Symbol>>();
  /**
   * Declared props per component symbol, and declared argument types per
   * callee type and position. A component used on three hundred elements has
   * one declaration to read — and when that read gives up (`null`), it gives
   * up everywhere, without retrying per site.
   */
  private readonly propsBySymbol = new Map<ts.Symbol, Anchor | null>();
  private readonly argumentsByCallee = new Map<ts.Type, Map<number, Anchor | null>>();

  constructor(project: Project, options: IndexOptions = { members: true }) {
    const program = project.getProgram().compilerObject;
    this.checker = program.getTypeChecker();
    this.members = options.members;
    const occurrences: ts.Node[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      this.wrappers.set(sourceFile.compilerNode, sourceFile);
      this.collectFile(sourceFile.compilerNode, occurrences);
    }
    for (const node of occurrences) {
      if (this.queryableNames.has(propertyName(node))) this.indexOccurrence(node);
    }
    const contextualTypes = new Map<ts.Node, ts.Type[]>();
    for (const node of this.pending) {
      if (this.memberNames.has(propertyName(node))) this.indexContextual(node, contextualTypes);
    }
    this.pending = [];
  }

  /** Every reference to the declaration this node names, itself excluded. */
  find(target: Node): Node[] {
    const compilerNode = target.compilerNode;
    const symbol = this.checker.getSymbolAtLocation(compilerNode);
    if (!symbol) return [];

    const found = new Set<ts.Node>();
    for (const related of this.relatedSymbols(symbol)) {
      for (const node of this.buckets.get(related) ?? []) {
        if (node !== compilerNode) found.add(node);
      }
    }
    return [...found]
      .sort((a, b) => a.getSourceFile().fileName.localeCompare(b.getSourceFile().fileName) || a.pos - b.pos)
      .map(node => this.wrap(node));
  }

  /**
   * True when a type this member's owner extends or implements declares a
   * member of the same name. Such a member is load-bearing whatever its
   * reference count: remove it and the class stops satisfying its contract.
   *
   * A base type the compiler could not resolve counts too. It may declare the
   * member, and code reading it through that type is invisible from here, so
   * nothing can prove the member unused.
   */
  isRequiredByBaseType(target: Node): boolean {
    const symbol = this.checker.getSymbolAtLocation(target.compilerNode);
    const owner = symbol?.declarations?.[0]?.parent;
    if (!symbol || !owner || !(ts.isClassLike(owner) || ts.isInterfaceDeclaration(owner))) return false;
    if (this.baseMembers(symbol).length > 0) return true;
    return (owner.heritageClauses ?? []).some(clause =>
      clause.types.some(typeNode => {
        const type = safely(() => this.checker.getTypeAtLocation(typeNode));
        return type !== undefined && (type.flags & ts.TypeFlags.Any) !== 0;
      })
    );
  }

  // ---------------------------------------------------------------- indexing

  /**
   * One walk over a file: every occurrence goes into the list, every name in
   * a declaring position goes into the name sets, and every contextual site
   * waits in the pending queue. No symbol is resolved yet — resolution runs
   * after the walk, when the name sets are complete enough to skip
   * occurrences nothing will ever ask about.
   */
  private collectFile(sourceFile: ts.SourceFile, occurrences: ts.Node[]): void {
    // Inside an import, an export declaration, or an export assignment,
    // every name takes part in the module graph the queries walk.
    const visit = (node: ts.Node, moduleStatement: boolean): void => {
      if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)) {
        occurrences.push(node);
        const parent = node.parent as ts.Node & { name?: ts.Node };
        if (this.members) {
          if (parent.name === node) {
            const name = propertyName(node);
            this.queryableNames.add(name);
            if (isMemberDeclarationName(node)) this.memberNames.add(name);
          }
          if (isContextualSite(node)) this.pending.push(node);
        } else if (moduleStatement || (parent.name === node && isExportedOrNamespaceName(parent))) {
          this.queryableNames.add(propertyName(node));
        }
      }
      const inModuleStatement =
        moduleStatement ||
        ts.isImportDeclaration(node) ||
        ts.isExportDeclaration(node) ||
        ts.isExportAssignment(node) ||
        ts.isImportEqualsDeclaration(node);
      node.forEachChild(child => visit(child, inModuleStatement));
    };
    sourceFile.forEachChild(child => visit(child, false));
  }

  private indexOccurrence(node: ts.Node): void {
    const direct = this.checker.getSymbolAtLocation(node);
    if (direct) this.fileUnder(direct, node);

    const parent = node.parent;
    if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
      const value = this.checker.getShorthandAssignmentValueSymbol(parent);
      if (value) this.fileUnder(value, node);
    }
  }

  private fileUnder(symbol: ts.Symbol, node: ts.Node): void {
    for (const related of this.relatedSymbols(symbol)) {
      const bucket = this.buckets.get(related);
      if (bucket) bucket.push(node);
      else this.buckets.set(related, [node]);
    }
  }

  /**
   * The symbols an occurrence stands for beyond the one the checker resolves:
   * a name in an object literal or a destructuring pattern also names the
   * property of the type it is read through — the only link between
   * `{ id: 1 }` and the `id` its interface declares.
   */
  private indexContextual(node: ts.Node, contextualTypes: Map<ts.Node, ts.Type[]>): void {
    const parent = node.parent;
    if (
      (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) &&
      ts.isObjectLiteralExpression(parent.parent)
    ) {
      this.fileProperties(this.contextualTypesOf(parent.parent, contextualTypes), node);
    } else if (ts.isBindingElement(parent)) {
      const pattern = safely(() => this.checker.getTypeAtLocation(parent.parent));
      this.fileProperties(pattern ? [pattern] : [], node);
    } else if (ts.isJsxAttribute(parent)) {
      this.fileProperties(this.contextualTypesOf(parent.parent, contextualTypes), node);
    }
  }

  private fileProperties(types: ts.Type[], node: ts.Node): void {
    const name = propertyName(node);
    for (const type of types) {
      for (const symbol of this.propertiesOf(type, name)) {
        this.fileUnder(symbol, node);
      }
    }
  }

  /**
   * The types a container may be read as: the interface an object literal is
   * assigned to, or the props of a JSX element. Working it out is the most
   * expensive question this index puts to the checker — it resolves the types
   * of the surrounding call or component — and every member of an object
   * literal and every attribute of a JSX element asks the same one about the
   * same container, so the answer is cached for the indexing pass.
   */
  private contextualTypesOf(container: ts.Expression, cache: Map<ts.Node, ts.Type[]>): ts.Type[] {
    const cached = cache.get(container);
    if (cached) return cached;
    const types = this.declaredContextualTypes(container) ?? this.askedContextualTypes(container);
    cache.set(container, types);
    return types;
  }

  /** The checker's own answer — exact, but it type-checks the surrounding call. */
  private askedContextualTypes(container: ts.Expression): ts.Type[] {
    const type = safely(() => this.checker.getContextualType(container));
    return type ? [type] : [];
  }

  // ------------------------------------------------- declared contextual types

  /**
   * The container's contextual types read off declared signatures alone.
   *
   * `getContextualType` on a call argument or a JSX attribute resolves the
   * whole call: every overload is checked against every argument, which is
   * most of what this index costs. But this index files wider on uncertainty
   * by design, so the picked overload does not matter — the argument's
   * declared type in *every* overload works, and reading those never
   * type-checks anything.
   *
   * The walk goes up from the container through object-literal properties,
   * array elements, and JSX attribute values to a call argument or a JSX
   * element, then back down the recorded steps through the declared types.
   * `undefined` means this shape is not covered — a spread, a union-typed
   * callee, a class component, a type whose members depend on an uninferred
   * type parameter — and the checker must be asked for real.
   */
  private declaredContextualTypes(container: ts.Expression): ts.Type[] | undefined {
    const steps: Array<string | typeof ELEMENT> = [];
    let node: ts.Node = container;
    for (;;) {
      const parent: ts.Node = node.parent;
      if (ts.isJsxAttributes(node)) {
        if (!ts.isJsxOpeningElement(parent) && !ts.isJsxSelfClosingElement(parent)) return undefined;
        const props = this.declaredPropsTypes(parent);
        return props && this.descend(props.types, steps, container, props.generic);
      }
      if (ts.isParenthesizedExpression(parent)) {
        node = parent;
      } else if (ts.isPropertyAssignment(parent) && ts.isObjectLiteralExpression(parent.parent)) {
        if (ts.isComputedPropertyName(parent.name)) return undefined;
        steps.push(propertyName(parent.name));
        node = parent.parent;
      } else if (ts.isArrayLiteralExpression(parent)) {
        steps.push(ELEMENT);
        node = parent;
      } else if (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent)) {
        const attributeName = parent.parent.name;
        if (!ts.isIdentifier(attributeName)) return undefined;
        steps.push(attributeName.text);
        node = parent.parent.parent;
      } else if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
        const anchor = this.declaredArgumentTypes(parent, node);
        return anchor && this.descend(anchor.types, steps, container, anchor.generic);
      } else {
        return undefined;
      }
    }
  }

  /**
   * The argument's declared type in every signature of the callee's type.
   *
   * A generic signature works too: which members `TableProps<T>` declares
   * does not depend on what `T` becomes, and member names are all a filing
   * needs. The declared types just get flagged for the stability check in
   * `descend` — a naked `T`, a conditional, a mapped type could gain or lose
   * members under instantiation, and only the checker knows those.
   */
  private declaredArgumentTypes(call: ts.CallExpression | ts.NewExpression, argument: ts.Node): Anchor | undefined {
    if (call.typeArguments || !call.arguments) return undefined;
    const index = call.arguments.indexOf(argument as ts.Expression);
    if (index < 0) return undefined;
    // A spread at or before the argument shifts every position after it.
    for (let i = 0; i <= index; i++) {
      if (ts.isSpreadElement(call.arguments[i])) return undefined;
    }
    const calleeType = safely(() => this.checker.getTypeAtLocation(call.expression));
    if (!calleeType || calleeType.isUnion()) return undefined;

    let byIndex = this.argumentsByCallee.get(calleeType);
    if (!byIndex) {
      byIndex = new Map();
      this.argumentsByCallee.set(calleeType, byIndex);
    }
    const cached = byIndex.get(index);
    if (cached !== undefined) return cached ?? undefined;
    const anchor = this.readArgumentTypes(call, calleeType, index, argument) ?? null;
    byIndex.set(index, anchor);
    return anchor ?? undefined;
  }

  private readArgumentTypes(
    call: ts.CallExpression | ts.NewExpression,
    calleeType: ts.Type,
    index: number,
    argument: ts.Node
  ): Anchor | undefined {
    const signatures = ts.isCallExpression(call) ? calleeType.getCallSignatures() : calleeType.getConstructSignatures();
    if (signatures.length === 0) return undefined;

    const types: ts.Type[] = [];
    let generic = false;
    for (const signature of signatures) {
      if (signature.typeParameters?.length) generic = true;
      const parameter = signature.parameters[index];
      if (!parameter) {
        // This overload never reaches the argument — unless its last
        // parameter is a rest that swallows it.
        const last = signature.parameters[signature.parameters.length - 1];
        if (last && isRestParameter(last)) return undefined;
        continue;
      }
      if (isRestParameter(parameter)) return undefined;
      const type = safely(() => this.checker.getTypeOfSymbolAtLocation(parameter, argument));
      if (!type) return undefined;
      types.push(type);
    }
    return { types, generic };
  }

  /**
   * The declared props of an intrinsic element or a function component,
   * generic components included — their attribute names sit in the declared
   * props type, and `descend` verifies nothing member-changing hides in it.
   * Class components go through JSX machinery — managed attributes — that
   * only the checker gets right.
   */
  private declaredPropsTypes(opening: ts.JsxOpeningLikeElement): Anchor | undefined {
    if (opening.typeArguments) return undefined;
    const tag = opening.tagName;
    if (ts.isIdentifier(tag)) {
      const first = tag.text.charCodeAt(0);
      if (first >= 97 && first <= 122) {
        const intrinsic = this.intrinsicPropsTypes(tag);
        return intrinsic && { types: intrinsic, generic: false };
      }
    } else if (!ts.isPropertyAccessExpression(tag)) {
      return undefined;
    }
    const symbol = safely(() => this.checker.getSymbolAtLocation(tag));
    if (!symbol) return this.readPropsTypes(opening, tag);
    const cached = this.propsBySymbol.get(symbol);
    if (cached !== undefined) return cached ?? undefined;
    const anchor = this.readPropsTypes(opening, tag) ?? null;
    this.propsBySymbol.set(symbol, anchor);
    return anchor ?? undefined;
  }

  private readPropsTypes(opening: ts.JsxOpeningLikeElement, tag: ts.JsxTagNameExpression): Anchor | undefined {
    const tagType = safely(() => this.checker.getTypeAtLocation(tag));
    if (!tagType || tagType.isUnion()) return undefined;
    if (tagType.getConstructSignatures().length > 0) return undefined;
    const signatures = tagType.getCallSignatures();
    if (signatures.length === 0) return undefined;

    const types: ts.Type[] = [];
    let generic = false;
    for (const signature of signatures) {
      if (signature.typeParameters?.length) generic = true;
      const parameter = signature.parameters[0];
      if (!parameter) continue; // a props-less component gives the attributes nothing to answer
      if (isRestParameter(parameter)) return undefined;
      const type = safely(() => this.checker.getTypeOfSymbolAtLocation(parameter, opening));
      if (!type) return undefined;
      types.push(type);
    }
    return { types, generic };
  }

  /**
   * The attributes an intrinsic element takes, read out of the JSX namespace
   * directly — `JSX.IntrinsicElements['div']` — instead of resolving the
   * element. The namespace is file-dependent (a `@jsxImportSource` pragma
   * swaps it), so the table caches per file.
   */
  private intrinsicPropsTypes(tag: ts.Identifier): ts.Type[] | undefined {
    const sourceFile = tag.getSourceFile();
    let table = this.intrinsicTags.get(sourceFile);
    if (!table) {
      table = new Map();
      for (const symbol of safely(() => this.checker.getJsxIntrinsicTagNamesAt(tag)) ?? []) {
        table.set(symbol.name, symbol);
      }
      this.intrinsicTags.set(sourceFile, table);
    }
    const symbol = table.get(tag.text);
    if (!symbol) return undefined;
    const type = safely(() => this.checker.getTypeOfSymbolAtLocation(symbol, tag));
    return type && [type];
  }

  /**
   * From the anchor's types back down to the container: each recorded step
   * reads a property's type, or an element type for an array literal. A type
   * without the named property may still type the step through an index
   * signature, the way the checker's own contextual walk does.
   *
   * Types out of a generic signature carry uninferred type parameters, and a
   * lookup stays truthful only while the members do not depend on them. Every
   * level of a generic descent is verified: one unstable part — a type
   * parameter, a conditional, `keyof`, an indexed access, a mapped type —
   * could gain or lose members under instantiation, and the walk hands the
   * question back to the checker.
   */
  private descend(
    anchor: ts.Type[],
    steps: Array<string | typeof ELEMENT>,
    location: ts.Node,
    generic: boolean
  ): ts.Type[] | undefined {
    let types = anchor;
    if (generic && !types.every(isStableUnderInstantiation)) return undefined;
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i];
      const next: ts.Type[] = [];
      for (const type of types) {
        for (const part of partsOf(type)) {
          if (step === ELEMENT) {
            const element = safely(() => this.checker.getIndexTypeOfType(part, ts.IndexKind.Number));
            if (element) next.push(element);
          } else {
            const property = safely(() => this.checker.getPropertyOfType(part, step));
            if (property) {
              const propertyType = safely(() => this.checker.getTypeOfSymbolAtLocation(property, location));
              if (!propertyType) return undefined;
              next.push(propertyType);
            } else {
              const indexed = safely(() => this.checker.getIndexTypeOfType(part, ts.IndexKind.String));
              if (indexed) next.push(indexed);
            }
          }
        }
      }
      if (generic && !next.every(isStableUnderInstantiation)) return undefined;
      types = next;
    }
    return types;
  }

  /**
   * The members of this name a type declares, looking into each part of a
   * union or intersection. A whole-type lookup gives up on `Info | null` —
   * the shape a nullable return annotation or an optional field takes — and
   * missing it would call a written property unread.
   */
  private propertiesOf(type: ts.Type | undefined, name: string): ts.Symbol[] {
    if (!type) return [];
    if (type.isUnionOrIntersection()) return type.types.flatMap(part => this.propertiesOf(part, name));
    const property = safely(() => this.checker.getPropertyOfType(type, name));
    return property ? [property] : [];
  }

  // ----------------------------------------------------------- symbol widening

  /**
   * Every symbol a declaration can be reached through: past its import
   * aliases, into the constituents of a union member, and across the base
   * types that declare a member of the same name.
   */
  private relatedSymbols(symbol: ts.Symbol): ts.Symbol[] {
    const cached = this.related.get(symbol);
    if (cached) return cached;

    const out: ts.Symbol[] = [];
    const seen = new Set<ts.Symbol>();
    const queue = [symbol];
    for (let current = queue.pop(); current; current = queue.pop()) {
      const canonical = this.canonical(current);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      out.push(canonical);
      queue.push(...(safely(() => this.checker.getRootSymbols(canonical)) ?? []));
      queue.push(...this.baseMembers(canonical));
    }

    this.related.set(symbol, out);
    return out;
  }

  /** Past import and export aliases, to the declaration the name ends up at. */
  private canonical(symbol: ts.Symbol): ts.Symbol {
    let current = symbol;
    while (current.flags & ts.SymbolFlags.Alias) {
      const aliased = safely(() => this.checker.getAliasedSymbol(current));
      if (!aliased || aliased === current) break;
      current = aliased;
    }
    return (current as ts.Symbol & { exportSymbol?: ts.Symbol }).exportSymbol ?? current;
  }

  /**
   * The same-named members of the classes and interfaces this member's owner
   * extends or implements. An override and the member it answers are one
   * declaration as far as usage goes: code reading the base member is using
   * the override too, and code reading the override justifies the base member.
   */
  private baseMembers(symbol: ts.Symbol): ts.Symbol[] {
    const owner = symbol.declarations?.[0]?.parent;
    if (!owner || !(ts.isClassLike(owner) || ts.isInterfaceDeclaration(owner))) return [];

    const members: ts.Symbol[] = [];
    for (const clause of owner.heritageClauses ?? []) {
      for (const typeNode of clause.types) {
        // The clause entry, not its expression: `extends Shape` names the
        // instance type, while the identifier `Shape` alone names the
        // constructor, which has no instance members on it.
        members.push(
          ...this.propertiesOf(
            safely(() => this.checker.getTypeAtLocation(typeNode)),
            symbol.name
          )
        );
      }
    }
    return members;
  }

  // ----------------------------------------------------------------- wrapping

  /**
   * ts-morph wraps a compiler node on demand and keeps the wrapper alive. Only
   * the nodes a query actually returns are worth that cost, so wrapping waits
   * until here — a fraction of the nodes the index holds.
   */
  private wrap(node: ts.Node): Node {
    const sourceFile = this.wrappers.get(node.getSourceFile());
    if (!sourceFile) throw new Error(`reference in an unindexed file: ${node.getSourceFile().fileName}`);
    return (sourceFile as unknown as WrappingSourceFile)._getNodeFromCompilerNode(node);
  }
}

/**
 * Where a contextual walk starts: the types a call argument or a JSX
 * attributes object is declared to take. `generic` marks types carrying
 * uninferred type parameters, which the descent must verify.
 */
interface Anchor {
  types: ts.Type[];
  generic: boolean;
}

interface WrappingSourceFile {
  _getNodeFromCompilerNode(compilerNode: ts.Node): Node;
}

function propertyName(name: ts.Node): string {
  // Cooked text, the form symbol names take — not raw source with escapes.
  return (name as Partial<ts.Identifier>).text ?? name.getText();
}

/**
 * True when this declaration's name can be a query target without members:
 * an export-modified declaration (the modifier reaches through a variable
 * statement) or a namespace, whose exported members the module analysis
 * checks one by one.
 */
function isExportedOrNamespaceName(declaration: ts.Node): boolean {
  if (ts.isModuleDeclaration(declaration)) return true;
  return (
    (ts.getCombinedModifierFlags(declaration as ts.Declaration) &
      (ts.ModifierFlags.Export | ts.ModifierFlags.Default)) !==
    0
  );
}

/** The step an array literal adds to a contextual walk: read an element type. */
const ELEMENT = Symbol('element');

/** A missing declaration proves nothing, so it counts as a rest parameter. */
function isRestParameter(parameter: ts.Symbol): boolean {
  const declaration = parameter.valueDeclaration;
  return !declaration || !ts.isParameter(declaration) || declaration.dotDotDotToken !== undefined;
}

/** The constituents of a union or intersection, and the type itself otherwise. */
function partsOf(type: ts.Type): ts.Type[] {
  return type.isUnionOrIntersection() ? type.types.flatMap(partsOf) : [type];
}

/**
 * The type flags of a member lookup instantiation can change: a naked type
 * parameter takes whatever shape inference gives it, and a conditional,
 * `keyof`, an indexed access, or `infer` resolves to different types per
 * branch. `Object` types stay put — a reference like `TableProps<T>` declares
 * the same member names whatever `T` becomes.
 */
const UNSTABLE_FLAGS =
  ts.TypeFlags.TypeParameter |
  ts.TypeFlags.Conditional |
  ts.TypeFlags.Index |
  ts.TypeFlags.IndexedAccess |
  ts.TypeFlags.Substitution;

/**
 * True when this type keeps its member names under any instantiation of the
 * type parameters it mentions. Mapped types count as unstable: one mapped
 * over `keyof T` has no members until `T` lands.
 */
function isStableUnderInstantiation(type: ts.Type): boolean {
  for (const part of partsOf(type)) {
    if (part.flags & UNSTABLE_FLAGS) return false;
    if (part.flags & ts.TypeFlags.Object && (part as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped) return false;
  }
  return true;
}

/**
 * True when this node names a declared member — of an interface, a type
 * literal, a class, an enum, or an object literal — in a file this index
 * walks. These are the only names a member finding can be about, so they are
 * the only names worth a contextual lookup. Parameter names count when the
 * parameter is a property (`constructor(private x)`).
 */
function isMemberDeclarationName(node: ts.Node): boolean {
  const parent = node.parent;
  switch (parent.kind) {
    case ts.SyntaxKind.PropertySignature:
    case ts.SyntaxKind.MethodSignature:
    case ts.SyntaxKind.PropertyDeclaration:
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
    case ts.SyntaxKind.EnumMember:
    case ts.SyntaxKind.PropertyAssignment:
    case ts.SyntaxKind.ShorthandPropertyAssignment:
      return (parent as ts.NamedDeclaration).name === node;
    case ts.SyntaxKind.Parameter:
      return (
        (parent as ts.ParameterDeclaration).name === node &&
        ts.isParameterPropertyDeclaration(parent as ts.ParameterDeclaration, parent.parent)
      );
    default:
      return false;
  }
}

/** True when this node could name a member of the type its container is read as. */
function isContextualSite(node: ts.Node): boolean {
  const parent = node.parent;
  if (
    (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) &&
    parent.name === node &&
    ts.isObjectLiteralExpression(parent.parent)
  ) {
    return true;
  }
  if (ts.isBindingElement(parent) && (parent.propertyName ?? parent.name) === node) return true;
  return ts.isJsxAttribute(parent) && parent.name === node;
}

/** The checker throws on some unresolved nodes; a missing answer is the answer. */
function safely<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

const indexes = new WeakMap<Project, ReferenceIndex>();

/** Build the index this run needs and hand it to every later query. */
export function buildReferenceIndex(project: Project, options: IndexOptions): ReferenceIndex {
  const built = new ReferenceIndex(project, options);
  indexes.set(project, built);
  return built;
}

/**
 * The index for this project. A caller that never asked for one — a test, or
 * a query outside an analysis — gets a full index, which answers everything.
 */
export function referenceIndex(project: Project): ReferenceIndex {
  const existing = indexes.get(project);
  if (existing) return existing;
  return buildReferenceIndex(project, { members: true });
}

/** Drop the index: the project has changed and every node in it is stale. */
export function resetReferenceIndex(project: Project): void {
  indexes.delete(project);
}
