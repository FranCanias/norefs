import type { Node, SourceFile } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';

/** `// norefs-ignore` (with an optional reason after it) suppresses one finding. */
const LINE_MARK = /\/[/*]\s*norefs-ignore(?!-)/;
/** `// norefs-ignore-block` suppresses a declaration and everything inside it. */
const BLOCK_MARK = /\/[/*]\s*norefs-ignore-block\b/;
/** `// norefs-ignore-file` before the first statement suppresses every finding in the file. */
const FILE_MARK = /\/[/*]\s*norefs-ignore-file\b/;

const lineCache = new WeakMap<SourceFile, { text: string; lines: string[]; blocks: boolean }>();

/**
 * True when this finding is suppressed: a `norefs-ignore` comment on the
 * node's line or the line above it, or a `norefs-ignore-block` comment on a
 * declaration the node sits inside.
 *
 * The two marks differ in reach on purpose. A declaration suppressed with the
 * line form counts as used, so the analysis still looks inside it for unused
 * members — suppressing an export keeps reporting its members. The block form
 * is the answer when that is not what you want: five flagged members of one
 * interface need one comment, not five.
 */
export function isNodeSuppressed(nameNode: Node): boolean {
  const sourceFile = nameNode.getSourceFile();
  const { line } = sourceFile.getLineAndColumnAtPos(nameNode.getStart());
  const { lines, blocks } = linesOf(sourceFile);
  const above = lines[line - 2] ?? '';
  // The line above only counts when it is a standalone comment; a trailing
  // comment there suppresses that line, not this one.
  if (LINE_MARK.test(lines[line - 1] ?? '') || (/^\s*\/[/*]/.test(above) && LINE_MARK.test(above))) return true;
  return blocks && isInsideIgnoredBlock(nameNode, sourceFile, lines);
}

/**
 * True when the node is, or sits inside, a declaration carrying a
 * `norefs-ignore-block` mark. The mark counts on the declaration's own line or
 * anywhere in the comments attached above it, so it reads the same whether the
 * declaration carries a doc comment or not, and in either order.
 *
 * Only files that hold the mark at all pay for this walk.
 */
function isInsideIgnoredBlock(node: Node, sourceFile: SourceFile, lines: string[]): boolean {
  for (let owner: Node | undefined = node; owner && !owner.isKind(SyntaxKind.SourceFile); owner = owner.getParent()) {
    const { line } = sourceFile.getLineAndColumnAtPos(owner.getStart());
    if (BLOCK_MARK.test(lines[line - 1] ?? '')) return true;
    if (owner.getLeadingCommentRanges().some(range => BLOCK_MARK.test(range.getText()))) return true;
  }
  return false;
}

/** True when a `norefs-ignore-file` comment appears before the file's first statement. */
export function isFileSuppressed(sourceFile: SourceFile): boolean {
  const text = sourceFile.getFullText();
  const firstStatement = sourceFile.getStatements()[0];
  const header = firstStatement ? text.slice(0, firstStatement.getStart()) : text;
  return FILE_MARK.test(header);
}

/** Cached line split, invalidated when --fix rewrites the file. */
function linesOf(sourceFile: SourceFile): { lines: string[]; blocks: boolean } {
  const text = sourceFile.getFullText();
  const cached = lineCache.get(sourceFile);
  if (cached && cached.text === text) return cached;
  const entry = { text, lines: text.split('\n'), blocks: BLOCK_MARK.test(text) };
  lineCache.set(sourceFile, entry);
  return entry;
}
