import type {
  ArrowFunction,
  ElementAccessExpression,
  FunctionDeclaration,
  FunctionExpression,
  Identifier,
  MethodDeclaration,
  Node,
  ParameterDeclaration,
  Project,
  Type,
} from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import { forEachDescendantOfKinds } from '../lookup/descendants';
import { isWriteAccess } from '../lookup/reference-index';
import { fileComputedKey, findReferencesAsNodes } from '../lookup/references';
import { callTo, getCallableNameNode } from './escape';

/**
 * Project-wide index of types whose keys are consumed dynamically. When a value
 * flows into a key-enumerating or serializing sink — Object.keys, for…in,
 * JSON.stringify — its properties are read without per-property references, so
 * reference counts for that type can't be trusted.
 *
 * `throw` is the same fact told the shortest way. The value leaves the call
 * stack for whoever catches it, `catch (error)` types that value `unknown`,
 * and every property the catcher reads is a read no reference search will ever
 * find. An error object a library builds for its callers to read is a whole
 * idiom shaped like that.
 *
 * A sink reached through a helper counts the same. `dump(recipe)` is as
 * dynamic as `Object.keys(recipe)` when `dump` is the function that calls it,
 * so the index follows a relaying parameter back to its call sites.
 */
export interface DynamicConsumptionIndex {
  /** Type declarations (interfaces, aliases, type literals) to skip entirely. */
  suppressed: Set<Node>;
  /** Per-declaration property names probed by a literal `'name' in v` check. */
  probed: Map<Node, Set<string>>;
}

/** The callables a parameter can belong to and still be reached by an argument. */
type FunctionLike = FunctionDeclaration | ArrowFunction | FunctionExpression | MethodDeclaration;

const OBJECT_KEY_CONSUMERS = new Set(['keys', 'values', 'entries', 'getOwnPropertyNames', 'assign']);

/** The only kinds the walk below acts on; one raw pass finds them all. */
const CONSUMING_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.CallExpression,
  SyntaxKind.ForInStatement,
  SyntaxKind.BinaryExpression,
  SyntaxKind.ElementAccessExpression,
  SyntaxKind.ThrowStatement,
]);

/** How far into a union, intersection, or array the walk unwraps a type. */
const MAX_TYPE_DEPTH = 3;

export function buildDynamicConsumptionIndex(project: Project): DynamicConsumptionIndex {
  const suppressed = new Set<Node>();
  const probed = new Map<Node, Set<string>>();
  // Parameters that carried a value into a sink. What their callers hand in is
  // read for its keys just as surely, and only the call site knows what that is.
  const relaying = new Set<ParameterDeclaration>();

  for (const sourceFile of project.getSourceFiles()) {
    if (sourceFile.isDeclarationFile()) continue;
    forEachDescendantOfKinds(sourceFile, CONSUMING_KINDS, node => {
      if (node.isKind(SyntaxKind.CallExpression)) {
        if (isKeyConsumingCall(node)) {
          for (const arg of node.getArguments()) consumed(arg, suppressed, relaying);
        }
        return;
      }
      if (node.isKind(SyntaxKind.ForInStatement) || node.isKind(SyntaxKind.ThrowStatement)) {
        consumed(node.getExpression(), suppressed, relaying);
        return;
      }
      if (node.isKind(SyntaxKind.ElementAccessExpression)) {
        indexedByKey(node, suppressed, probed, relaying);
        return;
      }
      if (node.isKind(SyntaxKind.BinaryExpression) && node.getOperatorToken().getKind() === SyntaxKind.InKeyword) {
        const left = node.getLeft();
        if (left.isKind(SyntaxKind.StringLiteral)) {
          addProbe(node.getRight().getType(), left.getLiteralValue(), probed);
        } else {
          consumed(node.getRight(), suppressed, relaying);
        }
      }
    });
  }

  suppressThroughCallers(relaying, suppressed);
  return { suppressed, probed };
}

/**
 * A member read through a key the source does not spell out: `manifest[section]`.
 *
 * The key's type says how much is in reach. A union of string literals names
 * exactly those members and leaves the rest of the type answerable, the way a
 * `'name' in v` probe does. A string the type cannot pin down reaches every
 * member, and the whole type goes quiet. An index that is a number names no
 * member at all, which is most of these and costs nothing to pass over.
 */
function indexedByKey(
  access: ElementAccessExpression,
  suppressed: Set<Node>,
  probed: Map<Node, Set<string>>,
  relaying: Set<ParameterDeclaration>
): void {
  const argument = access.getArgumentExpression();
  // A key written out is a reference to that member; the search finds it
  // already. A number reaches nothing named.
  if (!argument || argument.isKind(SyntaxKind.StringLiteral) || argument.isKind(SyntaxKind.NumericLiteral)) return;

  const names = keyNames(argument.getType());
  if (names === undefined) return;
  if (names.length === 0) {
    consumed(access.getExpression(), suppressed, relaying);
    return;
  }
  const target = access.getExpression().getType();
  // A key that fills the member in is a write, and reading it as a read would
  // hide a member the code only ever assigns. The site names its members as
  // surely as a written-out key does, so it is filed as one of them and the
  // ordinary read-or-write rules take it from there.
  if (isWriteAccess(access)) {
    fileComputedKey(argument, target, names);
    return;
  }
  for (const name of names) addProbe(target, name, probed);
}

/**
 * The members this key can name: the literals when the type pins them down,
 * an empty list when it is a string it cannot, and nothing at all when the key
 * is a number, which reaches no member by name.
 */
function keyNames(type: Type): string[] | undefined {
  const names: string[] = [];
  for (const part of type.isUnion() ? type.getUnionTypes() : [type]) {
    if (part.isStringLiteral()) {
      names.push(String(part.getLiteralValue()));
      continue;
    }
    if (part.isNumber() || part.isNumberLiteral()) continue;
    return [];
  }
  return names.length > 0 ? names : undefined;
}

/**
 * A value read for its keys. Its own type is skipped — and when the value is a
 * parameter, the function it belongs to is a relay: it does this to whatever
 * it is handed, not only to what the sink can see here.
 */
function consumed(value: Node, suppressed: Set<Node>, relaying: Set<ParameterDeclaration>): void {
  addTypeDeclarations(value.getType(), suppressed);
  const parameter = parameterBehind(value);
  if (parameter) relaying.add(parameter);
}

/**
 * Follow every relay out to its call sites, and skip the types the callers
 * hand in.
 *
 * `function dump<T>(o: T) { return Object.keys(o) }` reads the keys of
 * whatever it is given, but the sink standing inside it sees only `T`. The
 * concrete type never gets there: `dump(recipe)` is where `Recipe` becomes
 * untrackable, so that is where this looks.
 *
 * A caller that forwards its own parameter is a relay in turn, and the walk
 * keeps going until it finds no new one. Each parameter is followed once,
 * which is what ends it.
 *
 * A relay answers to every name it is given, so `const scan = dump` and
 * `const kit = { scan: dump }` are followed as well. The calls behind the
 * second name hand in values just the same, and the sink at the far end reads
 * them all.
 */
function suppressThroughCallers(relaying: Set<ParameterDeclaration>, suppressed: Set<Node>): void {
  const pending = [...relaying];
  for (let parameter = pending.pop(); parameter; parameter = pending.pop()) {
    const owner = callableOwner(parameter);
    if (!owner) continue;
    const nameNode = getCallableNameNode(owner);
    if (!nameNode) continue;
    const position = owner.getParameters().indexOf(parameter);
    const rest = parameter.isRestParameter();
    const names = [nameNode];
    const found = new Set(names);
    for (let name = names.pop(); name; name = names.pop()) {
      for (const ref of findReferencesAsNodes(name)) {
        const call = callTo(ref);
        if (!call) {
          // Handed on as a value instead of called. Nothing here says which
          // values will arrive, but the position it lands in does — and a
          // binding that takes the relay under a new name carries it on.
          for (const type of contextualParameterTypes(ref, position, rest)) addTypeDeclarations(type, suppressed);
          const renamed = secondName(ref);
          if (renamed && !found.has(renamed)) {
            found.add(renamed);
            names.push(renamed);
          }
          continue;
        }
        const args = call.getArguments();
        // A rest parameter collects every argument from its position on.
        const handed = rest ? args.slice(position) : args.slice(position, position + 1);
        for (const value of handed) {
          addTypeDeclarations(value.getType(), suppressed);
          const forwarded = parameterBehind(value);
          if (forwarded && !relaying.has(forwarded)) {
            relaying.add(forwarded);
            pending.push(forwarded);
          }
        }
      }
    }
  }
}

/**
 * The second name this reference gives the relay: the `scan` of
 * `const scan = dump`, and the one of `const kit = { scan: dump }`.
 *
 * Whether the holder declares a type is beside the point, and that is the
 * whole reason to read the name rather than the annotation. An annotation says
 * what the relay accepts — `(o: object) => string[]`, wide by construction,
 * since a relay takes whatever it is handed. The concrete type the sink will
 * read is written at the call sites, and those are behind the new name.
 */
function secondName(reference: Node): Identifier | undefined {
  const holder = reference.getParent();
  // A shorthand names the relay with the reference itself; the calls through
  // it resolve to the property, not to the function it was written from.
  if (holder?.isKind(SyntaxKind.ShorthandPropertyAssignment)) return holder.getNameNode();
  if (holder?.isKind(SyntaxKind.VariableDeclaration) || holder?.isKind(SyntaxKind.PropertyAssignment)) {
    if (holder.getInitializer() !== reference) return undefined;
    const name = holder.getNameNode();
    return name.isKind(SyntaxKind.Identifier) ? name : undefined;
  }
  return undefined;
}

/**
 * What will reach a relaying parameter of a function handed on as a value.
 *
 * `rows.forEach(dump)` never writes an argument down, so there is nothing at
 * the site to read. The position does the talking: `forEach` wants
 * `(value: Row, …) => void`, so `Row` is what the relay will be given, one
 * element at a time. The same holds anywhere a function type is expected — a
 * declared callback property, an annotated return — which is why this asks the
 * contextual type rather than the shape of the call.
 *
 * Nothing propagates from here. What arrives is a type, not a value, so there
 * is no caller's parameter behind it to make a relay in turn.
 */
function contextualParameterTypes(reference: Node, position: number, rest: boolean): Type[] {
  if (!reference.isKind(SyntaxKind.Identifier)) return [];
  const expected = reference.getContextualType();
  if (!expected) return [];

  const types: Type[] = [];
  for (const signature of expected.getCallSignatures()) {
    const parameters = signature.getParameters();
    for (const parameter of rest ? parameters.slice(position) : parameters.slice(position, position + 1)) {
      types.push(parameter.getTypeAtLocation(reference));
    }
  }
  return types;
}

/** The parameter this expression names, when it names one. */
function parameterBehind(value: Node): ParameterDeclaration | undefined {
  if (!value.isKind(SyntaxKind.Identifier)) return undefined;
  const declaration = value.getSymbol()?.getValueDeclaration();
  return declaration?.isKind(SyntaxKind.Parameter) ? declaration : undefined;
}

/**
 * The function this parameter belongs to, when it is one a call can reach. A
 * signature without a body declares a shape; no argument ever lands in it.
 */
function callableOwner(parameter: ParameterDeclaration): FunctionLike | undefined {
  const owner = parameter.getParent();
  if (
    owner.isKind(SyntaxKind.FunctionDeclaration) ||
    owner.isKind(SyntaxKind.ArrowFunction) ||
    owner.isKind(SyntaxKind.FunctionExpression) ||
    owner.isKind(SyntaxKind.MethodDeclaration)
  ) {
    return owner;
  }
  return undefined;
}

function isKeyConsumingCall(call: Node & { getExpression(): Node }): boolean {
  const callee = call.getExpression();
  if (callee.isKind(SyntaxKind.PropertyAccessExpression)) {
    const target = callee.getExpression().getText();
    const method = callee.getName();
    return (
      (target === 'Object' && OBJECT_KEY_CONSUMERS.has(method)) ||
      (target === 'JSON' && method === 'stringify') ||
      (target === 'Reflect' && method === 'ownKeys')
    );
  }
  return callee.isKind(SyntaxKind.Identifier) && callee.getText() === 'structuredClone';
}

function addProbe(type: Type, name: string, probed: Map<Node, Set<string>>): void {
  const declarations = new Set<Node>();
  addTypeDeclarations(type, declarations);
  for (const decl of declarations) {
    const names = probed.get(decl) ?? new Set<string>();
    names.add(name);
    probed.set(decl, names);
  }
}

function addTypeDeclarations(type: Type, out: Set<Node>, depth = 0): void {
  if (depth > MAX_TYPE_DEPTH) return;
  if (type.isUnion()) {
    for (const part of type.getUnionTypes()) addTypeDeclarations(part, out, depth + 1);
    return;
  }
  if (type.isIntersection()) {
    for (const part of type.getIntersectionTypes()) addTypeDeclarations(part, out, depth + 1);
    return;
  }
  for (const symbol of [type.getAliasSymbol(), type.getSymbol()]) {
    for (const decl of symbol?.getDeclarations() ?? []) {
      if (out.has(decl)) continue;
      out.add(decl);
      if (decl.isKind(SyntaxKind.InterfaceDeclaration)) {
        for (const base of decl.getBaseDeclarations()) {
          addTypeDeclarations(base.getType(), out, depth + 1);
        }
      }
      if (decl.isKind(SyntaxKind.ClassDeclaration)) {
        const base = decl.getBaseClass();
        if (base) addTypeDeclarations(base.getType(), out, depth + 1);
      }
    }
  }
}
