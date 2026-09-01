import path from 'node:path';
import type { Project } from 'ts-morph';
import { ts } from 'ts-morph';
import { isOwnDeclarationFile } from '../lookup/files';
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
    if (sourceFile.isDeclarationFile() && !isOwnDeclarationFile(sourceFile)) continue;
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

/**
 * What a tsconfig says about itself that makes a run untrustworthy before it
 * starts.
 *
 * Two shapes end the same way — a clean report nobody should believe. A
 * solution-style config (`"files": []` beside `"references"`) holds no files
 * at all, so there is nothing to find and the run says so cheerfully. And a
 * config whose `extends` target is missing loses every option it meant to
 * inherit: `outDir` never resolves, the published entry maps back to nothing,
 * and every file in the project reads as dead.
 *
 * Neither surfaces anywhere else. A missing file is an error the compiler
 * would report and norefs never asks it to; an empty file list is not an
 * error at all.
 */
export function findConfigProblems(tsConfigFilePaths: string[]): string[] {
  const problems: string[] = [];
  for (const tsConfigFilePath of tsConfigFilePaths) {
    const { config, error } = ts.readConfigFile(tsConfigFilePath, ts.sys.readFile);
    if (error || typeof config !== 'object' || config === null) continue;
    const dir = path.dirname(tsConfigFilePath);
    const name = path.basename(tsConfigFilePath);
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dir, undefined, tsConfigFilePath);

    const written = (config as { extends?: unknown }).extends;
    const extended = typeof written === 'string' ? [written] : Array.isArray(written) ? written : [];
    for (const diagnostic of parsed.errors) {
      // A file the config names is not there. The compiler would say so on
      // the next build; norefs never asks it to, and carries on with whatever
      // is left.
      if (diagnostic.code !== MISSING_FILE && diagnostic.code !== MISSING_EXTENDS) continue;
      const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
      if (!extended.some(target => typeof target === 'string' && text.includes(target))) continue;
      problems.push(
        `${name} extends a config that is not there (${text})\n` +
          `Every option it meant to inherit is missing, so paths and entry points can resolve to nothing —\n` +
          `and a run that resolves no entry point reports every file unused. Install it, or fix the path.`
      );
    }

    if (parsed.fileNames.length > 0) continue;
    const references = (parsed.projectReferences ?? []).map(reference => path.relative(dir, reference.path) || '.');
    problems.push(
      references.length > 0
        ? `${name} lists no files of its own; it references ${references.length} other config(s).\n` +
            `Nothing was scanned. Point norefs at them: -p ${references.slice(0, 3).join(' -p ')}`
        : `${name} matches no files.\nNothing was scanned. Check its "include", "files", and "exclude" settings.`
    );
  }
  return problems;
}

/** `File '…' not found.`, which is what a missing `extends` target reads as. */
const MISSING_FILE = 6053;
const MISSING_EXTENDS = 5083;
