import type {
  ArrowFunction,
  CallExpression,
  FunctionDeclaration,
  FunctionExpression,
  Identifier,
  Node,
  ObjectLiteralExpression,
  SourceFile,
} from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import { describeFunctionName } from '../engine/describe';
import type { Candidate } from './candidate';
import { toCandidate } from './candidate';

type FunctionLike = FunctionDeclaration | ArrowFunction | FunctionExpression;

export function collectReturnedObjectCandidates(sourceFile: SourceFile): Candidate[] {
  const candidates: Candidate[] = [];
  for (const fn of exportedFunctionsWithInferredReturn(sourceFile)) {
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

function exportedFunctionsWithInferredReturn(sourceFile: SourceFile): FunctionLike[] {
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

/**
 * True when the function's return value can leave local view as a whole —
 * passed as a bare argument, returned, spread, or aliased. Once the object
 * escapes, its properties may be consumed without any per-property reference
 * (JSON.stringify, IPC, logging), so reference counts can't be trusted.
 */
function returnValueEscapes(fn: FunctionLike): boolean {
  const nameNode = getCallableNameNode(fn);
  if (!nameNode) return true;

  for (const ref of nameNode.findReferencesAsNodes()) {
    const parent = ref.getParent();
    if (!parent) continue;
    if (isAliasDeclarationParent(parent)) continue;
    const call = ref.getParentIfKind(SyntaxKind.CallExpression);
    if (!call || call.getExpression() !== ref) return true;
    if (!callResultStaysLocal(call)) return true;
  }
  return false;
}

function getCallableNameNode(fn: FunctionLike): Identifier | undefined {
  if (fn.isKind(SyntaxKind.FunctionDeclaration)) return fn.getNameNode();
  const parent = fn.getParent();
  if (parent?.isKind(SyntaxKind.VariableDeclaration)) {
    const name = parent.getNameNode();
    if (name.isKind(SyntaxKind.Identifier)) return name;
  }
  return undefined;
}

function isAliasDeclarationParent(parent: Node): boolean {
  return (
    parent.isKind(SyntaxKind.ImportSpecifier) ||
    parent.isKind(SyntaxKind.ExportSpecifier) ||
    parent.isKind(SyntaxKind.ImportClause) ||
    parent.isKind(SyntaxKind.NamespaceImport) ||
    parent.isKind(SyntaxKind.ExportAssignment)
  );
}

function callResultStaysLocal(call: CallExpression): boolean {
  const consumer = climbWrappers(call);
  const parent = consumer.getParent();
  if (!parent) return true;
  if (parent.isKind(SyntaxKind.PropertyAccessExpression) && parent.getExpression() === consumer) return true;
  if (isStringKeyedElementAccess(parent, consumer)) return true;
  if (parent.isKind(SyntaxKind.ExpressionStatement)) return true;
  if (parent.isKind(SyntaxKind.VariableDeclaration)) {
    const name = parent.getNameNode();
    if (!name.isKind(SyntaxKind.Identifier)) return true;
    return variableStaysLocal(name);
  }
  return false;
}

function variableStaysLocal(name: Identifier): boolean {
  for (const ref of name.findReferencesAsNodes()) {
    const use = climbWrappers(ref);
    const parent = use.getParent();
    if (!parent) continue;
    if (parent.isKind(SyntaxKind.PropertyAccessExpression) && parent.getExpression() === use) continue;
    if (isStringKeyedElementAccess(parent, use)) continue;
    if (parent.isKind(SyntaxKind.VariableDeclaration) && !parent.getNameNode().isKind(SyntaxKind.Identifier)) {
      continue;
    }
    return false;
  }
  return true;
}

function climbWrappers(node: Node): Node {
  let current = node;
  while (true) {
    const parent = current.getParent();
    if (
      (parent?.isKind(SyntaxKind.ParenthesizedExpression) || parent?.isKind(SyntaxKind.NonNullExpression)) &&
      parent.getExpression() === current
    ) {
      current = parent;
      continue;
    }
    if (parent?.isKind(SyntaxKind.AwaitExpression) && parent.getExpression() === current) {
      current = parent;
      continue;
    }
    return current;
  }
}

function isStringKeyedElementAccess(parent: Node, expression: Node): boolean {
  return (
    parent.isKind(SyntaxKind.ElementAccessExpression) &&
    parent.getExpression() === expression &&
    (parent.getArgumentExpression()?.isKind(SyntaxKind.StringLiteral) ?? false)
  );
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
