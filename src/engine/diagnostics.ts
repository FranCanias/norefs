import type { Project } from 'ts-morph';
import { escapeRegExp } from './text';

/**
 * Import specifiers that resolve to nothing. Every unresolved import hides all
 * references flowing through it, which silently turns used properties into
 * "unused" findings — so the CLI surfaces these as a loud warning.
 */
export function findUnresolvedImports(project: Project): string[] {
  const ambientMatchers = project.getAmbientModules().map(symbol => {
    const name = symbol.getName().replace(/^["']|["']$/g, '');
    return new RegExp(`^${name.split('*').map(escapeRegExp).join('.*')}$`);
  });

  const unresolved = new Set<string>();
  for (const sourceFile of project.getSourceFiles()) {
    if (sourceFile.isDeclarationFile()) continue;
    for (const decl of sourceFile.getImportDeclarations()) {
      if (!decl.getImportClause()) continue;
      checkSpecifier(decl.getModuleSpecifierValue(), decl.getModuleSpecifierSourceFile() !== undefined);
    }
    for (const decl of sourceFile.getExportDeclarations()) {
      const specifier = decl.getModuleSpecifierValue();
      if (specifier) checkSpecifier(specifier, decl.getModuleSpecifierSourceFile() !== undefined);
    }
  }
  return [...unresolved].sort();

  function checkSpecifier(specifier: string, resolved: boolean): void {
    if (resolved) return;
    if (ambientMatchers.some(rx => rx.test(specifier))) return;
    unresolved.add(specifier);
  }
}
