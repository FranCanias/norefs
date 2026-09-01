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
