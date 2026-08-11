import type { Node } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';

export function describeFunctionName(fn: Node): string {
  if (fn.isKind(SyntaxKind.FunctionDeclaration)) {
    const name = fn.getName();
    return name ? `\`${name}\`` : 'the default export function';
  }
  const parent = fn.getParent();
  if (parent?.isKind(SyntaxKind.VariableDeclaration)) {
    return `\`${parent.getName()}\``;
  }
  if (parent?.isKind(SyntaxKind.PropertyAssignment)) {
    return `\`${parent.getName()}\``;
  }
  return 'an anonymous function';
}

export function describeTypeLiteralContext(node: Node): string {
  const parent = node.getParent();
  if (!parent) return `an object type (${location(node)})`;

  if (parent.isKind(SyntaxKind.TypeAliasDeclaration)) {
    return `type \`${parent.getName()}\``;
  }
  if (parent.isKind(SyntaxKind.Parameter)) {
    const fn = parent.getParent();
    return `props of ${describeFunctionName(fn)}`;
  }
  if (parent.isKind(SyntaxKind.VariableDeclaration)) {
    return `the type of variable \`${parent.getName()}\``;
  }
  if (
    parent.isKind(SyntaxKind.FunctionDeclaration) ||
    parent.isKind(SyntaxKind.ArrowFunction) ||
    parent.isKind(SyntaxKind.FunctionExpression) ||
    parent.isKind(SyntaxKind.MethodDeclaration)
  ) {
    return `the return type of ${describeFunctionName(parent)}`;
  }
  if (parent.isKind(SyntaxKind.PropertySignature) || parent.isKind(SyntaxKind.PropertyDeclaration)) {
    return `the type of property \`${parent.getName()}\``;
  }
  return `an object type (${location(node)})`;
}

function location(node: Node): string {
  const sf = node.getSourceFile();
  return `${sf.getBaseName()}:${node.getStartLineNumber()}`;
}
