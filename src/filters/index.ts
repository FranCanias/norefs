import path from 'node:path';
import { minimatch } from 'minimatch';
import type { Finding, FindingKind } from '../types';

export interface FilterOptions {
  anonymous: boolean;
  /** Report only these kinds when set. */
  only?: FindingKind[];
  /** Globs of file paths to drop findings from, relative to cwd. */
  ignore?: string[];
  cwd?: string;
}

export function applyFilters(findings: Finding[], options: FilterOptions): Finding[] {
  return findings.filter(
    f =>
      (options.anonymous || !f.anonymous) &&
      (!options.only || options.only.includes(f.kind)) &&
      !isIgnored(f.filePath, options)
  );
}

function isIgnored(filePath: string, options: FilterOptions): boolean {
  if (!options.ignore || options.ignore.length === 0) return false;
  const relative = path.relative(options.cwd ?? process.cwd(), filePath);
  return options.ignore.some(
    glob => minimatch(relative, glob, { dot: true }) || minimatch(filePath, glob, { dot: true })
  );
}

/** The user-facing kind names, as they appear in the summary line. */
const KIND_NAMES: Record<string, FindingKind> = {
  files: 'file',
  exports: 'export',
  types: 'type',
  'ns-exports': 'ns-export',
  'ns-types': 'ns-type',
  members: 'member',
  'empty-types': 'empty-type',
};

/** Parse comma-separated kind lists like "files,exports". Throws on an unknown name. */
export function parseKinds(input: string[]): FindingKind[] {
  const kinds: FindingKind[] = [];
  for (const part of input.flatMap(value => value.split(','))) {
    const name = part.trim();
    if (!name) continue;
    const kind = KIND_NAMES[name];
    if (!kind) throw new Error(`unknown kind "${name}" (expected ${Object.keys(KIND_NAMES).join(', ')})`);
    kinds.push(kind);
  }
  return kinds;
}
