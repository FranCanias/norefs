import type { InterfaceDeclaration, Node, ObjectLiteralExpression, Project, TypeAliasDeclaration } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import { collectCandidates } from '../collectors';
import { writtenProperty } from '../collectors/object-literals';
import type { FunctionLike } from '../collectors/returned-objects';
import { producerOf, returnedObjectLiterals } from '../collectors/returned-objects';
import { describeFunctionName } from '../describe';
import { buildReferenceIndex } from '../lookup/reference-index';
import { findReferencesAsNodes } from '../lookup/references';
import type { EmptyTypeFinding, Finding, FindingKind, MemberFinding } from '../types';
import { memberUsage, memberWriteSites } from './check';
import { lineAndColumnAt } from './location';
import type { ModuleOptions } from './modules';
import { analyzeModules } from './modules';
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
  kinds?: FindingKind[] | undefined;
  /** The directory evidence paths are made relative to. Defaults to the process cwd, read once here. */
  cwd?: string | undefined;
}

/** True when the requested kinds need the member analysis. */
export function needsMembers(kinds: FindingKind[] | undefined): boolean {
  return (
    kinds === undefined ||
    kinds.length === 0 ||
    // A stranded handler is found through the wrapper that sends to it, and
    // that wrapper is usually a member.
    kinds.some(kind => kind === 'member' || kind === 'empty-type' || kind === 'stranded')
  );
}

export function analyze(project: Project, options: AnalyzeOptions = {}): Finding[] {
  const cwd = options.cwd ?? process.cwd();
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
    // A harness reference is no reference when the harness is treated as absent,
    // so what would be `test-only` is simply unused.
    const found = memberUsage(member, sf => modules.harnessFiles.has(sf));
    const usage = options.production && found === 'test-only' ? 'unused' : found;
    if (usage === 'used') continue;
    const sourceFile = member.getSourceFile();
    const { line, column } = lineAndColumnAt(sourceFile, nameNode.getStart());
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
      // A member every reference writes carries its writes from here. The
      // references are the proof, so the verdict pass has no name matching to
      // do — it reads them, words them, and hands them to the fix.
      ...(usage === 'write-only' ? { writeSites: memberWriteSites(member) } : {}),
      ...(usage === 'test-only' ? { verdict: 'test-only' as const, evidence: 'only test files reference it' } : {}),
    });
  }

  const folds = [...emptyOwnerFindings(reportedMembers), ...emptyReturnedObjectFindings(reportedMembers)];
  findings.push(...folds);
  const deadFilePaths = new Set<string>([...modules.deadFiles].map(sf => sf.getFilePath()));
  assignVerdicts(project, findings, cwd, filePath => deadFilePaths.has(filePath));
  // A far side earns a finding on the same terms as everything else: nothing
  // already reported covers it, it sits inside the scope this run was asked
  // for, and nobody suppressed it.
  const reportFarSide = (far: Node): boolean => {
    const sourceFile = far.getSourceFile();
    if (modules.deadFiles.has(sourceFile)) return false;
    if (far.getAncestors().some(ancestor => modules.deadDecls.has(ancestor))) return false;
    if (modules.harnessFiles.has(sourceFile)) return false;
    if (options.scopeDir && !sourceFile.getFilePath().startsWith(options.scopeDir)) return false;
    if (isFileSuppressed(sourceFile)) return false;
    return !isNodeSuppressed(far);
  };
  findings.push(...annotateStrandedChannels(project, findings, cwd, { reportFarSide, boundaries: options.boundaries }));
  // One logical fact, one finding: a type losing every member is the story,
  // not seven bullets. The members fold in after they lent it their verdict.
  // A strand note on a member about to fold must survive on the finding that
  // replaces it, or the far side vanishes exactly when the whole wrapper dies.
  const memberFindings = findings.filter((f): f is MemberFinding => f.kind === 'member');
  for (const empty of folds) {
    if (empty.strands !== undefined) continue;
    const owned = new Set(empty.members);
    const donor = memberFindings.find(f => owned.has(f.node) && f.strands !== undefined);
    if (donor?.strands !== undefined) empty.strands = donor.strands;
  }
  const swallowed = new Set(folds.flatMap(empty => empty.members));
  const folded = findings.filter(f => !(f.kind === 'member' && swallowed.has(f.node)));
  folded.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line || a.column - b.column);
  return folded;
}

/**
 * The producer half of a dead slice: a function whose returned object loses
 * every property. Nobody reads what it computes, so the computation itself is
 * the finding, not the properties one by one.
 *
 * A function with several `return` statements has to lose all of them. One
 * branch keeping a property its callers read means the call still produces
 * something, and the whole slice is not dead.
 */
function emptyReturnedObjectFindings(reportedMembers: Set<Node>): EmptyTypeFinding[] {
  const producers = new Map<FunctionLike, ObjectLiteralExpression[]>();
  for (const member of reportedMembers) {
    const literal = member.getParent();
    if (!literal?.isKind(SyntaxKind.ObjectLiteralExpression)) continue;
    const fn = producerOf(literal);
    if (!fn || producers.has(fn)) continue;
    // A literal nested one property in can lose every member while the return
    // value keeps the property that holds it, and "nobody reads what this
    // returns" would then be false. Only the shapes handed back count.
    const returned = returnedObjectLiterals(fn);
    if (returned.includes(literal)) producers.set(fn, returned);
  }

  const folds: EmptyTypeFinding[] = [];
  for (const [fn, literals] of producers) {
    const anchor = literals[0];
    if (!anchor) continue;
    const properties = literals.flatMap(literal => literal.getProperties());
    if (properties.length === 0 || !properties.every(property => reportedMembers.has(property))) continue;
    const described = describeFunctionName(fn);
    if (described.anonymous) continue;
    const sourceFile = anchor.getSourceFile();
    const { line, column } = lineAndColumnAt(sourceFile, anchor.getStart());
    folds.push({
      kind: 'empty-type',
      filePath: sourceFile.getFilePath(),
      line,
      column,
      name: described.name,
      context: 'returned object',
      anonymous: false,
      // What the return value offers, not how many lines write it. Two
      // branches writing the same key offer one property between them.
      swallowed: new Set(properties.map(property => writtenProperty(property)?.key)).size,
      members: properties,
    });
  }
  return folds;
}

/**
 * A named type whose members are all reported, while the type itself is still
 * referenced, deserves the finding instead of its members: removing them
 * leaves an empty `interface X {}` behind, and only a human knows whether its
 * consumers should go too. The member findings it swallows are returned so
 * the caller can fold them away.
 */
function emptyOwnerFindings(reportedMembers: Set<Node>): EmptyTypeFinding[] {
  const owners = new Set<InterfaceDeclaration | TypeAliasDeclaration>();
  for (const member of reportedMembers) {
    const owner = namedOwner(member);
    if (owner) owners.add(owner);
  }

  const folds: EmptyTypeFinding[] = [];
  for (const owner of owners) {
    const members = ownerMembers(owner);
    if (members.length === 0 || !members.every(member => reportedMembers.has(member))) continue;
    // An empty interface that still extends something is an alias, not a leftover.
    if (owner.isKind(SyntaxKind.InterfaceDeclaration) && owner.getHeritageClauses().length > 0) continue;
    const nameNode = owner.getNameNode();
    if (isNodeSuppressed(nameNode)) continue;
    if (!findReferencesAsNodes(nameNode).some(ref => ref !== nameNode)) continue;
    const sourceFile = owner.getSourceFile();
    const { line, column } = lineAndColumnAt(sourceFile, nameNode.getStart());
    folds.push({
      kind: 'empty-type',
      filePath: sourceFile.getFilePath(),
      line,
      column,
      name: owner.getName(),
      context: owner.isKind(SyntaxKind.InterfaceDeclaration) ? 'interface' : 'type',
      anonymous: false,
      swallowed: members.length,
      members,
    });
  }
  return folds;
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
