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
import type { Candidate, CollectContext } from './candidate';
import { callableEscapes, getCallableNameNode } from './escape';
import { collectLiteralMembers, namesReadElsewhere } from './object-literals';

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
    // One death, told once. Two branches writing the same key are two edits
    // and a single fact, and a reader counts findings before reading them.
    // The fix loop re-analyzes after each pass, so the second copy is offered
    // as soon as the first one goes.
    const told = new Set<string>();
    for (const literal of literals) {
      for (const candidate of collectLiteralMembers(literal, ctx, described.anonymous, label, answered)) {
        const key = `${candidate.context}\u0000${candidate.member.getName()}`;
        if (told.has(key)) continue;
        told.add(key);
        candidates.push(candidate);
      }
    }
  }
  return candidates;
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
