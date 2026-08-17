import type {
  ArrowFunction,
  FunctionDeclaration,
  FunctionExpression,
  Node,
  ObjectLiteralExpression,
  SourceFile,
} from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import { describeFunctionName } from '../engine/describe';
import type { Candidate, CollectContext } from './candidate';
import { toCandidate } from './candidate';
import { callableEscapes, getCallableNameNode } from './escape';

type FunctionLike = FunctionDeclaration | ArrowFunction | FunctionExpression;

export function collectReturnedObjectCandidates(sourceFile: SourceFile, _ctx: CollectContext): Candidate[] {
  const candidates: Candidate[] = [];
  for (const fn of functionsWithInferredReturn(sourceFile)) {
    const objectLiteral = getSoleReturnedObjectLiteral(fn);
    if (!objectLiteral) continue;
    if (returnValueEscapes(fn)) continue;
    const described = describeFunctionName(fn);
    const context = `the return value of ${described.label}`;
    for (const member of objectLiteral.getProperties()) {
      const candidate = toCandidate(member, context, described.anonymous);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
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

function getSoleReturnedObjectLiteral(fn: FunctionLike): ObjectLiteralExpression | undefined {
  let block: Node | undefined;
  if (fn.isKind(SyntaxKind.ArrowFunction)) {
    const body = fn.getBody();
    if (!body.isKind(SyntaxKind.Block)) {
      const expr = unwrapParens(body);
      return expr.isKind(SyntaxKind.ObjectLiteralExpression) ? expr : undefined;
    }
    block = body;
  } else {
    block = fn.getBody();
  }
  if (!block?.isKind(SyntaxKind.Block)) return undefined;

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

  if (sawOther || returned.length !== 1) return undefined;
  return returned[0];
}
