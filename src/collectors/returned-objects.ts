import type {
  ArrowFunction,
  FunctionDeclaration,
  FunctionExpression,
  Node,
  ObjectLiteralExpression,
  SourceFile,
} from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import { describeFunctionName } from '../describe';
import { findReferencesAsNodes } from '../lookup/references';
import type { Candidate, CollectContext } from './candidate';
import { callableEscapes, getCallableNameNode } from './escape';
import { collectLiteralMembers, writtenProperty } from './object-literals';

export type FunctionLike = FunctionDeclaration | ArrowFunction | FunctionExpression;

/**
 * Members of the objects a function returns, and of the literals nested inside
 * them — as deep as the reads of each property keep the value local.
 */
export function collectReturnedObjectCandidates(sourceFile: SourceFile, ctx: CollectContext): Candidate[] {
  const candidates: Candidate[] = [];
  for (const fn of functionsWithInferredReturn(sourceFile)) {
    const literals = returnedObjectLiterals(fn);
    if (literals.length === 0) continue;
    if (returnValueEscapes(fn)) continue;
    const described = describeFunctionName(fn);
    const label = (path: string[]): string =>
      path.length === 0
        ? `the return value of ${described.label}`
        : `the \`${path.join('.')}\` object returned by ${described.label}`;
    const answered = namesReadElsewhere(literals);
    for (const literal of literals) {
      candidates.push(...collectLiteralMembers(literal, ctx, described.anonymous, label, answered));
    }
  }
  return candidates;
}

/**
 * Names another returned literal already answers for.
 *
 * Two branches returning the same shape are one type by the time the checker
 * is done with them, so every read of a shared name lands on the single
 * declaration it kept. The others hold zero references and are alive all the
 * same. A name more than one literal writes is therefore reported only when
 * every one of those declarations is unread, and this is the set where that
 * does not hold.
 */
function namesReadElsewhere(literals: ObjectLiteralExpression[]): Set<string> | undefined {
  if (literals.length < 2) return undefined;
  const declared = new Map<string, Node[]>();
  for (const literal of literals) {
    for (const property of literal.getProperties()) {
      const written = writtenProperty(property);
      if (!written) continue;
      const nodes = declared.get(written.key);
      if (nodes) nodes.push(written.nameNode);
      else declared.set(written.key, [written.nameNode]);
    }
  }

  const read = new Set<string>();
  for (const [name, nameNodes] of declared) {
    if (nameNodes.length < 2) continue;
    if (nameNodes.some(nameNode => findReferencesAsNodes(nameNode).length > 0)) read.add(name);
  }
  return read.size > 0 ? read : undefined;
}

/** The function whose body writes this literal, ignoring the callables nested in between. */
export function producerOf(literal: ObjectLiteralExpression): FunctionLike | undefined {
  return literal
    .getAncestors()
    .find(
      (ancestor): ancestor is FunctionLike =>
        ancestor.isKind(SyntaxKind.FunctionDeclaration) ||
        ancestor.isKind(SyntaxKind.ArrowFunction) ||
        ancestor.isKind(SyntaxKind.FunctionExpression)
    );
}

function returnValueEscapes(fn: FunctionLike): boolean {
  const nameNode = getCallableNameNode(fn);
  return !nameNode || callableEscapes(nameNode);
}

/**
 * Every top-level function with an inferred return type, exported or not: a
 * local producer's dead output matters as much as a public one's. The escape
 * checks decide which of these are trackable.
 */
function functionsWithInferredReturn(sourceFile: SourceFile): FunctionLike[] {
  const fns: FunctionLike[] = [];

  for (const fn of sourceFile.getFunctions()) {
    if (!fn.getReturnTypeNode()) fns.push(fn);
  }

  for (const statement of sourceFile.getVariableStatements()) {
    for (const decl of statement.getDeclarations()) {
      const initializer = decl.getInitializer();
      if (!initializer) continue;
      if (
        (initializer.isKind(SyntaxKind.ArrowFunction) || initializer.isKind(SyntaxKind.FunctionExpression)) &&
        !initializer.getReturnTypeNode()
      ) {
        fns.push(initializer);
      }
    }
  }

  return fns;
}

function unwrapParens(node: Node): Node {
  let current = node;
  while (current.isKind(SyntaxKind.ParenthesizedExpression)) {
    current = current.getExpression();
  }
  return current;
}

/**
 * The object literals this function hands back, or none at all.
 *
 * Several `return` statements are several shapes of one return value, and each
 * shape answers for its own members. A `return` of anything else — a variable,
 * a call, a bare `return` — puts a shape here that this check cannot read, and
 * a read of the value could land on that shape instead of on a literal. The
 * whole function is left alone rather than guessed at.
 */
export function returnedObjectLiterals(fn: FunctionLike): ObjectLiteralExpression[] {
  let block: Node | undefined;
  if (fn.isKind(SyntaxKind.ArrowFunction)) {
    const body = fn.getBody();
    if (!body.isKind(SyntaxKind.Block)) {
      const expr = unwrapParens(body);
      return expr.isKind(SyntaxKind.ObjectLiteralExpression) ? [expr] : [];
    }
    block = body;
  } else {
    block = fn.getBody();
  }
  if (!block?.isKind(SyntaxKind.Block)) return [];

  const returned: ObjectLiteralExpression[] = [];
  let sawOther = false;

  block.forEachDescendant((node, traversal) => {
    if (
      node.isKind(SyntaxKind.FunctionDeclaration) ||
      node.isKind(SyntaxKind.ArrowFunction) ||
      node.isKind(SyntaxKind.FunctionExpression) ||
      node.isKind(SyntaxKind.MethodDeclaration)
    ) {
      traversal.skip();
      return;
    }
    if (!node.isKind(SyntaxKind.ReturnStatement)) return;
    const expr = node.getExpression();
    if (!expr) {
      sawOther = true;
      return;
    }
    const unwrapped = unwrapParens(expr);
    if (unwrapped.isKind(SyntaxKind.ObjectLiteralExpression)) {
      returned.push(unwrapped);
    } else {
      sawOther = true;
    }
  });

  return sawOther ? [] : returned;
}
