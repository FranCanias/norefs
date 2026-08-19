import path from 'node:path';
import type { Node } from 'ts-morph';

// Naming a coordinate, nothing more — which is why reporters, the fix
// campaign, and the verdict evidence can all share it without sharing policy.

/** One canonical `relative/path:line` coordinate, shared by every reporter. */
export function formatLocation(filePath: string, line: number, cwd: string): string {
  return `${path.relative(cwd, filePath)}:${line}`;
}

/** The same coordinate, read off a node. */
export function location(node: Node, cwd: string): string {
  const sourceFile = node.getSourceFile();
  const { line } = sourceFile.getLineAndColumnAtPos(node.getStart());
  return formatLocation(sourceFile.getFilePath(), line, cwd);
}
