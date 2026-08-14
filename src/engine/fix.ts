import type {
  ArrayLiteralExpression,
  ExportSpecifier,
  Identifier,
  ImportDeclaration,
  ImportSpecifier,
  Node,
  SourceFile,
  VariableDeclaration,
} from 'ts-morph';
import { Node as NodeGuards, SyntaxKind, ts } from 'ts-morph';
import type { Finding } from '../types';
import { declarationNameNode } from './modules';
import { findReferencesAsNodes } from './references';

/** Nothing to skip while walking a file for uses. */
const NO_NODES: ReadonlySet<ts.Node> = new Set();

interface FixResult {
  /** Paths of the files that changed. */
  filePaths: string[];
  fixed: number;
  /** Findings --fix leaves for the user: unused files, namespace findings, emptied types. */
  skipped: number;
  /**
   * Comments that sit next to a fix but were kept: the leading comment of a
   * statement a fix edited without removing, or a comment one blank line
   * above a removed declaration. No heuristic can fix prose, so the fixer
   * points a human at it instead.
   */
  keptComments: CommentLocation[];
}

export interface CommentLocation {
  filePath: string;
  line: number;
  /** The comment's first line, so a later pass that moves it can be re-found. */
  text: string;
}

/**
 * Fix the findings and save the touched files, gated by verdict.
 *
 * A `dead` or `over-exported` finding auto-fixes: an export with zero
 * references anywhere is removed whole, together with any import/export
 * specifiers that forward it; an over-exported declaration only loses the
 * export keyword; a dead member is deleted (a parameter property only loses
 * its modifiers and stays a plain parameter, so the constructor signature and
 * every call site keep working). A `write-only`, `contract`, or `shadowed`
 * member is a claim the analysis cannot prove — it needs `options.unsafe`.
 * Orphaned identifiers left behind in touched files (an import only the
 * removed code used) are cleaned up before saving. Unused files, namespace
 * findings, and emptied types are never touched.
 */
/** True when --fix may act on this finding, given the unsafe opt-in. */
export function isFixable(finding: Finding, unsafe: boolean): boolean {
  // package.json entries are edited as text, outside the verified campaign —
  // no type check reads a manifest. They ride with --fix-unsafe for that
  // reason, and `applyFixes` never sees them.
  if (finding.kind === 'dependency' || finding.kind === 'misplaced') return unsafe;
  if (finding.kind !== 'export' && finding.kind !== 'type' && finding.kind !== 'member') return false;
  // A test-only finding is never fixable: the fix is deleting the code
  // together with its tests, and only a human deletes tests.
  if (finding.verdict === 'test-only') return false;
  // A fix must finish the finding it acts on. A proven write-only member goes
  // with the writes that prove it — and when one of those writes cannot be
  // removed on its own, the whole finding waits for a human.
  if (unremovableWrites(finding).length > 0) return false;
  return finding.verdict === 'dead' || finding.verdict === 'over-exported' || unsafe;
}

/**
 * The proven write sites of a finding that no single edit can retire. A
 * spread is the case: `{ ...base }` carries members beyond this one, so
 * deleting it would take live code with it.
 */
export function unremovableWrites(finding: Finding): Node[] {
  return (finding.writeSites ?? []).filter(site => !site.wasForgotten() && writeToRemove(site) === undefined);
}

/**
 * The node that retires a write site: the whole property assignment or method
 * the recorded name belongs to. A site of any other shape — a spread, which
 * carries members beyond this one — has no edit of its own.
 */
function writeToRemove(site: Node): Node | undefined {
  const parent = site.getParent();
  const assignment = parent?.isKind(SyntaxKind.ComputedPropertyName) ? parent.getParent() : parent;
  if (
    assignment?.isKind(SyntaxKind.PropertyAssignment) ||
    assignment?.isKind(SyntaxKind.ShorthandPropertyAssignment) ||
    assignment?.isKind(SyntaxKind.MethodDeclaration)
  ) {
    return assignment;
  }
  return undefined;
}

/**
 * A fix the editor could not carry out. The campaign holds the finding back
 * and names the reason, exactly as it does for a fix the type check rejects: a
 * fix that cannot be applied is one finding's problem, never the run's.
 */
export class UnappliedFix extends Error {
  constructor(
    readonly finding: Finding,
    readonly reason: string,
    /** Every file the abandoned run may have edited, so the caller can roll it back. */
    readonly filePaths: string[]
  ) {
    super(reason);
    this.name = 'UnappliedFix';
  }
}

/** The first line of whatever was thrown — a ts-morph error carries a whole dump. */
function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0].trim();
}

export function applyFixes(findings: Finding[], options: { save?: boolean; unsafe?: boolean } = {}): FixResult {
  const fixable = findings.filter(f => isFixable(f, options.unsafe ?? false));
  let skipped = findings.length - fixable.length;

  // The comments beside the properties these fixes delete come out first, as
  // text: no node-level edit reaches them, and left in place they turn the
  // next removal into a syntax error.
  const stripped = stripTrailingComments(fixable);

  // Fix inner nodes before outer ones, so a member nested inside another
  // finding (an object literal inside a dead method) is still valid when its
  // turn comes.
  const sorted = [...fixable].sort((a, b) =>
    a.filePath === b.filePath
      ? (b.node?.getStart() ?? 0) - (a.node?.getStart() ?? 0)
      : a.filePath.localeCompare(b.filePath)
  );

  // Every reference query runs before the first edit, while the analysis
  // index still matches the project. The specifiers it hands back stay valid
  // across the edits — ts-morph remaps wrapped nodes a manipulation did not
  // remove — and the ones an earlier fix did remove are skipped as forgotten.
  const specifiers = new Map<Finding, Array<ImportSpecifier | ExportSpecifier>>();
  for (const finding of sorted) {
    if (finding.kind === 'member' || !finding.node) continue;
    const nameNode = declarationNameNode(finding.node);
    if (nameNode) specifiers.set(finding, danglingSpecifiers(nameNode));
  }

  const touched = new Set<SourceFile>(stripped);
  const kept = new Set<Node>();
  let fixed = 0;
  for (const finding of sorted) {
    const node = finding.node;
    if (!node) continue;
    // An earlier fix already removed the very node this one is about: a write
    // site retired with its member can be a member of its own literal. The
    // finding is gone from the code, so it counts as fixed.
    if (node.wasForgotten()) {
      fixed++;
      continue;
    }
    let changed: SourceFile[];
    try {
      changed =
        finding.kind === 'member'
          ? fixMember(finding, node, kept)
          : fixExport(finding, node, specifiers.get(finding) ?? [], kept);
    } catch (error) {
      // The editor refused this edit. That is this finding's answer, not the
      // run's: the campaign rolls back and tries again without it. Every file
      // the half-done fix could have reached goes with the report, so nothing
      // it wrote survives the rollback.
      const reachable = new Set(touched);
      reachable.add(node.getSourceFile());
      for (const site of finding.writeSites ?? []) if (!site.wasForgotten()) reachable.add(site.getSourceFile());
      for (const spec of specifiers.get(finding) ?? []) if (!spec.wasForgotten()) reachable.add(spec.getSourceFile());
      throw new UnappliedFix(
        finding,
        firstLine(error),
        [...reachable].map(file => file.getFilePath())
      );
    }
    if (changed.length > 0) {
      for (const file of changed) touched.add(file);
      fixed++;
    } else {
      skipped++;
    }
  }

  cleanUpOrphans(touched, kept);

  const filePaths = [...touched].map(file => file.getFilePath());
  if (options.save ?? true) {
    for (const file of touched) file.saveSync();
  }
  return { filePaths, fixed, skipped, keptComments: commentLocations(kept) };
}

/** Where a node sat, so a text pass that forgets it can hand it back. */
interface Anchor {
  sourceFile: SourceFile;
  start: number;
  kind: SyntaxKind;
}

/**
 * Remove the comment beside every object literal property these fixes delete:
 * `canvas, // light: #F9F9FA`. It describes that property and nothing else, so
 * it goes when the property goes — and it has to go first. ts-morph removes a
 * property without the trivia behind it, and the leftover lands where the next
 * property belongs: the following removal in that literal throws, and whatever
 * output the run did produce carries the comment on a line it never described.
 * Object literal properties are the only shape with the problem; statements,
 * class members, interface members, and enum members already take their
 * trailing comment with them.
 *
 * No node-level edit spans a node and the trivia behind it, so these come out
 * as text, one pass per file — which forgets every node in that file. Each
 * finding gets its nodes back, re-found where the pass leaves them.
 *
 * Returns the files it rewrote.
 */
function stripTrailingComments(findings: Finding[]): SourceFile[] {
  const cuts = new Map<SourceFile, Array<[number, number]>>();
  for (const finding of findings) {
    for (const node of deletedNodes(finding)) {
      if (!node.getParent()?.isKind(SyntaxKind.ObjectLiteralExpression)) continue;
      const cut = trailingComment(node);
      if (!cut) continue;
      const sourceFile = node.getSourceFile();
      cuts.set(sourceFile, [...(cuts.get(sourceFile) ?? []), cut]);
    }
  }
  if (cuts.size === 0) return [];

  const anchors = new Map<Finding, { node?: Anchor; sites: Anchor[] }>();
  for (const finding of findings) {
    anchors.set(finding, {
      node: finding.node && anchorOf(finding.node),
      sites: (finding.writeSites ?? []).map(anchorOf),
    });
  }

  for (const [sourceFile, ranges] of cuts) {
    const text = sourceFile.getFullText();
    ranges.sort((a, b) => a[0] - b[0]);
    let kept = '';
    let read = 0;
    for (const [start, end] of ranges) {
      kept += text.slice(read, start);
      read = end;
    }
    sourceFile.replaceWithText(kept + text.slice(read));
  }

  for (const finding of findings) {
    const anchored = anchors.get(finding);
    if (!anchored) continue;
    const back = (anchor: Anchor): Node => {
      const ranges = cuts.get(anchor.sourceFile) ?? [];
      const moved = ranges.reduce((sum, [start, end]) => (end <= anchor.start ? sum + (end - start) : sum), 0);
      const node = refind(anchor.sourceFile, anchor.start - moved, anchor.kind);
      if (!node) {
        const reason = 'the comment beside it could not be separated from the code';
        throw new UnappliedFix(
          finding,
          reason,
          [...cuts.keys()].map(file => file.getFilePath())
        );
      }
      return node;
    };
    if (anchored.node) finding.node = back(anchored.node);
    if (finding.writeSites) finding.writeSites = anchored.sites.map(back);
  }
  return [...cuts.keys()];
}

/** The nodes a fix deletes outright — the ones whose comments orphan. */
function deletedNodes(finding: Finding): Node[] {
  const nodes: Node[] = [];
  for (const site of finding.writeSites ?? []) {
    const write = writeToRemove(site);
    if (write) nodes.push(write);
  }
  const node = finding.node;
  if (!node) return nodes;
  // A parameter property keeps its parameter and loses only its modifiers; an
  // over-exported declaration keeps every line but the `export` keyword.
  if (finding.kind === 'member' ? !node.isKind(SyntaxKind.Parameter) : finding.dead) nodes.push(node);
  return nodes;
}

/**
 * The comment beside a node: same line, after any comma, with nothing but the
 * line break behind it. A comment with code after it on the line introduces
 * that code and stays where it is.
 */
function trailingComment(node: Node): [number, number] | undefined {
  const text = node.getSourceFile().getFullText();
  let pos = node.getEnd();
  while (text[pos] === ' ' || text[pos] === '\t') pos++;
  const from = text[pos] === ',' ? ++pos : node.getEnd();
  const ranges = ts.getTrailingCommentRanges(text, pos) ?? [];
  const last = ranges[ranges.length - 1];
  if (!last) return undefined;
  let after = last.end;
  while (text[after] === ' ' || text[after] === '\t') after++;
  if (after < text.length && text[after] !== '\n' && text[after] !== '\r') return undefined;
  return [from, last.end];
}

function anchorOf(node: Node): Anchor {
  return { sourceFile: node.getSourceFile(), start: node.getStart(), kind: node.getKind() };
}

/** The same node after a text pass forgot it: same place, same kind. */
function refind(sourceFile: SourceFile, start: number, kind: SyntaxKind): Node | undefined {
  let node = sourceFile.getDescendantAtPos(start);
  while (node) {
    if (node.getKind() === kind && node.getStart() === start) return node;
    node = node.getParent();
  }
  return undefined;
}

/**
 * Resolved after every edit, so the line numbers are the ones on disk. A kept
 * node is either the comment itself or a statement whose leading comment is
 * the point of interest; either way the location is the comment's line.
 */
function commentLocations(kept: Set<Node>): CommentLocation[] {
  const locations: CommentLocation[] = [];
  for (const node of kept) {
    if (node.wasForgotten()) continue;
    const sourceFile = node.getSourceFile();
    const range = node.getLeadingCommentRanges()[0];
    const line = range ? sourceFile.getLineAndColumnAtPos(range.getPos()).line : node.getStartLineNumber();
    const text = (range ? range.getText() : node.getText()).split('\n')[0].trim();
    locations.push({ filePath: sourceFile.getFilePath(), line, text });
  }
  return locations.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line);
}

/**
 * Retire a member, and with it the writes that proved it write-only. Deleting
 * the declaration alone would leave those writes running into a shape no
 * named type describes — the finding itself, made undetectable. The writes go
 * first: their nodes belong to other files that must be saved too.
 */
function fixMember(finding: Finding, member: Node, kept: Set<Node>): SourceFile[] {
  const changed = new Set<SourceFile>([member.getSourceFile()]);
  const sources: VariableDeclaration[] = [];
  const dependencies: ArrayLiteralExpression[] = [];
  for (const site of finding.writeSites ?? []) {
    if (site.wasForgotten()) continue;
    const write = writeToRemove(site);
    if (!write || write.wasForgotten()) continue;
    changed.add(write.getSourceFile());
    sources.push(...writtenLocals(write));
    dependencies.push(...dependencyArrays(write));
    removeLeadingComments(write, kept);
    (write as unknown as { remove(): void }).remove();
  }
  removeOrphanedLocals(sources, dependencies, kept);

  if (member.isKind(SyntaxKind.Parameter)) {
    member.setHasOverrideKeyword(false);
    member.setIsReadonly(false);
    member.setScope(undefined);
  } else {
    removeLeadingComments(member, kept);
    (member as unknown as { remove(): void }).remove();
  }
  return [...changed];
}

/**
 * The locals a write hands to the member: `{ track }`, or `track: track`. The
 * property is their last reader, so once it goes the computation above is
 * dead weight — and in a project with `noUnusedLocals`, not even compilable.
 */
function writtenLocals(write: Node): VariableDeclaration[] {
  // A shorthand names the local directly; its own symbol is the property, so
  // the value behind it takes the checker's shorthand lookup.
  const source = write.isKind(SyntaxKind.ShorthandPropertyAssignment)
    ? write.getValueSymbol()
    : write.isKind(SyntaxKind.PropertyAssignment)
      ? write.getInitializer()?.asKind(SyntaxKind.Identifier)?.getSymbol()
      : undefined;
  const declaration = source?.getValueDeclaration();
  if (!declaration?.isKind(SyntaxKind.VariableDeclaration)) return [];
  if (declaration.getSourceFile() !== write.getSourceFile()) return [];
  if (declaration.getVariableStatement()?.hasExportKeyword()) return [];
  return [declaration];
}

/**
 * The dependency arrays of the call the write's factory was passed to:
 * `useMemo(() => ({ track }), [track])`. A dependency array does not read a
 * value, it decides when to recompute one — so an entry that was there for the
 * write we just removed is stale, not a reader.
 */
function dependencyArrays(write: Node): ArrayLiteralExpression[] {
  const factory = write.getFirstAncestor(
    node => node.isKind(SyntaxKind.ArrowFunction) || node.isKind(SyntaxKind.FunctionExpression)
  );
  const call = factory?.getParent();
  if (!factory || !call?.isKind(SyntaxKind.CallExpression)) return [];
  const args = call.getArguments();
  if (!args.includes(factory)) return [];
  return args.filter(argument => argument.isKind(SyntaxKind.ArrayLiteralExpression));
}

/**
 * Drop each local the removed writes left with no reader in its file — and the
 * stale dependency entries that were its last mention. Without that second
 * half the common React shape survives every check: the property is gone, the
 * computation above it still runs, and the dependency array keeps the local
 * "used" for both norefs and `noUnusedLocals`. That is the finding, made
 * invisible — the exact outcome removing the write is meant to prevent.
 */
function removeOrphanedLocals(
  declarations: VariableDeclaration[],
  dependencies: ArrayLiteralExpression[],
  kept: Set<Node>
): void {
  for (const declaration of declarations) {
    if (declaration.wasForgotten()) continue;
    const name = declaration.getNameNode();
    if (!name.isKind(SyntaxKind.Identifier)) continue;
    const stale = staleDependencies(name, dependencies);
    const excluded = new Set(stale.map(entry => entry.compilerNode));
    if (isUsedInFile(name, declaration.getSourceFile(), excluded)) continue;
    // Last entry first: removing one re-parses the file around the others.
    for (const entry of stale.sort((a, b) => b.getStart() - a.getStart())) {
      const array = entry.getParent();
      if (array?.isKind(SyntaxKind.ArrayLiteralExpression)) array.removeElement(entry);
    }
    removeDeclaration(declaration, kept);
  }
}

/** The entries of those arrays that are a bare mention of this local. */
function staleDependencies(name: Identifier, arrays: ArrayLiteralExpression[]): Identifier[] {
  const symbol = name.getSymbol();
  if (!symbol) return [];
  const entries: Identifier[] = [];
  for (const array of arrays) {
    if (array.wasForgotten()) continue;
    for (const element of array.getElements()) {
      if (element.isKind(SyntaxKind.Identifier) && element.getSymbol() === symbol) entries.push(element);
    }
  }
  return entries;
}

/**
 * Freestanding comment lines directly above a removed declaration described
 * it, and they orphan when it goes. JSDoc travels with the node already;
 * these are the plain comment lines ts-morph models as siblings. Only
 * adjacent lines go — a comment set apart by a blank line may describe the
 * whole section, and keeping it costs nothing. A comment kept at exactly one
 * blank line's distance is close enough that it may still describe the
 * deleted code, so it is recorded for the fix summary to point at.
 */
function removeLeadingComments(node: Node, kept: Set<Node>): void {
  const container = node.getParent() as
    | Partial<{
        getStatementsWithComments(): Node[];
        getMembersWithComments(): Node[];
        getPropertiesWithComments(): Node[];
      }>
    | undefined;
  const siblings =
    container?.getStatementsWithComments?.() ??
    container?.getMembersWithComments?.() ??
    container?.getPropertiesWithComments?.();
  if (!siblings) return;

  let index = siblings.indexOf(node);
  let above = node;
  const comments: Node[] = [];
  while (index > 0) {
    const previous = siblings[index - 1];
    const kind = previous.getKind();
    if (kind !== SyntaxKind.SingleLineCommentTrivia && kind !== SyntaxKind.MultiLineCommentTrivia) break;
    if (previous.getEndLineNumber() < above.getStartLineNumber() - 1) {
      if (previous.getEndLineNumber() === above.getStartLineNumber() - 2) kept.add(previous);
      break;
    }
    comments.push(previous);
    above = previous;
    index--;
  }
  for (const comment of comments) {
    (comment as unknown as { remove(): void }).remove();
  }
}

function fixExport(
  finding: Finding,
  decl: Node,
  specifiers: Array<ImportSpecifier | ExportSpecifier>,
  kept: Set<Node>
): SourceFile[] {
  const changed = new Set<SourceFile>();

  // First drop every import/export specifier that forwards the name — a barrel
  // re-export or an unused import would dangle once the export is gone.
  for (const specifier of specifiers) {
    if (specifier.wasForgotten()) continue; // an earlier fix removed its whole statement
    changed.add(specifier.getSourceFile());
    removeSpecifier(specifier, kept);
  }

  if (finding.dead) {
    changed.add(decl.getSourceFile());
    removeDeclaration(decl, kept);
    return [...changed];
  }

  if (NodeGuards.isExportable(decl) && decl.hasExportKeyword()) {
    decl.setIsExported(false);
    changed.add(decl.getSourceFile());
  } else if (decl.isKind(SyntaxKind.VariableDeclaration)) {
    const statement = decl.getVariableStatement();
    if (statement?.hasExportKeyword() && statement.getDeclarations().length === 1) {
      statement.setIsExported(false);
      changed.add(decl.getSourceFile());
    }
  }
  return [...changed];
}

/** Import/export specifiers anywhere in the project that forward the declaration's name. */
function danglingSpecifiers(nameNode: Identifier): Array<ImportSpecifier | ExportSpecifier> {
  const specifiers = new Set<ImportSpecifier | ExportSpecifier>();
  for (const ref of findReferencesAsNodes(nameNode)) {
    const parent = ref.getParent();
    if (parent?.isKind(SyntaxKind.ImportSpecifier) || parent?.isKind(SyntaxKind.ExportSpecifier)) {
      specifiers.add(parent);
    }
  }
  return [...specifiers];
}

/**
 * A statement that survives a specifier removal may keep a comment that
 * described what just left it — prose no heuristic can rewrite — so the
 * statement is recorded for the fix summary when a comment leads it.
 */
function removeSpecifier(specifier: ImportSpecifier | ExportSpecifier, kept: Set<Node>): void {
  if (specifier.isKind(SyntaxKind.ExportSpecifier)) {
    const exportDecl = specifier.getExportDeclaration();
    if (exportDecl.getNamedExports().length === 1) {
      exportDecl.remove();
    } else {
      if (exportDecl.getLeadingCommentRanges().length > 0) kept.add(exportDecl);
      specifier.remove();
    }
    return;
  }
  const importDecl = specifier.getImportDeclaration();
  const lastBinding =
    importDecl.getNamedImports().length === 1 && !importDecl.getDefaultImport() && !importDecl.getNamespaceImport();
  if (lastBinding) {
    importDecl.remove();
  } else {
    if (importDecl.getLeadingCommentRanges().length > 0) kept.add(importDecl);
    specifier.remove();
  }
}

function removeDeclaration(decl: Node, kept: Set<Node>): void {
  if (decl.isKind(SyntaxKind.VariableDeclaration)) {
    const statement = decl.getVariableStatement();
    if (statement && statement.getDeclarations().length === 1) {
      removeLeadingComments(statement, kept);
      statement.remove();
      return;
    }
  }
  removeLeadingComments(decl, kept);
  (decl as unknown as { remove(): void }).remove();
}

/**
 * Remove code the fixes orphaned: imports and unexported top-level declarations
 * that nothing references anymore. Each round first finds every orphan in
 * every touched file, then removes them all — queries never interleave with
 * edits, so the checker re-reads the project once per round rather than once
 * per question. One removal can orphan the next, so rounds repeat until the
 * files are stable.
 */
function cleanUpOrphans(files: Set<SourceFile>, kept: Set<Node>): void {
  for (let round = 0; round < 5; round++) {
    const removals: Array<() => void> = [];
    for (const file of files) {
      collectUnusedImports(file, removals);
      collectUnusedLocals(file, removals, kept);
    }
    if (removals.length === 0) return;
    for (const removal of removals) removal();
  }
}

function collectUnusedImports(file: SourceFile, removals: Array<() => void>): void {
  for (const importDecl of file.getImportDeclarations()) {
    const defaultImport = importDecl.getDefaultImport();
    const namespaceImport = importDecl.getNamespaceImport();
    const named = importDecl.getNamedImports();
    if (named.length === 0 && !defaultImport && !namespaceImport) continue; // A bare side-effect import stays.

    const unusedSpecifiers = named.filter(specifier => {
      const binding = specifier.getAliasNode() ?? specifier.getNameNode();
      return binding.isKind(SyntaxKind.Identifier) && !isBindingUsed(binding, file, importDecl);
    });
    const dropDefault = defaultImport !== undefined && !isBindingUsed(defaultImport, file, importDecl);
    const dropNamespace = namespaceImport !== undefined && !isBindingUsed(namespaceImport, file, importDecl);
    if (unusedSpecifiers.length === 0 && !dropDefault && !dropNamespace) continue;

    const emptied = unusedSpecifiers.length === named.length && (dropDefault || !defaultImport) && !namespaceImport;
    removals.push(() => {
      if (importDecl.wasForgotten()) return;
      if (emptied || (dropNamespace && named.length === 0 && (dropDefault || !defaultImport))) {
        importDecl.remove();
        return;
      }
      for (const specifier of unusedSpecifiers) {
        if (!specifier.wasForgotten()) specifier.remove();
      }
      if (dropDefault) importDecl.removeDefaultImport();
      if (dropNamespace) importDecl.removeNamespaceImport();
    });
  }
}

/**
 * True when anything in the file outside the import itself still reads the
 * binding. Answered from the file alone: the checker resolves each identifier
 * spelled like the binding, which never rebuilds the language service's
 * project-wide import tracker the way a find-references call would.
 */
function isBindingUsed(binding: Identifier, file: SourceFile, importDecl: ImportDeclaration): boolean {
  return isUsedInFile(binding, file, new Set([importDecl.compilerNode]));
}

/**
 * Remove unexported top-level declarations with zero references. A reference
 * from an `export { x }` list or an `export default x` keeps the declaration,
 * because those occurrences count as references. Exported declarations are
 * left to the analysis, which knows about entry files.
 */
function collectUnusedLocals(file: SourceFile, removals: Array<() => void>, kept: Set<Node>): void {
  for (const statement of file.getStatements()) {
    if (statement.isKind(SyntaxKind.VariableStatement)) {
      if (statement.hasExportKeyword() || statement.hasDeclareKeyword()) continue;
      for (const decl of statement.getDeclarations()) {
        const name = decl.getNameNode();
        if (name.isKind(SyntaxKind.Identifier) && !isUsedInFile(name, file)) {
          removals.push(() => {
            if (!decl.wasForgotten()) removeDeclaration(decl, kept);
          });
        }
      }
      continue;
    }
    if (
      statement.isKind(SyntaxKind.FunctionDeclaration) ||
      statement.isKind(SyntaxKind.ClassDeclaration) ||
      statement.isKind(SyntaxKind.InterfaceDeclaration) ||
      statement.isKind(SyntaxKind.TypeAliasDeclaration) ||
      statement.isKind(SyntaxKind.EnumDeclaration)
    ) {
      if (statement.isExported() || statement.hasDeclareKeyword()) continue;
      const name = statement.getNameNode();
      if (name?.isKind(SyntaxKind.Identifier) && !isUsedInFile(name, file)) {
        removals.push(() => {
          if (statement.wasForgotten()) return;
          removeLeadingComments(statement, kept);
          statement.remove();
        });
      }
    }
  }
}

/**
 * True when an identifier outside `exclude` (and outside the declaration
 * itself) resolves to the same symbol the name declares. A shorthand property
 * and an `export { x }` specifier name the symbol without resolving to it
 * directly, so those ask the checker their own way. When the name resolves to
 * nothing, the declaration is kept: proof, not absence of proof, removes code.
 */
function isUsedInFile(name: Identifier, file: SourceFile, exclude: ReadonlySet<ts.Node> = NO_NODES): boolean {
  const checker = file.getProject().getTypeChecker().compilerObject;
  const target = checker.getSymbolAtLocation(name.compilerNode);
  if (!target) return true;
  const text = name.compilerNode.text;

  let used = false;
  const visit = (node: ts.Node): void => {
    if (used) return;
    if (exclude.has(node)) return;
    if (ts.isIdentifier(node) && node.text === text && node !== name.compilerNode) {
      const parent = node.parent;
      if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
        if (checker.getShorthandAssignmentValueSymbol(parent) === target) {
          used = true;
          return;
        }
      }
      if (ts.isExportSpecifier(parent) && (parent.propertyName ?? parent.name) === node) {
        if (checker.getExportSpecifierLocalTargetSymbol(parent) === target) {
          used = true;
          return;
        }
      }
      if (checker.getSymbolAtLocation(node) === target) {
        used = true;
        return;
      }
    }
    node.forEachChild(visit);
  };
  file.compilerNode.forEachChild(visit);
  return used;
}
