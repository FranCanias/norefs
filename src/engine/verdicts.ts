import path from 'node:path';
import type { InterfaceDeclaration, Node, Project, SourceFile, TypeAliasDeclaration, TypeNode } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import type { Finding, Verdict } from '../types';
import { referenceIndex } from './reference-index';
import { findReferencesAsNodes } from './references';

/**
 * Turn the single "unused" label into a verdict per finding.
 *
 * Export findings carry their verdict already (dead or over-exported, from the
 * reference classification). Member findings start as `dead` and soften when a
 * signal says the analysis is on thin ice:
 * - the owner type sits in the serialization-boundary closure → `contract`
 * - a structural twin of the owner is read where this member is not → `shadowed`
 * - a write of this name exists that no member could be charged with → `write-only`
 *
 * An empty-type finding takes the most cautious verdict of its members: it
 * only exists because every member was reported.
 */
export function assignVerdicts(project: Project, findings: Finding[], cwd: string): void {
  const memberFindings = findings.filter(f => f.kind === 'member' && f.node && !f.verdict);
  if (memberFindings.length === 0) {
    assignEmptyTypeVerdicts(findings);
    return;
  }

  const boundary = boundaryClosure(project);
  const twins = new TwinIndex(project);
  const index = referenceIndex(project);

  for (const finding of memberFindings) {
    const owner = namedTypeAncestor(finding.node as Node);
    if (owner && boundary.has(owner)) {
      finding.verdict = 'contract';
      finding.evidence = boundary.get(owner);
      continue;
    }
    const shadow = owner && twins.readTwinMember(owner, finding.name);
    if (shadow) {
      finding.verdict = 'shadowed';
      finding.evidence = `a structural twin \`${shadow.typeName}\` (${location(shadow.member, cwd)}) reads \`${finding.name}\``;
      continue;
    }
    if (index.hasUnattributedWrite(finding.name)) {
      finding.verdict = 'write-only';
      finding.evidence = `something assigns \`${finding.name}\` where the analysis lost the type`;
      continue;
    }
    finding.verdict = 'dead';
  }

  assignEmptyTypeVerdicts(findings);
}

/** The most cautious verdict among an emptied type's own reported members. */
function assignEmptyTypeVerdicts(findings: Finding[]): void {
  const caution: Verdict[] = ['dead', 'write-only', 'shadowed', 'contract'];
  for (const finding of findings) {
    if (finding.kind !== 'empty-type') continue;
    let worst = 0;
    for (const member of findings) {
      if (member.kind !== 'member' || member.filePath !== finding.filePath) continue;
      if (member.context.includes(`\`${finding.name}\``)) {
        worst = Math.max(worst, caution.indexOf(member.verdict ?? 'dead'));
        if (member.verdict && member.verdict !== 'dead' && !finding.evidence) finding.evidence = member.evidence;
      }
    }
    finding.verdict = caution[worst];
  }
}

// ------------------------------------------------------- serialization boundary

const PARSE_CALLS = new Set(['parse', 'structuredClone']);
const SEND_CALLS = new Set(['stringify', 'postMessage', 'structuredClone']);

/**
 * Named types whose values cross a serialization boundary, mapped to the
 * evidence sentence. Seeds are the types asserted or annotated on
 * `JSON.parse`/`structuredClone` results and the argument types of
 * `JSON.stringify`/`postMessage`. The closure adds every named type referenced
 * inside a boundary type's declaration: a member of a wire format is wire
 * format too.
 */
function boundaryClosure(project: Project): Map<Node, string> {
  const boundary = new Map<Node, string>();
  const queue: Node[] = [];
  const add = (decl: Node, evidence: string): void => {
    if (boundary.has(decl)) return;
    boundary.set(decl, evidence);
    queue.push(decl);
  };

  for (const sourceFile of project.getSourceFiles()) {
    if (sourceFile.isDeclarationFile()) continue;
    collectBoundarySeeds(sourceFile, add);
  }

  // Propagate into the declarations' bodies.
  for (let decl = queue.pop(); decl; decl = queue.pop()) {
    const evidence = boundary.get(decl) as string;
    const name = declName(decl);
    for (const target of referencedTypeDeclarations(decl)) {
      add(target, `\`${declName(target)}\` is part of \`${name}\`, which ${evidence}`);
    }
  }
  return boundary;
}

function collectBoundarySeeds(sourceFile: SourceFile, add: (decl: Node, evidence: string) => void): void {
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    const name = callee.isKind(SyntaxKind.PropertyAccessExpression)
      ? callee.getName()
      : callee.isKind(SyntaxKind.Identifier)
        ? callee.getText()
        : undefined;
    if (name === undefined) continue;
    const label = callee.getText().length <= 30 ? callee.getText() : name;

    // Parse side: the type the result is asserted or annotated to.
    if (PARSE_CALLS.has(name)) {
      const typeNode = resultTypeNode(call);
      if (typeNode) {
        for (const decl of typeDeclarationsIn(typeNode)) {
          add(decl, `its values come out of \`${label}(…)\``);
        }
      }
    }

    // Send side: the declared type of what goes in.
    if (SEND_CALLS.has(name)) {
      for (const argument of call.getArguments()) {
        for (const decl of declarationsOfExpressionType(argument)) {
          add(decl, `its values go into \`${label}(…)\``);
        }
      }
    }
  }
}

/** The type node a call result lands on: `call() as T`, `const x: T = call()`. */
function resultTypeNode(call: Node): TypeNode | undefined {
  let node: Node = call;
  for (;;) {
    const parent = node.getParent();
    if (!parent) return undefined;
    if (parent.isKind(SyntaxKind.ParenthesizedExpression) || parent.isKind(SyntaxKind.AwaitExpression)) {
      node = parent;
      continue;
    }
    if (parent.isKind(SyntaxKind.AsExpression)) {
      const typeNode = parent.getTypeNode();
      // `as unknown as T` keeps climbing through the unknown step.
      if (
        typeNode &&
        (typeNode.getKind() === SyntaxKind.UnknownKeyword || typeNode.getKind() === SyntaxKind.AnyKeyword)
      ) {
        node = parent;
        continue;
      }
      return typeNode;
    }
    if (parent.isKind(SyntaxKind.VariableDeclaration)) return parent.getTypeNode();
    return undefined;
  }
}

/** Project-defined interface, type alias, and enum declarations a type node references. */
function typeDeclarationsIn(typeNode: TypeNode): Node[] {
  const out: Node[] = [];
  const nodes = typeNode.isKind(SyntaxKind.TypeReference)
    ? [typeNode, ...typeNode.getDescendantsOfKind(SyntaxKind.TypeReference)]
    : typeNode.getDescendantsOfKind(SyntaxKind.TypeReference);
  for (const reference of new Set(nodes)) {
    const symbol = reference.getTypeName().getSymbol();
    for (const decl of symbol?.getAliasedSymbol()?.getDeclarations() ?? symbol?.getDeclarations() ?? []) {
      if (isNamedTypeDeclaration(decl) && !decl.getSourceFile().isDeclarationFile()) out.push(decl);
    }
  }
  return out;
}

/** The named project types behind an expression's declared type. */
function declarationsOfExpressionType(expression: Node): Node[] {
  const type = expression.getType();
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  return (symbol?.getDeclarations() ?? []).filter(
    decl => isNamedTypeDeclaration(decl) && !decl.getSourceFile().isDeclarationFile()
  );
}

/** Named types referenced anywhere inside this declaration's body. */
function referencedTypeDeclarations(decl: Node): Node[] {
  const out: Node[] = [];
  for (const reference of decl.getDescendantsOfKind(SyntaxKind.TypeReference)) {
    const symbol = reference.getTypeName().getSymbol();
    for (const target of symbol?.getAliasedSymbol()?.getDeclarations() ?? symbol?.getDeclarations() ?? []) {
      if (target !== decl && isNamedTypeDeclaration(target) && !target.getSourceFile().isDeclarationFile()) {
        out.push(target);
      }
    }
  }
  return out;
}

function isNamedTypeDeclaration(node: Node): boolean {
  return (
    node.isKind(SyntaxKind.InterfaceDeclaration) ||
    node.isKind(SyntaxKind.TypeAliasDeclaration) ||
    node.isKind(SyntaxKind.EnumDeclaration)
  );
}

function declName(decl: Node): string {
  return (decl as InterfaceDeclaration).getName() ?? '?';
}

// ------------------------------------------------------------- structural twins

interface TwinMember {
  typeName: string;
  member: Node;
}

/**
 * Interfaces and type-literal aliases indexed by their member-name signature.
 * Two types with the same signature are structural twins: when the twin's
 * member of the flagged name is read, the flagged member is probably read too
 * — through the duplicate — and the real problem is the duplication.
 */
class TwinIndex {
  private readonly bySignature = new Map<string, Array<InterfaceDeclaration | TypeAliasDeclaration>>();

  constructor(project: Project) {
    for (const sourceFile of project.getSourceFiles()) {
      if (sourceFile.isDeclarationFile()) continue;
      for (const decl of [...sourceFile.getInterfaces(), ...sourceFile.getTypeAliases()]) {
        const names = memberNames(decl);
        // One or two members twin by accident; demand a shape with substance.
        if (names.length < 3) continue;
        const signature = names.join('\x00');
        const list = this.bySignature.get(signature) ?? [];
        list.push(decl);
        this.bySignature.set(signature, list);
      }
    }
  }

  /** A twin of this owner whose member of the given name has references. */
  readTwinMember(owner: Node, name: string): TwinMember | undefined {
    if (!owner.isKind(SyntaxKind.InterfaceDeclaration) && !owner.isKind(SyntaxKind.TypeAliasDeclaration)) {
      return undefined;
    }
    const signature = memberNames(owner).join('\x00');
    for (const twin of this.bySignature.get(signature) ?? []) {
      if (twin === owner) continue;
      const member = typeMembers(twin).find(m => memberName(m) === name);
      if (!member) continue;
      const nameNode = (member as Node & { getNameNode(): Node }).getNameNode();
      if (findReferencesAsNodes(nameNode).length > 0) return { typeName: twin.getName() ?? '?', member };
    }
    return undefined;
  }
}

function memberNames(decl: InterfaceDeclaration | TypeAliasDeclaration): string[] {
  return typeMembers(decl).map(memberName).sort();
}

function typeMembers(decl: InterfaceDeclaration | TypeAliasDeclaration): Node[] {
  if (decl.isKind(SyntaxKind.InterfaceDeclaration)) return decl.getMembers();
  const typeNode = decl.getTypeNode();
  return typeNode?.isKind(SyntaxKind.TypeLiteral) ? typeNode.getMembers() : [];
}

function memberName(member: Node): string {
  return (member as Node & { getName?: () => string }).getName?.() ?? '';
}

// ----------------------------------------------------------------------- shared

/** The nearest interface, type alias, enum, or class the member sits in. */
function namedTypeAncestor(member: Node): Node | undefined {
  return member
    .getAncestors()
    .find(
      ancestor =>
        ancestor.isKind(SyntaxKind.InterfaceDeclaration) ||
        ancestor.isKind(SyntaxKind.TypeAliasDeclaration) ||
        ancestor.isKind(SyntaxKind.EnumDeclaration) ||
        ancestor.isKind(SyntaxKind.ClassDeclaration)
    );
}

function location(node: Node, cwd: string): string {
  const sourceFile = node.getSourceFile();
  const { line } = sourceFile.getLineAndColumnAtPos(node.getStart());
  return `${path.relative(cwd, sourceFile.getFilePath())}:${line}`;
}
