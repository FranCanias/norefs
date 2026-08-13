import type { Node, SourceFile } from 'ts-morph';

/** `// norefs-ignore` (with an optional reason after it) suppresses one finding. */
const LINE_MARK = /\/[/*]\s*norefs-ignore(?!-)/;
/** `// norefs-ignore-file` before the first statement suppresses every finding in the file. */
const FILE_MARK = /\/[/*]\s*norefs-ignore-file\b/;

const lineCache = new WeakMap<SourceFile, { text: string; lines: string[] }>();

/**
 * True when a `norefs-ignore` comment sits on the node's line or the line
 * above it. A suppressed declaration counts as used, so the analysis still
 * looks inside it for unused members.
 */
export function isNodeSuppressed(nameNode: Node): boolean {
  const sourceFile = nameNode.getSourceFile();
  const { line } = sourceFile.getLineAndColumnAtPos(nameNode.getStart());
  const lines = linesOf(sourceFile);
  const above = lines[line - 2] ?? '';
  // The line above only counts when it is a standalone comment; a trailing
  // comment there suppresses that line, not this one.
  return LINE_MARK.test(lines[line - 1] ?? '') || (/^\s*\/[/*]/.test(above) && LINE_MARK.test(above));
}

/** True when a `norefs-ignore-file` comment appears before the file's first statement. */
export function isFileSuppressed(sourceFile: SourceFile): boolean {
  const text = sourceFile.getFullText();
  const firstStatement = sourceFile.getStatements()[0];
  const header = firstStatement ? text.slice(0, firstStatement.getStart()) : text;
  return FILE_MARK.test(header);
}

/** Cached line split, invalidated when --fix rewrites the file. */
function linesOf(sourceFile: SourceFile): string[] {
  const text = sourceFile.getFullText();
  const cached = lineCache.get(sourceFile);
  if (cached && cached.text === text) return cached.lines;
  const lines = text.split('\n');
  lineCache.set(sourceFile, { text, lines });
  return lines;
}
