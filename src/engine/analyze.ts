import type { InterfaceDeclaration, Node, ObjectLiteralExpression, Project, TypeAliasDeclaration } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import { collectCandidates } from '../collectors';
import type { Finding, FindingKind } from '../types';
import { memberUsage } from './check';
import { describeFunctionName } from './describe';
import type { ModuleOptions } from './modules';
import { analyzeModules } from './modules';
import { buildReferenceIndex } from './reference-index';
import { findReferencesAsNodes } from './references';
import { annotateStrandedChannels } from './strands';
import { isFileSuppressed, isNodeSuppressed } from './suppress';
import { assignVerdicts } from './verdicts';

interface AnalyzeOptions extends ModuleOptions {
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
    // A member of a public-API type is read by consumers outside this program.
    if (member.getAncestors().some(ancestor => modules.publicDecls.has(ancestor))) continue;
    // Fixture types in tests and configs are noise, not dead code worth a report.
    if (modules.harnessFiles.has(member.getSourceFile())) continue;
    if (isFileSuppressed(member.getSourceFile())) continue;
    const nameNode = member.getNameNode();
    if (isNodeSuppressed(nameNode)) continue;
    const usage = memberUsage(member, sf => modules.harnessFiles.has(sf));
    if (usage === 'used') continue;
    const sourceFile = member.getSourceFile();
    const { line, column } = sourceFile.getLineAndColumnAtPos(nameNode.getStart());
    // Only truly unused members feed the empty-type fold: a test-only member
    // needs its tests deleted with it, which is not an emptied type's story.
    if (usage === 'unused') reportedMembers.add(member);
    findings.push({
      kind: 'member',
      filePath: sourceFile.getFilePath(),
      line,
      column,
      name: member.getName(),
      context,
      anonymous,
      node: member,
      ...(usage === 'test-only' ? { verdict: 'test-only' as const, evidence: 'only test files reference it' } : {}),
    });
  }

  const typeFold = emptyOwnerFindings(reportedMembers);
  const sliceFold = emptyReturnedObjectFindings(reportedMembers);
  findings.push(...typeFold.emptyFindings, ...sliceFold.emptyFindings);
  assignVerdicts(project, findings, process.cwd());
  annotateStrandedChannels(project, findings, process.cwd());
  // One logical fact, one finding: a type losing every member is the story,
  // not seven bullets. The members fold in after they lent it their verdict.
  const swallowed = new Set([...typeFold.swallowed, ...sliceFold.swallowed]);
  // A strand note on a member about to fold must survive on the finding that
  // replaces it, or the far side vanishes exactly when the whole wrapper dies.
  for (const empty of findings) {
    if (empty.kind !== 'empty-type' || empty.strands) continue;
    const donor = findings.find(
      f =>
        f.kind === 'member' &&
        f.node &&
        swallowed.has(f.node) &&
        f.strands &&
        f.filePath === empty.filePath &&
        f.context.includes(`\`${empty.name}\``)
    );
    if (donor) empty.strands = donor.strands;
  }
  const folded = findings.filter(f => !(f.kind === 'member' && f.node && swallowed.has(f.node)));
  folded.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line || a.column - b.column);
  return folded;
}

/**
 * The producer half of a dead slice: a function whose returned object loses
 * every property. Nobody reads what it computes, so the computation itself is
 * the finding, not the properties one by one.
 */
function emptyReturnedObjectFindings(reportedMembers: Set<Node>): { emptyFindings: Finding[]; swallowed: Set<Node> } {
  const literals = new Set<Node>();
  for (const member of reportedMembers) {
    const parent = member.getParent();
    if (parent?.isKind(SyntaxKind.ObjectLiteralExpression)) literals.add(parent);
  }

  const emptyFindings: Finding[] = [];
  const swallowed = new Set<Node>();
  for (const literal of literals) {
    const properties = (literal as ObjectLiteralExpression).getProperties();
    if (properties.length === 0 || !properties.every(property => reportedMembers.has(property))) continue;
    const fn = literal
      .getAncestors()
      .find(
        ancestor =>
          ancestor.isKind(SyntaxKind.FunctionDeclaration) ||
          ancestor.isKind(SyntaxKind.ArrowFunction) ||
          ancestor.isKind(SyntaxKind.FunctionExpression)
      );
    if (!fn) continue;
    const described = describeFunctionName(fn);
    if (described.anonymous) continue;
    const sourceFile = literal.getSourceFile();
    const { line, column } = sourceFile.getLineAndColumnAtPos(literal.getStart());
    for (const property of properties) swallowed.add(property);
    emptyFindings.push({
      kind: 'empty-type',
      filePath: sourceFile.getFilePath(),
      line,
      column,
      name: described.label.replace(/`/g, ''),
      context: 'returned object',
      anonymous: false,
      swallowed: properties.length,
    });
  }
  return { emptyFindings, swallowed };
}

/**
 * A named type whose members are all reported, while the type itself is still
 * referenced, deserves the finding instead of its members: removing them
 * leaves an empty `interface X {}` behind, and only a human knows whether its
 * consumers should go too. The member findings it swallows are returned so
 * the caller can fold them away.
 */
function emptyOwnerFindings(reportedMembers: Set<Node>): { emptyFindings: Finding[]; swallowed: Set<Node> } {
  const owners = new Set<InterfaceDeclaration | TypeAliasDeclaration>();
  for (const member of reportedMembers) {
    const owner = namedOwner(member);
    if (owner) owners.add(owner);
  }

  const emptyFindings: Finding[] = [];
  const swallowed = new Set<Node>();
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
    for (const member of members) swallowed.add(member);
    emptyFindings.push({
      kind: 'empty-type',
      filePath: sourceFile.getFilePath(),
      line,
      column,
      name: owner.getName(),
      context: owner.isKind(SyntaxKind.InterfaceDeclaration) ? 'interface' : 'type',
      anonymous: false,
      swallowed: members.length,
    });
  }
  return { emptyFindings, swallowed };
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
