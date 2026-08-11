import type { Node } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';

export interface Described {
  label: string;
  anonymous: boolean;
}

export function describeFunctionName(fn: Node): Described {
  if (fn.isKind(SyntaxKind.FunctionDeclaration)) {
    const name = fn.getName();
    return name
      ? { label: `\`${name}\``, anonymous: false }
      : { label: 'the default export function', anonymous: false };
  }
  const parent = fn.getParent();
  if (parent?.isKind(SyntaxKind.VariableDeclaration)) {
    return { label: `\`${parent.getName()}\``, anonymous: false };
  }
  if (parent?.isKind(SyntaxKind.PropertyAssignment)) {
    return { label: `\`${parent.getName()}\``, anonymous: false };
  }
  return { label: 'an anonymous function', anonymous: true };
}

export function describeTypeLiteralContext(node: Node): Described {
  const parent = node.getParent();
  if (!parent) return { label: `an object type (${location(node)})`, anonymous: true };

  if (parent.isKind(SyntaxKind.TypeAliasDeclaration)) {
    return { label: `type \`${parent.getName()}\``, anonymous: false };
  }
  if (parent.isKind(SyntaxKind.Parameter)) {
    const fn = describeFunctionName(parent.getParent());
    return { label: `props of ${fn.label}`, anonymous: fn.anonymous };
  }
  if (parent.isKind(SyntaxKind.VariableDeclaration)) {
    return { label: `the type of variable \`${parent.getName()}\``, anonymous: false };
  }
  if (
    parent.isKind(SyntaxKind.FunctionDeclaration) ||
    parent.isKind(SyntaxKind.ArrowFunction) ||
    parent.isKind(SyntaxKind.FunctionExpression) ||
    parent.isKind(SyntaxKind.MethodDeclaration)
  ) {
    const fn = describeFunctionName(parent);
    return { label: `the return type of ${fn.label}`, anonymous: fn.anonymous };
  }
  if (parent.isKind(SyntaxKind.PropertySignature) || parent.isKind(SyntaxKind.PropertyDeclaration)) {
    return { label: `the type of property \`${parent.getName()}\``, anonymous: false };
  }
  return { label: `an object type (${location(node)})`, anonymous: true };
}

function location(node: Node): string {
  const sf = node.getSourceFile();
  return `${sf.getBaseName()}:${node.getStartLineNumber()}`;
}
