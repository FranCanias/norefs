/**
 * The suppression marks, read from text alone.
 *
 * Both pipelines ask the same questions of the same comments — the type-aware
 * analysis of a ts-morph line, the syntax scanner of a raw one — and a mark
 * that means one thing in one run and another in the other is a bug the 0.6.0
 * changelog already records once. So the words live here, and each pipeline
 * only decides how far a mark reaches.
 */

import { isSpace, isWordPart } from './text';

const LINE = 'norefs-ignore';
const BLOCK = 'norefs-ignore-block';
const FILE = 'norefs-ignore-file';

/** `// norefs-ignore [reason]`, and not the `-block` or `-file` form. */
export function hasLineMark(text: string): boolean {
  return hasMark(text, LINE);
}

/** `// norefs-ignore-block [reason]`: the declaration and everything inside it. */
export function hasBlockMark(text: string): boolean {
  return hasMark(text, BLOCK);
}

/** `// norefs-ignore-file`: every finding in the file. */
export function hasFileMark(text: string): boolean {
  return hasMark(text, FILE);
}

/**
 * The mark as a whole word, after a comment opener. Whitespace may stand
 * between the two — a block comment spanning lines reads the same as a line
 * comment — and anything may follow, as long as the mark ends where a word
 * ends: `norefs-ignore` never matches `norefs-ignore-file`.
 */
function hasMark(text: string, mark: string): boolean {
  for (let i = 0; i + 1 < text.length; i++) {
    if (text[i] !== '/' || (text[i + 1] !== '/' && text[i + 1] !== '*')) continue;
    let j = i + 2;
    while (j < text.length && isSpace(text[j])) j++;
    if (text.slice(j, j + mark.length) !== mark) continue;
    const after = text[j + mark.length];
    if (after !== undefined && (after === '-' || isWordPart(after))) continue;
    return true;
  }
  return false;
}
