import { describe, expect, it } from 'vitest';
import { applyFilters, parseKinds } from '../src/filters';
import type { Finding, FindingKind } from '../src/types';

function make(kind: FindingKind, filePath = '/proj/src/a.ts'): Finding {
  return { kind, filePath, line: 1, column: 1, name: 'x', context: '', anonymous: false };
}

describe('parseKinds', () => {
  it('parses comma-separated and repeated values', () => {
    expect(parseKinds(['files,exports'])).toEqual(['file', 'export']);
    expect(parseKinds(['types', 'ns-exports,ns-types', 'members'])).toEqual(['type', 'ns-export', 'ns-type', 'member']);
  });

  it('throws on an unknown kind', () => {
    expect(() => parseKinds(['bogus'])).toThrow(/unknown kind "bogus"/);
  });
});

describe('applyFilters', () => {
  it('keeps only the requested kinds', () => {
    const findings = [make('file'), make('export'), make('member')];
    const kept = applyFilters(findings, { anonymous: true, only: ['file', 'member'] });
    expect(kept.map(f => f.kind)).toEqual(['file', 'member']);
  });

  it('drops findings from ignored paths', () => {
    const findings = [make('export', '/proj/src/gen/a.ts'), make('export', '/proj/src/b.ts')];
    const kept = applyFilters(findings, { anonymous: true, ignore: ['src/gen/**'], cwd: '/proj' });
    expect(kept.map(f => f.filePath)).toEqual(['/proj/src/b.ts']);
  });

  it('matches ignore globs against the absolute path too', () => {
    const findings = [make('export', '/proj/src/gen/a.ts')];
    const kept = applyFilters(findings, { anonymous: true, ignore: ['/proj/src/gen/**'], cwd: '/elsewhere' });
    expect(kept).toEqual([]);
  });
});
