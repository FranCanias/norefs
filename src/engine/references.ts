import type { Node, Project, SourceFile } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';

/**
 * Every reference to a declaration, as nodes.
 *
 * ts-morph's own `findReferencesAsNodes` goes through the language service's
 * `findReferences`, which is built for editors: besides the reference spans it
 * describes each group's definition, and that description renders the
 * definition's type as a string. Rendering a deeply recursive generic type can
 * exhaust the heap — one call on such a type grows past 6 GB and kills the
 * process. noref reads the spans and nothing else, so it
 * asks for the spans alone: the same call then costs milliseconds.
 */
export function findReferencesAsNodes(target: Node): Node[] {
  const project = target.getProject();
  const service = project.getLanguageService().compilerObject;
  const entries = service.getReferencesAtPosition(target.getSourceFile().getFilePath(), target.getStart()) ?? [];
  // The declaration leading the list is not a use of itself. Entries come in
  // source order, so a name used before it is declared — a hoisted function,
  // a property assignment answering an interface — puts a real use first and
  // the declaration stays in the list, which is what callers expect. An import
  // or export binding always stays: forwarding a name is a reference.
  const keepFirst = isAliasBinding(target);

  const nodes: Node[] = [];
  for (const [index, entry] of entries.entries()) {
    const sourceFile = sourceFileFor(project, entry.fileName);
    const found = nodeAt(sourceFile, entry.textSpan.start, entry.textSpan.length);
    if (!found) continue;
    if (index === 0 && found === target && !keepFirst) continue;
    nodes.push(found);
  }
  return nodes;
}

/**
 * The node a reference span points at. A reference inside a string literal
 * spans the text between the quotes, which is no node at all; the node holding
 * that text is the reference.
 */
function nodeAt(sourceFile: SourceFile | undefined, start: number, length: number): Node | undefined {
  return sourceFile?.getDescendantAtStartWithWidth(start, length) ?? sourceFile?.getDescendantAtPos(start);
}

function isAliasBinding(target: Node): boolean {
  const parent = target.getParent();
  return (
    parent !== undefined &&
    (parent.isKind(SyntaxKind.ImportClause) ||
      parent.isKind(SyntaxKind.ImportSpecifier) ||
      parent.isKind(SyntaxKind.NamespaceImport) ||
      parent.isKind(SyntaxKind.ExportSpecifier) ||
      parent.isKind(SyntaxKind.NamespaceExport) ||
      parent.isKind(SyntaxKind.ImportEqualsDeclaration))
  );
}

/**
 * References reach files the program compiles but the project never listed —
 * the `@types` packages above all. ts-morph wraps those on demand without
 * marking them as project files, so analysis still sees only what it asked
 * for; do the same rather than drop the reference and call a used name unused.
 */
function sourceFileFor(project: Project, fileName: string): SourceFile | undefined {
  const existing = project.getSourceFile(fileName);
  if (existing) return existing;
  const context = (project as unknown as { _context: TsMorphContext })._context;
  return context.compilerFactory.addOrGetSourceFileFromFilePath(
    context.fileSystemWrapper.getStandardizedAbsolutePath(fileName),
    { markInProject: false, scriptKind: undefined }
  );
}

interface TsMorphContext {
  compilerFactory: {
    addOrGetSourceFileFromFilePath(
      filePath: string,
      options: { markInProject: boolean; scriptKind: undefined }
    ): SourceFile | undefined;
  };
  fileSystemWrapper: { getStandardizedAbsolutePath(fileName: string): string };
}
