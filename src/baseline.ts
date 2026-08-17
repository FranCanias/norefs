import fs from 'node:fs';
import path from 'node:path';
import { firstLine } from './messages';
import type { Finding, FindingKind } from './types';

const FILE_NAME = 'norefs-baseline.json';

/**
 * One recorded finding. The key deliberately has no line or column: code moves,
 * and a baseline that breaks on every edit is useless. Identical keys are
 * folded into a count, so two same-named findings in one file still match
 * one-to-one.
 */
interface BaselineEntry {
  kind: FindingKind;
  filePath: string;
  name: string;
  context: string;
  count: number;
}

interface BaselineResult {
  /** Findings not in the baseline — the ones that should fail the run. */
  fresh: Finding[];
  matched: number;
  /** The findings the baseline covered, for --ratchet to rewrite it without the stale rest. */
  matchedFindings: Finding[];
  /** Baseline entries nothing matched anymore; the file deserves a refresh. */
  stale: number;
}

/** Record the findings in norefs-baseline.json and return the file name. */
export function writeBaseline(findings: Finding[], cwd: string): string {
  const entries = new Map<string, BaselineEntry>();
  for (const finding of findings) {
    const filePath = path.relative(cwd, finding.filePath);
    const key = entryKey(finding.kind, filePath, finding.name, finding.context);
    const entry = entries.get(key);
    if (entry) entry.count++;
    else entries.set(key, { kind: finding.kind, filePath, name: finding.name, context: finding.context, count: 1 });
  }
  const sorted = [...entries.values()].sort(
    (a, b) => a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind)
  );
  fs.writeFileSync(path.join(cwd, FILE_NAME), `${JSON.stringify(sorted, null, 2)}\n`);
  return FILE_NAME;
}

/**
 * Subtract the baseline from the findings. Returns undefined when no
 * norefs-baseline.json exists; throws when the file is invalid.
 */
export function applyBaseline(findings: Finding[], cwd: string): BaselineResult | undefined {
  const filePath = path.join(cwd, FILE_NAME);
  if (!fs.existsSync(filePath)) return undefined;

  let entries: unknown;
  try {
    entries = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${FILE_NAME} is not valid JSON: ${firstLine(error)}`);
  }
  if (!Array.isArray(entries)) throw new Error(`${FILE_NAME} must be a JSON array`);

  const remaining = new Map<string, number>();
  for (const [index, entry] of entries.entries()) {
    // A hand-edited entry missing a field would key on `undefined` and quietly
    // match nothing — the file would look applied and suppress nothing. It says
    // so instead, in the same voice as a file that is not JSON at all.
    if (!isBaselineEntry(entry)) {
      throw new Error(`${FILE_NAME} entry ${index + 1} needs a kind, filePath, name, and context`);
    }
    const key = entryKey(entry.kind, entry.filePath, entry.name, entry.context);
    remaining.set(key, (remaining.get(key) ?? 0) + (entry.count ?? 1));
  }

  const fresh: Finding[] = [];
  const matchedFindings: Finding[] = [];
  for (const finding of findings) {
    const key = entryKey(finding.kind, path.relative(cwd, finding.filePath), finding.name, finding.context);
    const left = remaining.get(key) ?? 0;
    if (left > 0) {
      remaining.set(key, left - 1);
      matchedFindings.push(finding);
    } else {
      fresh.push(finding);
    }
  }

  let stale = 0;
  for (const left of remaining.values()) stale += left;
  return { fresh, matched: matchedFindings.length, matchedFindings, stale };
}

/** Every field the key is built from is a string, and a count is a count. */
function isBaselineEntry(entry: unknown): entry is BaselineEntry {
  if (entry === null || typeof entry !== 'object') return false;
  const record = entry as Record<string, unknown>;
  const strings = ['kind', 'filePath', 'name', 'context'].every(field => typeof record[field] === 'string');
  return strings && (record.count === undefined || typeof record.count === 'number');
}

function entryKey(kind: string, filePath: string, name: string, context: string): string {
  return [kind, filePath, name, context].join('\u0000');
}
