import type { Node } from 'ts-morph';
import { referenceIndex } from './reference-index';

/**
 * Every reference to a declaration, as nodes.
 *
 * Answered from the project-wide index, which resolves the whole project once
 * instead of once per declaration. The analysis reads a project that does not
 * change while it runs, so one index serves every query. `--fix` edits the
 * project after the analysis, so it runs its reference queries before the
 * first edit and answers the rest from the file being cleaned.
 */
export function findReferencesAsNodes(target: Node): Node[] {
  return referenceIndex(target.getProject()).find(target);
}

/**
 * Every reference to a default export that has no name of its own.
 *
 * `export default class { … }` names nothing, so there is no identifier to
 * search for — but the module system gives it one name anyway, and every
 * importer spells that name in its own way. The index knows them all.
 */
export function findDefaultExportReferences(declaration: Node): Node[] {
  return referenceIndex(declaration.getProject()).findDefaultExport(declaration);
}
