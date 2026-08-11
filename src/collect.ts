import type {
  ArrowFunction,
  FunctionDeclaration,
  FunctionExpression,
  Node,
  ObjectLiteralExpression,
  Project,
  PropertyNamedNode,
} from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import { describeFunctionName, describeTypeLiteralContext } from './describe.js';

type FunctionLike = FunctionDeclaration | ArrowFunction | FunctionExpression;

export interface Candidate {
  member: PropertyNamedNode & Node;
  context: string;
}

export function collectCandidates(project: Project): Candidate[] {
  const candidates: Candidate[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    if (sourceFile.isDeclarationFile()) continue;

    for (const iface of sourceFile.getInterfaces()) {
      const context = `interface \`${iface.getName()}\``;
      for (const member of iface.getMembers()) {
        pushIfNamed(candidates, member, context);
      }
    }

    for (const typeLiteral of sourceFile.getDescendantsOfKind(SyntaxKind.TypeLiteral)) {
      if (isGenericConstraint(typeLiteral)) continue;
      const context = describeTypeLiteralContext(typeLiteral);
      for (const member of typeLiteral.getMembers()) {
        pushIfNamed(candidates, member, context);
      }
    }

    for (const fn of exportedFunctionsWithInferredReturn(sourceFile)) {
      const objectLiteral = getSoleReturnedObjectLiteral(fn);
      if (!objectLiteral) continue;
      const context = `the return value of ${describeFunctionName(fn)}`;
      for (const member of objectLiteral.getProperties()) {
        pushIfNamed(candidates, member, context);
      }
    }
  }
  return candidates;
}

function pushIfNamed(candidates: Candidate[], member: Node, context: string): void {
  if (!member.isKind(SyntaxKind.PropertySignature) && !member.isKind(SyntaxKind.MethodSignature)) {
    if (
      !member.isKind(SyntaxKind.PropertyAssignment) &&
      !member.isKind(SyntaxKind.MethodDeclaration) &&
      !member.isKind(SyntaxKind.GetAccessor) &&
      !member.isKind(SyntaxKind.SetAccessor)
    ) {
      return;
    }
  }
  const named = member as unknown as PropertyNamedNode & Node;
  if (named.getNameNode().getKind() === SyntaxKind.ComputedPropertyName) return;
  candidates.push({ member: named, context });
}

function isGenericConstraint(node: Node): boolean {
  return node.getFirstAncestor(a => a.isKind(SyntaxKind.TypeParameter)) !== undefined;
}

function exportedFunctionsWithInferredReturn(
  sourceFile: ReturnType<Project['getSourceFiles']>[number]
): FunctionLike[] {
  const fns: FunctionLike[] = [];

  for (const fn of sourceFile.getFunctions()) {
    if ((fn.isExported() || fn.isDefaultExport()) && !fn.getReturnTypeNode()) {
      fns.push(fn);
    }
  }

  for (const statement of sourceFile.getVariableStatements()) {
    if (!statement.isExported()) continue;
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
