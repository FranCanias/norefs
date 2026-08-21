import type { Node, Project, SourceFile } from 'ts-morph';
import { ts } from 'ts-morph';

/**
 * Every reference in the project, indexed in one pass.
 *
 * The language service answers "where is this name used?" one declaration at a
 * time, and every answer rebuilds an import tracker and re-resolves every
 * module specifier in the project first: about 7 ms a call. norefs asks the
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
 *
 * It is the longest file here, so a map of it. Build runs in four passes, and
 * the banners below mark them in that order:
 *
 * 1. **indexing** — one walk per file collects every identifier by its text
 *    and records the rename links between texts. Only the spreads resolve
 *    right away; everything else waits. A name resolves — plain occurrences
 *    and contextual sites both — when the first query targets it, and a name
 *    no query ever targets — half the occurrences of a big project — never
 *    resolves at all.
 * 2. **declared contextual types** — the answer to "which member does this
 *    object-literal property write?", read off the callee's declared
 *    signatures instead of asked of the checker. This is the pass that keeps
 *    a member run affordable, and the one that falls back when a shape is not
 *    covered.
 * 3. **symbol widening** — the aliases, union constituents, and base-type
 *    members a declaration can also be reached through. Both filing and
 *    querying go through it, which is why an alias never hides a use.
 * 4. **wrapping** — ts-morph wrappers, built only for the nodes a query
 *    returns.
 *
 * Below the class sit the small predicates each pass leans on, then the two
 * entry points: `buildReferenceIndex`, and the cached `referenceIndex`.
 */
interface IndexOptions {
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

class ReferenceIndex {
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
   * Every plain occurrence, grouped by its text and unresolved. Resolving an
   * occurrence types its receiver — for a property access, most of what a run
   * costs — and a name no query ever targets never earns that. `filedNames`
   * marks the texts already resolved into the buckets.
   */
  private readonly occurrencesByText = new Map<string, ts.Node[]>();
  private readonly filedNames = new Set<string>();
  /**
   * The renames between texts: `import { a as b }` links `a` and `b`, a
   * default import links its name to `default`, and so on. Every symbol an
   * occurrence is filed under shares the occurrence's text except across such
   * a rename — and every rename is a piece of syntax the collect walk sees —
   * so a query for a name resolves its whole link closure and nothing else.
   */
  private readonly linkedNames = new Map<string, string[]>();
  /**
   * Contextual occurrences by text, as lazy as the plain ones: working one
   * out types its whole container, and a container full of names no query
   * ever targets — a fixture literal, a third-party config — never gets
   * typed. A site resolves with its text's first query, alongside the plain
   * occurrences of that text.
   */
  private readonly pendingByText = new Map<string, ts.Node[]>();
  /** Spreads inside object literals; few enough to resolve up front. */
  private pendingSpreads: ts.SpreadAssignment[] = [];
  /** Contextual types per container, shared by the spread pass and every lazy site. */
  private readonly contextualTypes = new Map<ts.Node, ts.Type[]>();
  /**
   * Write sites — object-literal properties, computed keys, spread sources,
   * JSX attributes — this index could not attribute to any member: the
   * contextual type was out of reach (an inferred generic, a failed
   * resolution) or was the literal's own inferred type, which proves nothing.
   * A member with zero references but a name in this map may be written
   * through the gap: write-only rather than dead. A spread entry keeps the
   * property symbol it copied, so a copy out of the very member under
   * question can be told apart from a write that feeds somewhere else.
   */
  private readonly unattributedWrites = new Map<string, UnattributedWrite[]>();
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
    for (const sourceFile of project.getSourceFiles()) {
      this.wrappers.set(sourceFile.compilerNode, sourceFile);
      this.collectFile(sourceFile.compilerNode);
    }
    for (const spread of this.pendingSpreads) this.indexSpread(spread, this.contextualTypes);
    this.pendingSpreads = [];
  }

  /** Every reference to the declaration this node names, itself excluded. */
  find(target: Node): Node[] {
    const compilerNode = target.compilerNode;
    const symbol = this.checker.getSymbolAtLocation(compilerNode);
    if (!symbol) return [];

    const found = new Set<ts.Node>();
    for (const related of this.relatedFiled(symbol, propertyName(compilerNode))) {
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
   * One walk over a file: every occurrence goes into its text's group, every
   * rename goes into the link table, and every contextual site waits in the
   * pending queue. No symbol is resolved yet — a plain occurrence resolves
   * when a query first targets its text, or never.
   */
  private collectFile(sourceFile: ts.SourceFile): void {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)) {
        const text = propertyName(node);
        const group = this.occurrencesByText.get(text);
        if (group) group.push(node);
        else this.occurrencesByText.set(text, [node]);
        const parent = node.parent as ts.Node & { name?: ts.Node };
        if (this.members) {
          if (parent.name === node && isMemberDeclarationName(node)) this.memberNames.add(text);
          if (isContextualSite(node)) {
            const sites = this.pendingByText.get(text);
            if (sites) sites.push(node);
            else this.pendingByText.set(text, [node]);
          }
        }
        // A default-modified declaration is reached through `default`.
        if (
          parent.name === node &&
          (ts.getCombinedModifierFlags(parent as ts.Declaration) & ts.ModifierFlags.Default) !== 0
        ) {
          this.linkNames(text, 'default');
        }
      }
      this.collectRename(node);
      if (this.members && ts.isSpreadAssignment(node)) this.pendingSpreads.push(node);
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
  }

  /** The rename this node performs, if it is one of the shapes that rename. */
  private collectRename(node: ts.Node): void {
    if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
      if (node.propertyName) this.linkNames(propertyName(node.propertyName), propertyName(node.name));
    } else if (ts.isImportClause(node)) {
      // A default import names the module's `default` export.
      if (node.name) this.linkNames(node.name.text, 'default');
    } else if (ts.isExportAssignment(node)) {
      if (!node.isExportEquals && ts.isIdentifier(node.expression)) this.linkNames(node.expression.text, 'default');
    } else if (ts.isImportEqualsDeclaration(node) && ts.isEntityName(node.moduleReference)) {
      const target = ts.isQualifiedName(node.moduleReference) ? node.moduleReference.right : node.moduleReference;
      this.linkNames(propertyName(node.name), propertyName(target));
    }
  }

  private linkNames(a: string, b: string): void {
    if (a === b) return;
    const forward = this.linkedNames.get(a);
    if (forward) {
      if (!forward.includes(b)) forward.push(b);
    } else this.linkedNames.set(a, [b]);
    const backward = this.linkedNames.get(b);
    if (backward) {
      if (!backward.includes(a)) backward.push(a);
    } else this.linkedNames.set(b, [a]);
  }

  /**
   * Resolve every occurrence a query for this name may need: the name's own
   * group — contextual sites included, when the name is a declared member —
   * and every name a rename connects it to, transitively, so an alias chain
   * re-exported under new names still lands in the same buckets.
   */
  private ensureFiled(name: string): void {
    if (this.filedNames.has(name)) return;
    const queue = [name];
    for (let current = queue.pop(); current !== undefined; current = queue.pop()) {
      if (this.filedNames.has(current)) continue;
      this.filedNames.add(current);
      for (const node of this.occurrencesByText.get(current) ?? []) this.indexOccurrence(node);
      this.occurrencesByText.delete(current);
      if (this.memberNames.has(current)) {
        for (const site of this.pendingByText.get(current) ?? []) this.indexContextual(site, this.contextualTypes);
        this.pendingByText.delete(current);
      }
      queue.push(...(this.linkedNames.get(current) ?? []));
    }
  }

  private indexOccurrence(node: ts.Node): void {
    const direct = this.checker.getSymbolAtLocation(node);
    if (direct) this.fileUnder(direct, node);

    const parent = node.parent;
    if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
      const value = this.checker.getShorthandAssignmentValueSymbol(parent);
      if (value) this.fileUnder(value, node);
    }

    this.fileDestructuredImport(node);
  }

  /**
   * The export a dynamic import destructured on the spot names.
   *
   * `const { plate } = await import('./recipes')` uses `plate`, and nothing
   * about the occurrence says so: the binding is a symbol of its own, and the
   * link to the declaration lives in the module the pattern reads. Without
   * this the export is reported dead — a false positive, the one kind of
   * mistake this analysis does not make.
   *
   * Reading the pattern's type is a checker question, so `destructuredImport`
   * asks the syntax first and this runs only where the answer is an
   * `import()`. That is why it sits here rather than behind the member gate:
   * it costs a run that asks for no member findings nothing at all.
   */
  private fileDestructuredImport(node: ts.Node): void {
    const element = node.parent;
    if (!ts.isBindingElement(element)) return;
    // `{ plate }` names the export through `name`, `{ plate: dish }` through
    // `propertyName`. The other one is the local binding, which names nothing.
    if ((element.propertyName ?? element.name) !== node) return;
    if (!destructuredImport(element.parent)) return;
    const module = safely(() => this.checker.getTypeAtLocation(element.parent));
    this.fileProperties(module ? [module] : [], node);
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
    // A string-literal computed key writes the member it spells out.
    const assignment = ts.isComputedPropertyName(parent) ? parent.parent : parent;
    if (
      (ts.isPropertyAssignment(assignment) ||
        ts.isShorthandPropertyAssignment(assignment) ||
        ts.isMethodDeclaration(assignment)) &&
      ts.isObjectLiteralExpression(assignment.parent)
    ) {
      const types = this.attributableTypes(assignment.parent, contextualTypes);
      const filed = this.fileProperties(types, node);
      if (!filed) this.recordUnattributedWrite(propertyName(node), node, undefined, isConcreteKnowledge(types));
    } else if (ts.isBindingElement(parent)) {
      const pattern = safely(() => this.checker.getTypeAtLocation(parent.parent));
      this.fileProperties(pattern ? [pattern] : [], node);
    } else if (ts.isJsxAttribute(parent)) {
      const types = this.attributableTypes(parent.parent, contextualTypes);
      const filed = this.fileProperties(types, node);
      if (!filed) this.recordUnattributedWrite(propertyName(node), node, undefined, isConcreteKnowledge(types));
    }
  }

  /**
   * A spread writes every member its source carries into the containing
   * literal. A spread is a copy, not authored use, so nothing files as a
   * reference — but a project-declared name carried into a literal whose
   * contextual type is out of reach is a write no reference will ever land
   * on (`{ ...base }` feeding an inference-typed provider value), and it
   * goes into the unattributed-write map with its source symbol.
   */
  private indexSpread(spread: ts.SpreadAssignment, contextualTypes: Map<ts.Node, ts.Type[]>): void {
    const source = safely(() => this.checker.getTypeAtLocation(spread.expression));
    if (!source) return;
    const carried = this.checker.getPropertiesOfType(source).filter(symbol => this.memberNames.has(symbol.name));
    if (carried.length === 0) return;

    const types = this.attributableTypes(spread.parent, contextualTypes);
    const known = isConcreteKnowledge(types);
    for (const symbol of carried) {
      const attributed = types.some(type => this.propertiesOf(type, symbol.name).length > 0);
      if (!attributed) this.recordUnattributedWrite(symbol.name, spread, symbol, known);
    }
  }

  /** True when at least one member symbol took the occurrence. */
  private fileProperties(types: ts.Type[], node: ts.Node): boolean {
    const name = propertyName(node);
    let filed = false;
    for (const type of types) {
      for (const symbol of this.propertiesOf(type, name)) {
        this.fileUnder(symbol, node);
        filed = true;
      }
    }
    return filed;
  }

  /**
   * The container's contextual types, minus the container's own inferred type.
   * An inference-typed literal (`useMemo(() => ({ … }))` with no type
   * argument) answers the contextual-type question with itself; attributing a
   * write to the very literal that makes it is circular evidence, so such a
   * type proves nothing and the write counts as unattributed.
   */
  private attributableTypes(container: ts.Node, cache: Map<ts.Node, ts.Type[]>): ts.Type[] {
    return this.contextualTypesOf(container as ts.Expression, cache).filter(
      type => !(type.symbol?.declarations ?? []).some(decl => isInside(decl, container))
    );
  }

  private recordUnattributedWrite(
    name: string,
    site: ts.Node,
    source: ts.Symbol | undefined,
    knownDifferent: boolean
  ): void {
    const entry = { site, source, knownDifferent };
    const entries = this.unattributedWrites.get(name);
    if (entries) entries.push(entry);
    else this.unattributedWrites.set(name, [entry]);
  }

  /**
   * The write sites of this member's name that no member could be charged
   * with, each validated against the type its value feeds:
   * - `typed` — the value provably flows into a use whose contextual type
   *   declares this very member. The write is proven; only a read is missing.
   * - `accounted` — the site writes some other type: its contextual type was
   *   known and lacks the member, its own literal property is read as itself,
   *   every use of its value lands on concrete types unrelated to this
   *   member, or the literal's shape could never be the member's owner in the
   *   first place. No evidence against `dead`.
   * - `unverified` — a bare name match the analysis could not type either way.
   * A spread that copied the value of this very member is dropped outright:
   * reads through the copy resolve back to the member, so the copy hides
   * nothing. Empty `typed` and `unverified` together are the axiom the dead
   * verdict rests on.
   */
  unattributedWriteSites(name: string, member?: Node): WriteSites {
    // The write sites of this name record when its sites resolve.
    this.ensureFiled(name);
    const entries = this.unattributedWrites.get(name) ?? [];
    // The common case: no write of the name exists, and no symbol work is owed.
    if (entries.length === 0) return { typed: [], accounted: [], unverified: [] };
    const sites = { typed: [] as ts.Node[], accounted: [] as ts.Node[], unverified: [] as ts.Node[] };
    const memberSymbol = member && this.checker.getSymbolAtLocation(member.compilerNode);
    const own = memberSymbol && {
      symbols: new Set(this.relatedSymbols(memberSymbol)),
      type: this.ownerTypeOf(memberSymbol),
    };
    for (const entry of entries) {
      // The member's own declaration site is the finding, not evidence for it.
      if (member && entry.site === member.compilerNode) continue;
      if (entry.source && own && this.relatedSymbols(entry.source).some(s => own.symbols.has(s))) continue;
      sites[this.classifyWrite(entry, name, own)].push(entry.site);
    }
    const wrapSorted = (nodes: ts.Node[]): Node[] =>
      nodes
        .sort((a, b) => a.getSourceFile().fileName.localeCompare(b.getSourceFile().fileName) || a.pos - b.pos)
        .map(node => this.wrap(node));
    return {
      typed: wrapSorted(sites.typed),
      accounted: wrapSorted(sites.accounted),
      unverified: wrapSorted(sites.unverified),
    };
  }

  /**
   * The rule that keeps a name match from becoming a claim: every site is
   * validated against the type its value feeds. Known and same — the member's
   * owner — proves the write. Known and different discards the site, and so
   * does a shape the owner could never take. Only a site the checker cannot
   * type either way stays a heuristic, and it says so.
   */
  private classifyWrite(
    entry: UnattributedWrite,
    name: string,
    own: Owner | undefined
  ): 'typed' | 'accounted' | 'unverified' {
    // The contextual type was known when the write was indexed, and it does
    // not declare the name: the write feeds that type, not this member.
    if (entry.knownDifferent) return 'accounted';
    const literal = containingObjectLiteral(entry.site);
    if (!literal) return 'unverified';
    const ownProperty = safely(() => this.checker.getPropertyOfType(this.checker.getTypeAtLocation(literal), name));
    if (!ownProperty) return 'unverified';

    // Where does the literal's value end up? A destination type that declares
    // this member proves the write; checked first, because a proven write
    // must win over every reason to discard the site.
    const destinations = own ? this.destinationsOfLiteral(literal, name, ownProperty) : NO_DESTINATIONS;
    if (own) {
      for (const type of destinations.types) {
        if (this.propertiesOf(type, name).some(p => this.relatedSymbols(p).some(s => own.symbols.has(s)))) {
          return 'typed';
        }
      }
    }

    // Something reads the literal's own property — through destructuring, a
    // property access, the inferred type. That write belongs to a living
    // member of its own shape; sharing a name with this one proves nothing.
    if (this.hasReadsBesides(ownProperty, entry.site)) return 'accounted';

    // Every use of the value has a concrete type and none declares the
    // member: the write cannot reach it.
    if (destinations.conclusive) return 'accounted';

    // The value never left the shapes the walk could see, and the last of
    // them is a callee that types the position from the value itself. What
    // that callee holds is this literal's own shape — and the checker would
    // reject that shape where the member's owner is expected, so no read
    // through the owner can ever see this write.
    if (destinations.bounded && own?.type && this.cannotBeShapeOf(literal, own.type)) return 'accounted';
    return 'unverified';
  }

  /**
   * The type a member belongs to: the instance type of its class or
   * interface, or the type of the literal it sits in. Unknown for anything
   * else — a constructor parameter property, an enum — and the shape rule
   * stays out of those.
   */
  private ownerTypeOf(symbol: ts.Symbol): ts.Type | undefined {
    const owner = symbol.declarations?.[0]?.parent;
    if (!owner) return undefined;
    if (ts.isClassLike(owner) || ts.isInterfaceDeclaration(owner)) {
      const name = owner.name;
      const ownerSymbol = name && safely(() => this.checker.getSymbolAtLocation(name));
      return ownerSymbol && safely(() => this.checker.getDeclaredTypeOfSymbol(ownerSymbol));
    }
    if (ts.isTypeLiteralNode(owner) || ts.isObjectLiteralExpression(owner)) {
      return safely(() => this.checker.getTypeAtLocation(owner));
    }
    return undefined;
  }

  /** True when the checker would reject this literal where the owner is expected. */
  private cannotBeShapeOf(literal: ts.ObjectLiteralExpression, ownerType: ts.Type): boolean {
    const literalType = safely(() => this.checker.getTypeAtLocation(literal));
    if (!literalType) return false;
    return safely(() => !this.checker.isTypeAssignableTo(literalType, ownerType)) ?? false;
  }

  /**
   * True when an indexed occurrence beyond the write site itself *reads* the
   * property: a property access, a destructuring binding, an element access.
   * Declarations and other writes of the property do not count — the question
   * is whether the value is consumed, not whether the name exists elsewhere.
   */
  private hasReadsBesides(property: ts.Symbol, site: ts.Node): boolean {
    for (const related of this.relatedFiled(property, property.name)) {
      for (const node of this.buckets.get(related) ?? []) {
        if (node !== site && isReadOccurrence(node)) return true;
      }
    }
    return false;
  }

  /**
   * The types the literal's value is used as, found by following the value:
   * through parentheses, out of the factory the literal is returned from —
   * inline (`useMemo(() => ({ … }))`) or named (`function build() { return
   * { … } }`, followed to every direct call site) — into the variable that
   * holds the result, across `const b = a` aliases, and finally to the
   * contextual type at each use. A factory's declared return type ends the
   * walk on the spot: every caller reads the result as exactly that type.
   * Every other hop is verified by symbol identity: the carrier's type must
   * hold the literal's own property, so a wrapper that returns something else
   * cannot smuggle a wrong type in. The walk is bounded by MAX_FLOW_HOPS so
   * equivalent shapes converge without risking a runaway. `conclusive` means
   * every use was typed and concrete; one untyped or `any`/`unknown` use, and
   * the value escapes where the analysis cannot follow.
   */
  private destinationsOfLiteral(
    literal: ts.ObjectLiteralExpression,
    name: string,
    ownProperty: ts.Symbol
  ): Destinations {
    return this.destinationsOfExpression(literal, name, ownProperty, MAX_FLOW_HOPS);
  }

  private destinationsOfExpression(start: ts.Node, name: string, ownProperty: ts.Symbol, hops: number): Destinations {
    if (hops <= 0) return NO_DESTINATIONS;
    let expression: ts.Node = start;
    for (;;) {
      const parent: ts.Node | undefined = expression.parent;
      if (!parent) return NO_DESTINATIONS;
      if (ts.isParenthesizedExpression(parent)) {
        expression = parent;
        continue;
      }
      const factory = ts.isReturnStatement(parent)
        ? enclosingFunction(parent)
        : ts.isArrowFunction(parent) && parent.body === expression
          ? parent
          : undefined;
      if (factory) {
        // A declared return type answers the whole question: whatever the
        // call sites do, they read the result as that type and nothing else.
        const annotated = this.annotatedReturn(factory);
        if (annotated) return annotated;

        const holder = factory.parent;
        if (ts.isCallExpression(holder) && holder.arguments.includes(factory as ts.Expression)) {
          // An inline factory whose call hands the value back — `useMemo`,
          // `wrap` — carries the walk on to the call's own destinations.
          if (this.carriesProperty(holder, name, ownProperty)) {
            expression = holder;
            continue;
          }
          // The call consumes the factory instead: `useImperativeHandle(ref,
          // () => ({ … }))`. Nothing comes back, so the argument position is
          // the last stop.
          return this.argumentDestination(factory);
        }
        // A named factory: every direct call of it returns the value.
        const factoryName =
          ts.isFunctionDeclaration(factory) && factory.name
            ? factory.name
            : ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)
              ? holder.name
              : undefined;
        if (!factoryName) return NO_DESTINATIONS;
        return this.destinationsOfFactoryCalls(factoryName, name, ownProperty, hops - 1);
      }
      if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
        const args: readonly ts.Expression[] = parent.arguments ?? [];
        if (args.includes(expression as ts.Expression)) return this.argumentDestination(expression);
      }
      if (ts.isVariableDeclaration(parent) && parent.initializer === expression && ts.isIdentifier(parent.name)) {
        if (!this.carriesProperty(parent.name, name, ownProperty)) return NO_DESTINATIONS;
        return this.destinationsOfVariable(parent.name, name, ownProperty, hops - 1);
      }
      return NO_DESTINATIONS;
    }
  }

  /**
   * The factory's declared return type, when it has one. An annotation is a
   * complete answer — no call site can read the result as anything else — so
   * the walk stops there. An `any` or `unknown` annotation is no answer at
   * all: the value escapes into it.
   */
  private annotatedReturn(factory: ts.Node): Destinations | undefined {
    const typeNode = (factory as ts.SignatureDeclaration).type;
    if (!typeNode) return undefined;
    const type = safely(() => this.checker.getTypeAtLocation(typeNode));
    if (!type) return undefined;
    return isConcreteKnowledge([type]) ? { types: [type], conclusive: true, bounded: true } : NO_DESTINATIONS;
  }

  /**
   * What an argument position tells us about a value the call consumes. When
   * the checker types that position from the argument itself — a generic
   * parameter inferred from the value, the shape `useImperativeHandle` gives
   * its factory — the answer is circular and adds no type. It does say
   * something, though: the callee sees this value's own shape and nothing
   * wider, so nothing escaped the walk. Any other position the checker could
   * not resolve is a real escape.
   */
  private argumentDestination(argument: ts.Node): Destinations {
    const contextual = safely(() => this.checker.getContextualType(argument as ts.Expression));
    if (!contextual) return NO_DESTINATIONS;
    const types = ts.isFunctionLike(argument)
      ? contextual.getCallSignatures().map(signature => this.checker.getReturnTypeOfSignature(signature))
      : [contextual];
    const fromValue =
      types.length > 0 && types.every(type => (type.symbol?.declarations ?? []).some(decl => isInside(decl, argument)));
    return fromValue ? OWN_SHAPE_ONLY : NO_DESTINATIONS;
  }

  /** True when this node's type holds the very property symbol in question. */
  private carriesProperty(node: ts.Node, name: string, ownProperty: ts.Symbol): boolean {
    const type = safely(() => this.checker.getTypeAtLocation(node));
    const carried = type && safely(() => this.checker.getPropertyOfType(type, name));
    if (!carried) return false;
    const carriedSet = new Set(this.relatedSymbols(carried));
    return this.relatedSymbols(ownProperty).some(s => carriedSet.has(s));
  }

  /** The union of destinations across every direct call of a named factory. */
  private destinationsOfFactoryCalls(
    factoryName: ts.Identifier,
    name: string,
    ownProperty: ts.Symbol,
    hops: number
  ): Destinations {
    const symbol = safely(() => this.checker.getSymbolAtLocation(factoryName));
    if (!symbol) return NO_DESTINATIONS;
    let destinations = NOTHING_SEEN;
    const seen = new Set<ts.Node>([factoryName]);
    for (const related of this.relatedFiled(symbol, factoryName.text)) {
      for (const ref of this.buckets.get(related) ?? []) {
        if (seen.has(ref)) continue;
        seen.add(ref);
        // A specifier only forwards the name; the uses behind it are indexed too.
        if (ts.isImportSpecifier(ref.parent) || ts.isExportSpecifier(ref.parent)) continue;
        const call = ref.parent;
        if (!ts.isCallExpression(call) || call.expression !== ref || !this.carriesProperty(call, name, ownProperty)) {
          // The factory itself escapes — passed around, aliased — and the
          // value can surface anywhere; not followable.
          destinations = merge(destinations, NO_DESTINATIONS);
          continue;
        }
        destinations = merge(destinations, this.destinationsOfExpression(call, name, ownProperty, hops));
      }
    }
    return destinations;
  }

  /** The contextual type at every indexed use of the variable, following `const b = a` aliases. */
  private destinationsOfVariable(
    nameNode: ts.Identifier,
    name: string,
    ownProperty: ts.Symbol,
    hops: number
  ): Destinations {
    const symbol = safely(() => this.checker.getSymbolAtLocation(nameNode));
    if (!symbol) return NO_DESTINATIONS;
    let destinations = NOTHING_SEEN;
    const seen = new Set<ts.Node>([nameNode]);
    for (const related of this.relatedFiled(symbol, nameNode.text)) {
      for (const ref of this.buckets.get(related) ?? []) {
        if (seen.has(ref)) continue;
        seen.add(ref);
        // A specifier only forwards the name; the uses behind it are indexed too.
        if (ts.isImportSpecifier(ref.parent) || ts.isExportSpecifier(ref.parent)) continue;
        // `const b = a` hands the value to another variable; follow it.
        if (
          hops > 0 &&
          ts.isVariableDeclaration(ref.parent) &&
          ref.parent.initializer === ref &&
          ts.isIdentifier(ref.parent.name) &&
          this.carriesProperty(ref.parent.name, name, ownProperty)
        ) {
          destinations = merge(destinations, this.destinationsOfVariable(ref.parent.name, name, ownProperty, hops - 1));
          continue;
        }
        const contextual = safely(() => this.checker.getContextualType(ref as ts.Expression));
        if (!contextual || !isConcreteKnowledge([contextual])) {
          // The use is untyped — but a call that types the position from the
          // value itself still holds nothing wider than this value's shape.
          const consumed = ts.isCallExpression(ref.parent) && ref.parent.arguments.includes(ref as ts.Expression);
          destinations = merge(destinations, consumed ? this.argumentDestination(ref) : NO_DESTINATIONS);
          continue;
        }
        destinations = merge(destinations, { types: [contextual], conclusive: true, bounded: true });
      }
    }
    return destinations;
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
    for (const [i, arg] of call.arguments.entries()) {
      if (i > index) break;
      if (ts.isSpreadElement(arg)) return undefined;
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
      const step = steps[i]!;
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
   * The related symbols with their buckets guaranteed filled: every bucket
   * read goes through here. The query's own text covers the rename closure;
   * each related symbol's name is insurance against a rename the collect walk
   * has no shape for. Resolving a name no occurrence carries costs nothing.
   */
  private relatedFiled(symbol: ts.Symbol, text: string): ts.Symbol[] {
    this.ensureFiled(text);
    const related = this.relatedSymbols(symbol);
    for (const each of related) this.ensureFiled(each.name);
    return related;
  }

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

/** A write no member could be charged with; spreads keep the copied symbol. */
interface UnattributedWrite {
  site: ts.Node;
  source?: ts.Symbol | undefined;
  /** The contextual types were known and concrete, and none declares the name. */
  knownDifferent: boolean;
}

/** Unattributed writes of one name, validated site by site. */
interface WriteSites {
  /** The value provably feeds the member's owner. Written, never read. */
  typed: Node[];
  /** The write belongs to some other, known type. No evidence against `dead`. */
  accounted: Node[];
  /** A bare name match the analysis could not type either way. */
  unverified: Node[];
}

/** The member under question: every symbol it can be reached through, and the shape it belongs to. */
interface Owner {
  symbols: Set<ts.Symbol>;
  /** The owner's type, where there is one to have. Undefined turns the shape rule off. */
  type?: ts.Type | undefined;
}

/** Where a value ends up. */
interface Destinations {
  types: ts.Type[];
  /** Every use was typed and concrete. */
  conclusive: boolean;
  /**
   * Nothing escaped: every use was typed and concrete, or handed the value to
   * a callee that types the position from the value itself and so holds
   * nothing wider than the value's own shape.
   */
  bounded: boolean;
}

/** The value went somewhere the analysis cannot follow. */
const NO_DESTINATIONS: Destinations = { types: [], conclusive: false, bounded: false };
/** The value was consumed as its own shape: no type learned, nothing lost. */
const OWN_SHAPE_ONLY: Destinations = { types: [], conclusive: false, bounded: true };
/** The empty start of a fold over uses: a value with no uses lost nothing. */
const NOTHING_SEEN: Destinations = { types: [], conclusive: true, bounded: true };

function merge(a: Destinations, b: Destinations): Destinations {
  return {
    types: [...a.types, ...b.types],
    conclusive: a.conclusive && b.conclusive,
    bounded: a.bounded && b.bounded,
  };
}

/** How many value hops the flow proof follows before giving up. */
const MAX_FLOW_HOPS = 4;

/**
 * True when this reference fills the member in rather than reading it: an
 * object-literal property, a computed key, a JSX attribute. A contextual site
 * is one the type system matched to a member, and every one of them writes
 * except the destructuring, which reads.
 */
export function isWriteReference(reference: Node): boolean {
  const node = reference.compilerNode;
  return isInPlaceWrite(node) || (!isReadOccurrence(node) && isContextualSite(node));
}

/** True when this reference consumes the member: a property access, an index, a destructuring. */
export function isReadReference(reference: Node): boolean {
  return isReadOccurrence(reference.compilerNode);
}

/** True when this occurrence consumes the property rather than declaring or writing it. */
function isReadOccurrence(node: ts.Node): boolean {
  // A property access is how the code reads a member and also how it writes
  // one in place. The two look alike from here, so the assignment around it
  // is what tells them apart.
  if (isInPlaceWrite(node)) return false;
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && (parent.propertyName ?? parent.name) === node) return true;
  return ts.isElementAccessExpression(parent) && parent.argumentExpression === node;
}

/**
 * Types that count as knowledge: at least one, and no `any` or `unknown`
 * part. A write into `unknown` proves nothing about where the value is read.
 */
function isConcreteKnowledge(types: ts.Type[]): boolean {
  return (
    types.length > 0 &&
    types.every(type => partsOf(type).every(part => (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0))
  );
}

/**
 * True when this binding pattern destructures a dynamic import.
 *
 * Two shapes reach the module that way: `const { plate } = await import(…)`,
 * where the pattern is the variable's own, and `import(…).then(({ plate }) => …)`,
 * where it is the callback's parameter. Binding the module first —
 * `const box = await import(…)`, then `box.plate` — needs nothing here: the
 * property access is an ordinary reference.
 */
function destructuredImport(pattern: ts.Node): boolean {
  if (!ts.isObjectBindingPattern(pattern)) return false;
  const owner = pattern.parent;
  if (ts.isVariableDeclaration(owner)) return isImportCall(owner.initializer);
  if (!ts.isParameter(owner) || !ts.isFunctionLike(owner.parent)) return false;
  const call = owner.parent.parent;
  if (!call || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return false;
  return call.expression.name.text === 'then' && isImportCall(call.expression.expression);
}

/** `import('…')`, through an `await` when there is one. */
function isImportCall(expression: ts.Node | undefined): boolean {
  if (!expression) return false;
  const inner = ts.isAwaitExpression(expression) ? expression.expression : expression;
  return ts.isCallExpression(inner) && inner.expression.kind === ts.SyntaxKind.ImportKeyword;
}

/** The object literal a write site sits in: its type owns the written property. */
function containingObjectLiteral(site: ts.Node): ts.ObjectLiteralExpression | undefined {
  if (ts.isSpreadAssignment(site)) {
    return ts.isObjectLiteralExpression(site.parent) ? site.parent : undefined;
  }
  const assignment = ts.isComputedPropertyName(site.parent) ? site.parent.parent : site.parent;
  const literal = assignment?.parent;
  return literal !== undefined && ts.isObjectLiteralExpression(literal) ? literal : undefined;
}

/** The function a return statement returns from. */
function enclosingFunction(statement: ts.Node): ts.Node | undefined {
  let node: ts.Node | undefined = statement.parent;
  while (node && !ts.isFunctionLike(node)) node = node.parent;
  return node;
}

interface WrappingSourceFile {
  _getNodeFromCompilerNode(compilerNode: ts.Node): Node;
}

function propertyName(name: ts.Node): string {
  // Cooked text, the form symbol names take — not raw source with escapes.
  return (name as Partial<ts.Identifier>).text ?? name.getText();
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

/** True when `node` sits at or inside `container` in the same file. */
export function isInside(node: ts.Node, container: ts.Node): boolean {
  return node.getSourceFile() === container.getSourceFile() && node.pos >= container.pos && node.end <= container.end;
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

/**
 * True when this occurrence writes the member in place: `shelf.count = 1`, or
 * an update whose old value goes nowhere but straight back in — `shelf.count
 * += 1`, `shelf.count++` standing as a statement of its own.
 *
 * The old value of an update is read, and that is the point: it is read to
 * write it again, and no one else ever sees it. Where someone does —
 * `const n = shelf.count++` hands the value on — this is a read like any
 * other.
 */
function isInPlaceWrite(node: ts.Node): boolean {
  const access = node.parent;
  if (ts.isPropertyAccessExpression(access)) {
    if (access.name !== node) return false;
  } else if (ts.isElementAccessExpression(access)) {
    if (access.argumentExpression !== node) return false;
  } else {
    return false;
  }

  const around = access.parent;
  if (ts.isBinaryExpression(around) && around.left === access) {
    const operator = around.operatorToken.kind;
    return operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment;
  }
  if (
    (ts.isPostfixUnaryExpression(around) || ts.isPrefixUnaryExpression(around)) &&
    around.operand === access &&
    (around.operator === ts.SyntaxKind.PlusPlusToken || around.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return valueGoesNowhere(around);
  }
  return false;
}

/** True where an expression's value is dropped: a statement of its own, a `for` update. */
function valueGoesNowhere(node: ts.Node): boolean {
  const parent = node.parent;
  return ts.isExpressionStatement(parent) || (ts.isForStatement(parent) && parent.incrementor === node);
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
  // A computed key with a literal name: `{ ['foo']: … }` writes `foo`.
  if (ts.isComputedPropertyName(parent) && ts.isStringLiteralLike(node)) {
    const assignment = parent.parent;
    return (
      (ts.isPropertyAssignment(assignment) || ts.isMethodDeclaration(assignment)) &&
      ts.isObjectLiteralExpression(assignment.parent)
    );
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

/**
 * The private ts-morph member `wrap` calls, checked once before the first
 * query. It is the one place a ts-morph upgrade can break this index, and a
 * cast fails deep inside a walk — hours in, with a message about `undefined`.
 * Asked here, the same break says its own name before any work starts.
 */
function checkWrappingApi(project: Project): void {
  const sourceFile = project.getSourceFiles()[0] as Partial<WrappingSourceFile> | undefined;
  if (sourceFile && typeof sourceFile._getNodeFromCompilerNode !== 'function') {
    throw new Error(
      'this ts-morph release no longer exposes SourceFile._getNodeFromCompilerNode, which the reference index needs'
    );
  }
}

/** Build the index this run needs and hand it to every later query. */
export function buildReferenceIndex(project: Project, options: IndexOptions): ReferenceIndex {
  checkWrappingApi(project);
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
