import type { SourceFile } from 'ts-morph';

/**
 * A declaration file the project wrote for itself.
 *
 * The two kinds of `.d.ts` a run holds have nothing in common but a suffix.
 * One is shipped by a package, describes code this project did not write, and
 * is never anybody's finding. The other is the project's own: the shape of an
 * IPC bridge, a types-only module a dozen files import, a global the bundler
 * fills in. That one is source, and answers for itself like source.
 *
 * The file list a run starts from leaves every `.d.ts` out, so the only ones
 * here are the ones an import reached — which is the same thing as saying a
 * project file asked for it by name.
 */
export function isOwnDeclarationFile(sourceFile: SourceFile): boolean {
  return sourceFile.isDeclarationFile() && !sourceFile.isInNodeModules();
}

/**
 * True when a declaration file this project holds describes this one.
 *
 * `atom/index.js` beside `atom/index.d.ts` is one module written twice: the
 * implementation, and the shape it promises. Every import of it resolves to
 * the declaration — that is what a declaration is for — so the
 * implementation's own exports collect no references at all, however heavily
 * the module is used.
 *
 * The declaration is where the question belongs, and where it is asked. The
 * implementation beside it answers for nothing, because a name nothing can
 * reach is not a name anybody can be told about.
 */
export function hasDeclarationSibling(sourceFile: SourceFile): boolean {
  const match = /\.([cm]?)js$/.exec(sourceFile.getFilePath());
  if (!match) return false;
  const sibling = `${sourceFile.getFilePath().slice(0, match.index)}.d.${match[1]}ts`;
  return sourceFile.getProject().getSourceFile(sibling) !== undefined;
}
