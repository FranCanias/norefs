import path from 'node:path';
import type { Node, SourceFile } from 'ts-morph';
import { ts } from 'ts-morph';

// Naming a coordinate, nothing more — which is why reporters, the fix
// campaign, and the verdict evidence can all share it without sharing policy.

/** One canonical `relative/path:line` coordinate, shared by every reporter. */
export function formatLocation(filePath: string, line: number, cwd: string): string {
  return `${path.relative(cwd, filePath)}:${line}`;
}

/**
 * One-based line and column at an offset, off the compiler's cached line
 * table. ts-morph's own `getLineAndColumnAtPos` counts newlines from byte
 * zero on every call — about 50× the cost on a large file.
 */
export function lineAndColumnAt(sourceFile: SourceFile, pos: number): { line: number; column: number } {
  const { line, character } = ts.getLineAndCharacterOfPosition(sourceFile.compilerNode, pos);
  return { line: line + 1, column: character + 1 };
}

/** The one-based line a node starts on. */
export function startLine(node: Node): number {
  return lineAndColumnAt(node.getSourceFile(), node.getStart()).line;
}

/** The one-based line a node ends on. */
export function endLine(node: Node): number {
  return lineAndColumnAt(node.getSourceFile(), node.getEnd()).line;
}

/** The same coordinate, read off a node. */
export function location(node: Node, cwd: string): string {
  return formatLocation(node.getSourceFile().getFilePath(), startLine(node), cwd);
}
