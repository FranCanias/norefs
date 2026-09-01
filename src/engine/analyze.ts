import type {
  InterfaceDeclaration,
  Node,
  ObjectLiteralExpression,
  Project,
  PropertyAssignment,
  PropertyDeclaration,
  PropertySignature,
  TypeAliasDeclaration,
  VariableDeclaration,
} from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import { collectCandidates } from '../collectors';
import { shapesHeldBy, writtenProperty } from '../collectors/object-literals';
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
  // Keyed by node, valued by the finding: a fold inherits how its members were
  // named as well as which ones they were.
  const reportedMembers = new Map<Node, MemberFinding>();

  for (const { member, context, anonymous } of members ? collectCandidates(project, options) : []) {
    // An unused file or a declaration with zero references is already reported
    // as a whole; listing every member inside it would only add noise.
    if (modules.deadFiles.has(member.getSourceFile())) continue;
    if (member.getAncestors().some(ancestor => modules.deadDecls.has(ancestor))) continue;
    // A member of a public-API type is read by consumers outside this program
    // — whether the entry exports the type by name or hands it back from a
    // function whose signature names it.
    const ancestors = member.getAncestors();
    if (ancestors.some(ancestor => modules.publicDecls.has(ancestor) || modules.publicShapes.has(ancestor))) continue;
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
    const finding: MemberFinding = {
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
      // Code beside the program can hold this shape, and a member is not a
      // name an import clause carries — so the scan out there settles nothing
      // and neither does the type check, which never held those files. The
      // finding stands; the fix waits for a human.
      ...(ancestors.some(ancestor => modules.outsideShapes.has(ancestor)) ? { unwitnessed: true } : {}),
      ...(usage === 'test-only' ? { verdict: 'test-only' as const, evidence: 'only test files reference it' } : {}),
    };
    findings.push(finding);
    // Only truly unused members feed the empty-type fold: a test-only member
    // needs its tests deleted with it, which is not an emptied type's story.
    if (usage === 'unused') reportedMembers.set(member, finding);
  }

  const folds = [
    ...emptyOwnerFindings(reportedMembers),
    ...emptyReturnedObjectFindings(reportedMembers),
    ...emptyInlineShapeFindings(reportedMembers),
  ];
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
function emptyReturnedObjectFindings(reportedMembers: ReadonlyMap<Node, MemberFinding>): EmptyTypeFinding[] {
  const producers = new Map<FunctionLike, ObjectLiteralExpression[]>();
  for (const member of reportedMembers.keys()) {
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
function emptyOwnerFindings(reportedMembers: ReadonlyMap<Node, MemberFinding>): EmptyTypeFinding[] {
  const owners = new Set<InterfaceDeclaration | TypeAliasDeclaration>();
  for (const member of reportedMembers.keys()) {
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

/**
 * Something carrying a shape of its own: `outer: { … }` written as a value or
 * as a type, or the binding of `const box = { … }`.
 */
type ShapeHolder = PropertyAssignment | PropertySignature | PropertyDeclaration | VariableDeclaration;

/**
 * A property or a binding that holds a shape and loses every member of it. The
 * shape has no declaration to answer for it — it is written inline, on the
 * holder — so the holder is what a reader would delete, and the holder is the
 * finding.
 *
 * The holder itself stays read: that is the only reason the analysis ever
 * looked inside it. A nested shape is read member by member exactly where
 * every read of the holding property keeps the value local, so a fold here
 * always leaves a read behind that reaches nothing. Removing the holder
 * means removing that read too, and only a human knows what it was for —
 * which is why `--fix` leaves this finding alone, as it does an emptied
 * interface. Without the fold, `--fix` would empty the brackets and leave
 * `outer: {}` sitting there, dead and now invisible to the next run.
 */
function emptyInlineShapeFindings(reportedMembers: ReadonlyMap<Node, MemberFinding>): EmptyTypeFinding[] {
  const holders = new Set<ShapeHolder>();
  for (const member of reportedMembers.keys()) {
    const holder = shapeHolderOf(member);
    // A holder reported dead in its own right already owns every death under it.
    if (holder && !reportedMembers.has(holder)) holders.add(holder);
  }

  const folds: EmptyTypeFinding[] = [];
  for (const holder of holders) {
    if (!holderKeepsAReader(holder)) continue;
    const members = heldShapeMembers(holder);
    const first = members[0];
    if (!first || !members.every(member => reportedMembers.has(member))) continue;
    const nameNode = holder.getNameNode();
    if (isNodeSuppressed(nameNode)) continue;
    const sourceFile = holder.getSourceFile();
    const { line, column } = lineAndColumnAt(sourceFile, nameNode.getStart());
    folds.push({
      kind: 'empty-type',
      filePath: sourceFile.getFilePath(),
      line,
      column,
      name: holder.getName(),
      context: holder.isKind(SyntaxKind.VariableDeclaration) ? 'const' : 'property',
      // An inline shape is as nameless as the members inside it, so `--anon`
      // must hide the fold wherever it hid them.
      anonymous: reportedMembers.get(first)?.anonymous ?? false,
      // What the shape offers, not how many lines write it. Sibling elements
      // of an array writing one key offer one member between them.
      swallowed: new Set(members.map(member => reportedMembers.get(member)?.name)).size,
      members,
    });
  }
  return folds;
}

/**
 * The property or binding that holds the shape this member belongs to. A
 * member of a shape some declaration owns has none — that declaration answers
 * for it.
 *
 * Only a shape the holder holds outright counts. `outer: A | B` puts two
 * shapes behind one property, and emptying one says nothing about the other.
 */
function shapeHolderOf(member: Node): ShapeHolder | undefined {
  const shape = member.getParent();
  if (shape?.isKind(SyntaxKind.ObjectLiteralExpression)) {
    const holder = enclosingValueHolder(shape);
    // One of the same shapes the collector descended into — `as const`,
    // parentheses and the array brackets aside. A cast to a named type hands
    // the shape to that type, and the type collectors report it there.
    return holder && shapesHeldBy(holder)?.literals.includes(shape) ? holder : undefined;
  }
  if (shape?.isKind(SyntaxKind.TypeLiteral)) {
    const parent = shape.getParent();
    const held =
      (parent?.isKind(SyntaxKind.PropertySignature) || parent?.isKind(SyntaxKind.PropertyDeclaration)) &&
      parent.getTypeNode() === shape;
    return held ? parent : undefined;
  }
  return undefined;
}

/**
 * The property assignment or binding this literal is the value of, past the
 * wrappers a value may wear — and past the array brackets, where the holder
 * holds one shape per element and they empty together or not at all.
 */
function enclosingValueHolder(literal: ObjectLiteralExpression): PropertyAssignment | VariableDeclaration | undefined {
  let current: Node = literal;
  while (true) {
    const parent = current.getParent();
    if (parent?.isKind(SyntaxKind.PropertyAssignment)) return parent;
    if (parent?.isKind(SyntaxKind.VariableDeclaration)) return parent;
    if (
      parent?.isKind(SyntaxKind.ParenthesizedExpression) ||
      parent?.isKind(SyntaxKind.AsExpression) ||
      parent?.isKind(SyntaxKind.ArrayLiteralExpression)
    ) {
      current = parent;
      continue;
    }
    return undefined;
  }
}

/**
 * Everything the held shape declares, spreads and index signatures included.
 * Neither is ever a reported member, so a shape holding one never folds — and
 * never loses the members it carries along.
 */
function heldShapeMembers(holder: ShapeHolder): Node[] {
  if (holder.isKind(SyntaxKind.PropertySignature) || holder.isKind(SyntaxKind.PropertyDeclaration)) {
    const typeNode = holder.getTypeNode();
    return typeNode?.isKind(SyntaxKind.TypeLiteral) ? typeNode.getMembers() : [];
  }
  return shapesHeldBy(holder)?.literals.flatMap(literal => literal.getProperties()) ?? [];
}

/**
 * True when something still reaches this holder, which is what makes an
 * emptied shape a finding rather than a deletion: the read that survives is
 * the part no fix can answer for.
 *
 * A property is read by construction — the descent into its shape only happens
 * where the reads keep the value local, and there has to be a read for that to
 * mean anything. A binding is not: `const box = { … }` that nothing reads is
 * dead in full, and `--fix` already removes the whole declaration once its
 * members go. Folding there would stand in the way of a clean removal.
 */
function holderKeepsAReader(holder: ShapeHolder): boolean {
  if (!holder.isKind(SyntaxKind.VariableDeclaration)) return true;
  return findReferencesAsNodes(holder.getNameNode()).length > 0;
}
