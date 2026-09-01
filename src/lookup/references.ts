import type { Node, Type } from 'ts-morph';
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

/**
 * Credit a computed key with the members its key type names, so later queries
 * find the site the way they find any other reference.
 *
 * The index cannot work this out on its own: the site spells a variable, and
 * only the checker knows which members that variable stands for. The dynamic
 * pass types those keys already, and this is where it says so — before any
 * member query, while that pass is still walking.
 */
export function fileComputedKey(site: Node, target: Type, names: string[]): void {
  referenceIndex(site.getProject()).fileComputedKey(site, target, names);
}
