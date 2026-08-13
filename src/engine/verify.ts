import path from 'node:path';
import type { Project } from 'ts-morph';
import { ts } from 'ts-morph';

/**
 * The receipts behind `--fix`: a type-error inventory before the fixes, and
 * the errors that are new after them.
 *
 * Keys carry no positions — an edit above a pre-existing error must not make
 * it look new — so an error is the file it lives in, its code, and its
 * message, counted as a multiset.
 */
export function errorInventory(project: Project): Map<string, number> {
  const inventory = new Map<string, number>();
  for (const diagnostic of compilerErrors(project)) {
    const key = errorKey(diagnostic);
    inventory.set(key, (inventory.get(key) ?? 0) + 1);
  }
  return inventory;
}

/** Human-readable lines for every error not covered by the pre-fix inventory. */
export function newErrors(before: Map<string, number>, project: Project, cwd: string): string[] {
  const remaining = new Map(before);
  const fresh: string[] = [];
  for (const diagnostic of compilerErrors(project)) {
    const key = errorKey(diagnostic);
    const left = remaining.get(key) ?? 0;
    if (left > 0) {
      remaining.set(key, left - 1);
      continue;
    }
    fresh.push(describeError(diagnostic, cwd));
  }
  return fresh;
}

/** Every source file's text, so a failed verification can put things back. */
export function snapshotTexts(project: Project): Map<string, string> {
  const texts = new Map<string, string>();
  for (const sourceFile of project.getSourceFiles()) {
    texts.set(sourceFile.getFilePath(), sourceFile.getFullText());
  }
  return texts;
}

function compilerErrors(project: Project): ts.Diagnostic[] {
  const program = project.getProgram().compilerObject;
  return ts.getPreEmitDiagnostics(program).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
}

function errorKey(diagnostic: ts.Diagnostic): string {
  return [
    diagnostic.file?.fileName ?? '',
    diagnostic.code,
    ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
  ].join('|');
}

function describeError(diagnostic: ts.Diagnostic, cwd: string): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
  if (!diagnostic.file || diagnostic.start === undefined) return `TS${diagnostic.code}: ${message}`;
  const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${path.relative(cwd, diagnostic.file.fileName)}:${line + 1} TS${diagnostic.code}: ${message}`;
}
