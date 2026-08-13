import type { InterfaceDeclaration, Node, Project, TypeAliasDeclaration } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import { collectCandidates } from '../collectors';
import type { Finding, FindingKind } from '../types';
import { isUnused } from './check';
import type { ModuleOptions } from './modules';
import { analyzeModules } from './modules';
import { buildReferenceIndex } from './reference-index';
import { findReferencesAsNodes } from './references';
import { isFileSuppressed, isNodeSuppressed } from './suppress';

export interface AnalyzeOptions extends ModuleOptions {
  /**
   * The kinds this run will report. Member analysis is the expensive half of
   * norefs — it has to know which member every object literal and every JSX
   * attribute writes — so a run that asks for none of it skips that work
   * rather than doing it and filtering the findings away.
   */
  kinds?: FindingKind[];
}

/** True when the requested kinds need the member analysis. */
function needsMembers(kinds: FindingKind[] | undefined): boolean {
  return kinds === undefined || kinds.length === 0 || kinds.some(kind => kind === 'member' || kind === 'empty-type');
}

export function analyze(project: Project, options: AnalyzeOptions = {}): Finding[] {
  const members = needsMembers(options.kinds);
  // The index holds nodes of the project as it stands. A watch run and a run
  // after --fix both see an edited project, so every analysis starts fresh.
  buildReferenceIndex(project, { members });

  const modules = analyzeModules(project, options);
  const findings = [...modules.findings];
  const reportedMembers = new Set<Node>();

  for (const { member, context, anonymous } of members ? collectCandidates(project, options) : []) {
    // An unused file or a declaration with zero references is already reported
    // as a whole; listing every member inside it would only add noise.
    if (modules.deadFiles.has(member.getSourceFile())) continue;
    if (member.getAncestors().some(ancestor => modules.deadDecls.has(ancestor))) continue;
    if (isFileSuppressed(member.getSourceFile())) continue;
    const nameNode = member.getNameNode();
    if (isNodeSuppressed(nameNode)) continue;
    if (!isUnused(member)) continue;
    const sourceFile = member.getSourceFile();
    const { line, column } = sourceFile.getLineAndColumnAtPos(nameNode.getStart());
    reportedMembers.add(member);
    findings.push({
      kind: 'member',
      filePath: sourceFile.getFilePath(),
      line,
      column,
      name: member.getName(),
      context,
      anonymous,
      node: member,
    });
  }

  findings.push(...emptyOwnerFindings(reportedMembers));
  findings.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line || a.column - b.column);
  return findings;
}

/**
 * A named type whose members are all reported, while the type itself is still
 * referenced, deserves one more finding: removing the members leaves an empty
 * `interface X {}` behind, and only a human knows whether its consumers should
 * go too.
 */
function emptyOwnerFindings(reportedMembers: Set<Node>): Finding[] {
  const owners = new Set<InterfaceDeclaration | TypeAliasDeclaration>();
  for (const member of reportedMembers) {
    const owner = namedOwner(member);
    if (owner) owners.add(owner);
  }

  const findings: Finding[] = [];
  for (const owner of owners) {
    const members = ownerMembers(owner);
    if (members.length === 0 || !members.every(member => reportedMembers.has(member))) continue;
    // An empty interface that still extends something is an alias, not a leftover.
    if (owner.isKind(SyntaxKind.InterfaceDeclaration) && owner.getHeritageClauses().length > 0) continue;
    const nameNode = owner.getNameNode();
    if (isNodeSuppressed(nameNode)) continue;
    if (!findReferencesAsNodes(nameNode).some(ref => ref !== nameNode)) continue;
    const sourceFile = owner.getSourceFile();
    const { line, column } = sourceFile.getLineAndColumnAtPos(nameNode.getStart());
    findings.push({
      kind: 'empty-type',
      filePath: sourceFile.getFilePath(),
      line,
      column,
      name: owner.getName(),
      context: owner.isKind(SyntaxKind.InterfaceDeclaration) ? 'interface' : 'type',
      anonymous: false,
    });
  }
  return findings;
}

function namedOwner(member: Node): InterfaceDeclaration | TypeAliasDeclaration | undefined {
  const parent = member.getParent();
  if (parent?.isKind(SyntaxKind.InterfaceDeclaration)) return parent;
  if (parent?.isKind(SyntaxKind.TypeLiteral)) {
    const grandParent = parent.getParent();
    if (grandParent?.isKind(SyntaxKind.TypeAliasDeclaration)) return grandParent;
  }
  return undefined;
}

function ownerMembers(owner: InterfaceDeclaration | TypeAliasDeclaration): Node[] {
  if (owner.isKind(SyntaxKind.InterfaceDeclaration)) return owner.getMembers();
  const typeNode = owner.getTypeNode();
  return typeNode?.isKind(SyntaxKind.TypeLiteral) ? typeNode.getMembers() : [];
}
