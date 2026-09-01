import type { ObjectLiteralExpression, SourceFile, VariableDeclaration } from 'ts-morph';
import { SyntaxKind, VariableDeclarationKind } from 'ts-morph';
import type { Candidate, CollectContext } from './candidate';
import { arrayUsesStayLocal, valueUsesStayLocal } from './escape';
import { collectLiteralMembers, namesReadElsewhere, shapesHeldBy } from './object-literals';

/**
 * Members of a const object literal: `const Timeouts = { … } as const`.
 *
 * This is the enum modern TypeScript writes. `Timeouts.SAVE_DEBOUNCE` reads a
 * member exactly the way an enum member is read, and a member nothing reads is
 * dead exactly the way an enum's is — so it is found by the sibling of the
 * collector that already answers the question for enums.
 *
 * The difference is that an object is a value, and a value hands out all of its
 * properties at once: `Object.values(Timeouts)`, a spread, an index with a
 * computed key, or the binding passed on whole reaches every member without
 * naming one. Each of those silences the whole declaration instead of softening
 * the verdict on it. A reference count that missed a read is not a weaker
 * claim — it is the wrong one.
 *
 * The same question goes to the literals nested inside, one property at a
 * time, for as long as the reads keep the values local.
 *
 * A binding can hold several shapes at once — an array of literals is one
 * shape per element — and they answer together, the way an array nested under
 * a property does.
 */
export function collectConstObjectCandidates(sourceFile: SourceFile, ctx: CollectContext): Candidate[] {
  const candidates: Candidate[] = [];
  for (const statement of sourceFile.getVariableStatements()) {
    if (statement.getDeclarationKind() !== VariableDeclarationKind.Const) continue;
    for (const declaration of statement.getDeclarations()) {
      const literals = trackableObjectLiterals(declaration, ctx);
      if (!literals) continue;
      const name = declaration.getName();
      const label = (path: string[]): string => `const \`${[name, ...path].join('.')}\``;
      const answered = namesReadElsewhere(literals);
      for (const literal of literals) {
        candidates.push(...collectLiteralMembers(literal, ctx, false, label, answered));
      }
    }
  }
  return candidates;
}

/**
 * The object literals this declaration binds, when their members can be
 * counted: a plain literal or an `as const` one — or an array of them — named
 * by an identifier, with nothing reaching the keys wholesale.
 *
 * A declared type is what makes this stop. `const config: Config = { … }`
 * writes members the interface owns, and `satisfies Handlers` writes members a
 * type demands — in both cases the type declares the shape, the collector that
 * reads types reports it, and a second finding here would say the same thing
 * twice in a different voice.
 */
function trackableObjectLiterals(
  declaration: VariableDeclaration,
  ctx: CollectContext
): ObjectLiteralExpression[] | undefined {
  if (declaration.getTypeNode()) return undefined;
  const nameNode = declaration.getNameNode();
  if (!nameNode.isKind(SyntaxKind.Identifier)) return undefined;

  // `as const` leaves the literals in charge of their own shape. `as Config`
  // and `satisfies Config` hand that to a named type, and fall out here.
  const held = shapesHeldBy(declaration);
  if (!held) return undefined;
  if (held.literals.some(literal => ctx.dynamic.suppressed.has(literal))) return undefined;

  if (ctx.isKeyofTargeted(declaration, nameNode)) return undefined;

  // An array is read for its elements, and an element is the shape in
  // question — so it answers a question of its own about where they go.
  const staysLocal = held.array ? arrayUsesStayLocal(nameNode) : valueUsesStayLocal(nameNode);
  return staysLocal ? held.literals : undefined;
}
