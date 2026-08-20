import type { Node, Project, Type } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import { forEachDescendantOfKinds } from '../lookup/descendants';

/**
 * Project-wide index of types whose keys are consumed dynamically. When a value
 * flows into a key-enumerating or serializing sink — Object.keys, for…in,
 * JSON.stringify — its properties are read without per-property references, so
 * reference counts for that type can't be trusted.
 */
export interface DynamicConsumptionIndex {
  /** Type declarations (interfaces, aliases, type literals) to skip entirely. */
  suppressed: Set<Node>;
  /** Per-declaration property names probed by a literal `'name' in v` check. */
  probed: Map<Node, Set<string>>;
}

const OBJECT_KEY_CONSUMERS = new Set(['keys', 'values', 'entries', 'getOwnPropertyNames', 'assign']);

/** The only kinds the walk below acts on; one raw pass finds them all. */
const CONSUMING_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.CallExpression,
  SyntaxKind.ForInStatement,
  SyntaxKind.BinaryExpression,
]);

/** How far into a union, intersection, or array the walk unwraps a type. */
const MAX_TYPE_DEPTH = 3;

export function buildDynamicConsumptionIndex(project: Project): DynamicConsumptionIndex {
  const suppressed = new Set<Node>();
  const probed = new Map<Node, Set<string>>();

  for (const sourceFile of project.getSourceFiles()) {
    if (sourceFile.isDeclarationFile()) continue;
    forEachDescendantOfKinds(sourceFile, CONSUMING_KINDS, node => {
      if (node.isKind(SyntaxKind.CallExpression)) {
        if (isKeyConsumingCall(node)) {
          for (const arg of node.getArguments()) {
            addTypeDeclarations(arg.getType(), suppressed);
          }
        }
        return;
      }
      if (node.isKind(SyntaxKind.ForInStatement)) {
        addTypeDeclarations(node.getExpression().getType(), suppressed);
        return;
      }
      if (node.isKind(SyntaxKind.BinaryExpression) && node.getOperatorToken().getKind() === SyntaxKind.InKeyword) {
        const left = node.getLeft();
        const rightType = node.getRight().getType();
        if (left.isKind(SyntaxKind.StringLiteral)) {
          addProbe(rightType, left.getLiteralValue(), probed);
        } else {
          addTypeDeclarations(rightType, suppressed);
        }
      }
    });
  }

  return { suppressed, probed };
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
