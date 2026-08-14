import type { Finding } from '../types';

/** One entry to retire or relocate, taken from a `dependency` or `misplaced` finding. */
interface ManifestEdit {
  name: string;
  /** The section holding it now. */
  from: string;
  /** The section it belongs in, or nothing when it belongs nowhere. */
  to?: string;
}

/** An edit that could not be made, with the reason a reader needs. */
interface Refused {
  name: string;
  reason: string;
}

/**
 * package.json edits, made as text.
 *
 * A manifest is a file people read and write by hand: the key order carries
 * meaning, the indentation is a house style, and a comment-free JSON parse
 * followed by `JSON.stringify` would rewrite all of it to fix one line. So
 * these edits work on lines. Every one of them is a whole `"name": "range"`
 * entry, which is the only shape npm, pnpm, and yarn ever write.
 *
 * What it cannot do it refuses by name. Moving an entry needs a section to move
 * it into, and inventing one would mean guessing where in the file it goes.
 *
 * The line ending comes off the front and goes back on at the end, so a CRLF
 * manifest stays CRLF and every function between here and there works on a
 * plain line. A file that mixes both endings is the one case this normalizes:
 * no package manager writes one, and carrying a per-line ending through the
 * splices would cost more than the case is worth.
 */
export function editManifest(text: string, edits: ManifestEdit[]): { text: string; refused: Refused[] } {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  let lines = text.split(/\r?\n/);
  const refused: Refused[] = [];

  for (const edit of edits) {
    const at = entryLine(lines, edit.from, edit.name);
    if (at === undefined) {
      refused.push({ name: edit.name, reason: reasonItCannot(lines, edit.from, edit.name) });
      continue;
    }
    if (edit.to !== undefined && sectionRange(lines, edit.to) === undefined) {
      refused.push({ name: edit.name, reason: `there is no "${edit.to}" section to move it into` });
      continue;
    }
    const entry = lines[at].trim().replace(/,$/, '');
    lines = removeEntry(lines, at);
    if (edit.to !== undefined) lines = insertEntry(lines, edit.to, edit.name, entry);
  }
  return { text: lines.join(newline), refused };
}

/** The manifest edits a set of findings asks for, grouped by the file they touch. */
export function manifestEdits(findings: Finding[]): Map<string, ManifestEdit[]> {
  const byFile = new Map<string, ManifestEdit[]>();
  for (const finding of findings) {
    if (finding.kind !== 'dependency' && finding.kind !== 'misplaced') continue;
    const to =
      finding.kind === 'dependency'
        ? undefined
        : finding.context === 'dependencies'
          ? 'devDependencies'
          : 'dependencies';
    const list = byFile.get(finding.filePath) ?? [];
    list.push({ name: finding.name, from: finding.context, to });
    byFile.set(finding.filePath, list);
  }
  return byFile;
}

/**
 * The line range inside a section's braces.
 *
 * `inline` marks a section written on a single line — `"deps": {}`, which is
 * what removing the last entry leaves behind, and what an entry moving in has
 * to expand again.
 */
function sectionRange(lines: string[], section: string): { first: number; last: number; inline: boolean } | undefined {
  const open = lines.findIndex(line => line.includes(`"${section}"`) && line.includes('{'));
  if (open === -1) return undefined;
  if (lines[open].includes('}')) return { first: open, last: open, inline: true };
  for (let at = open + 1; at < lines.length; at++) {
    if (lines[at].includes('}')) return { first: open + 1, last: at, inline: false };
  }
  return undefined;
}

/**
 * Why an entry could not be found on a line of its own. These edits move whole
 * lines, which is how every package manager writes a manifest — but a file
 * written by hand can put a section on one line, and "not found" would be a
 * false reason for refusing it.
 */
function reasonItCannot(lines: string[], section: string, name: string): string {
  const range = sectionRange(lines, section);
  if (!range) return `there is no "${section}" section`;
  const crowded = lines.slice(range.first - 1, range.last + 1).some(line => line.includes(`"${name}":`));
  return crowded
    ? `its entry shares a line with others, and these edits move whole lines`
    : `no "${name}" entry in ${section}`;
}

/** The line holding this entry inside this section. */
function entryLine(lines: string[], section: string, name: string): number | undefined {
  const range = sectionRange(lines, section);
  if (!range) return undefined;
  for (let at = range.first; at < range.last; at++) {
    if (lines[at].trimStart().startsWith(`"${name}":`)) return at;
  }
  return undefined;
}

/**
 * Drop an entry line, and the comma that only existed to join it to the next
 * one. Removing the last entry of a section leaves the one before it with a
 * trailing comma, which is not JSON; removing the only entry leaves a pair of
 * braces with nothing between them, which reads better closed up.
 */
function removeEntry(lines: string[], at: number): string[] {
  const kept = [...lines.slice(0, at), ...lines.slice(at + 1)];
  const closing = kept[at];
  const previous = kept[at - 1];
  if (closing === undefined || previous === undefined || !closing.trim().startsWith('}')) return kept;

  if (previous.trim().endsWith(',')) {
    kept[at - 1] = previous.replace(/,(\s*)$/, '$1');
  } else if (previous.includes('{')) {
    // The section is empty now: `"deps": {` and `},` close up to `"deps": {},`.
    kept.splice(at - 1, 2, `${previous.trimEnd()}${closing.trim()}`);
  }
  return kept;
}

/**
 * Put an entry into a section, alphabetically when the section already is —
 * which is how every package manager writes it — and at the end when it is not,
 * because reordering someone's list is not this edit's business.
 */
function insertEntry(lines: string[], section: string, name: string, entry: string): string[] {
  const range = sectionRange(lines, section);
  if (!range) return lines;

  if (range.inline) {
    // `"deps": {}` opens back up around the entry it is receiving.
    const line = lines[range.first];
    const indent = indentOf(line);
    const kept = [...lines];
    kept.splice(
      range.first,
      1,
      line.slice(0, line.indexOf('{') + 1),
      `${oneLevelIn(indent)}${entry}`,
      `${indent}${line.slice(line.indexOf('}'))}`
    );
    return kept;
  }

  const names = lines.slice(range.first, range.last).map(line => line.trim().match(/^"([^"]+)":/)?.[1] ?? '');
  const sorted = names.every((value, at) => at === 0 || names[at - 1] <= value);
  const before = sorted ? names.findIndex(value => value > name) : -1;
  const target = before === -1 ? range.last : range.first + before;

  // An entry copies the indent of the entries it joins. An empty section has
  // none to copy, and `lines[range.first]` is then its own closing brace — so
  // the indent comes from the section instead, one level in.
  const indent =
    range.first < range.last ? indentOf(lines[range.first]) : oneLevelIn(indentOf(lines[range.last] ?? ''));
  const previous = lines[target - 1];
  const kept = [...lines];
  // The line above gains the comma this entry needs in front of it.
  if (target === range.last && previous && !previous.trim().endsWith(',') && !previous.includes('{')) {
    kept[target - 1] = `${previous.trimEnd()},`;
  }
  kept.splice(target, 0, `${indent}${entry}${target === range.last ? '' : ','}`);
  return kept;
}

function indentOf(line: string): string {
  return line.slice(0, line.length - line.trimStart().length);
}

/**
 * One indent level deeper than a section's own line. A top-level section sits
 * one level in already, so its own indent is the unit — and a manifest written
 * flat gets the two spaces every package manager would have used.
 */
function oneLevelIn(indent: string): string {
  return indent + (indent || '  ');
}
