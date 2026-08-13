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
