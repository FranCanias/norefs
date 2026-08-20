import type { Node } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import { startLine } from './engine/location';

// Naming, not policy. It decides nothing about what is dead, which is why both
// engine/ and collectors/ can read it without either layer sitting on the other.

interface Described {
  /** The name with reporter markup: `` `load` ``, "the default export function". */
  label: string;
  /** The bare name, for a finding's own `name` field — same text, no markup. */
  name: string;
  anonymous: boolean;
}

function named(name: string): Described {
  return { label: `\`${name}\``, name, anonymous: false };
}

function unnamed(name: string, anonymous: boolean): Described {
  return { label: name, name, anonymous };
}

export function describeFunctionName(fn: Node): Described {
  if (fn.isKind(SyntaxKind.FunctionDeclaration)) {
    const name = fn.getName();
    return name ? named(name) : unnamed('the default export function', false);
  }
  if (fn.isKind(SyntaxKind.MethodDeclaration)) {
    const name = fn.getNameNode();
    if (name.isKind(SyntaxKind.Identifier) || name.isKind(SyntaxKind.StringLiteral)) {
      return named(fn.getName());
    }
    return unnamed('an anonymous function', true);
  }
  const parent = fn.getParent();
  if (parent?.isKind(SyntaxKind.VariableDeclaration)) {
    return named(parent.getName());
  }
  if (parent?.isKind(SyntaxKind.PropertyAssignment)) {
    return named(parent.getName());
  }
  return unnamed('an anonymous function', true);
}

/** A context label for a member finding — markup included, never a bare name. */
interface DescribedContext {
  label: string;
  anonymous: boolean;
}

export function describeTypeLiteralContext(node: Node): DescribedContext {
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
    // The literal nests inside another type's member. It has no name of its
    // own, however well-named the type around it is — and --anon promises
    // that findings on unnamed inline types stay hidden by default.
    return { label: `the type of property \`${parent.getName()}\``, anonymous: true };
  }
  return { label: `an object type (${location(node)})`, anonymous: true };
}

function location(node: Node): string {
  const sf = node.getSourceFile();
  return `${sf.getBaseName()}:${startLine(node)}`;
}
