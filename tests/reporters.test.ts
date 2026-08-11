import { describe, expect, it } from 'vitest';
import { formatGitHub, formatPatch, formatSarif } from '../src/engine/report';
import type { Finding, FindingKind } from '../src/types';

function make(kind: FindingKind, name: string, context = ''): Finding {
  return { kind, filePath: '/proj/src/a.ts', line: 4, column: 3, name, context, anonymous: false };
}

describe('formatGitHub', () => {
  it('emits one workflow command per finding plus the summary', () => {
    const output = formatGitHub([make('export', 'dead')], '/proj');
    const lines = output.split('\n');
    expect(lines[0]).toBe('::error file=src/a.ts,line=4,col=3,title=noref::unused export `dead`');
    expect(lines[1]).toBe('Unused code (1): 1 export');
  });

  it('escapes percent signs and newlines in the message', () => {
    const output = formatGitHub([make('export', 'a%b')], '/proj');
    expect(output).toContain('unused export `a%25b`');
  });

  it('reports a clean project as plain text', () => {
    expect(formatGitHub([], '/proj')).toBe('No unused code found.');
  });
});

describe('formatPatch', () => {
  it('formats a unified diff with hunk headers', () => {
    const patch = formatPatch('src/a.ts', 'a\nb\nc\n', 'a\nc\n');
    const lines = patch.split('\n');
    expect(lines[0]).toBe('--- src/a.ts');
    expect(lines[1]).toBe('+++ src/a.ts');
    expect(lines[2]).toMatch(/^@@ -1,3 \+1,2 @@$/);
    expect(lines).toContain('-b');
  });
});

describe('formatSarif', () => {
  it('produces a valid SARIF run with relative locations', () => {
    const sarif = JSON.parse(formatSarif([make('member', 'legacyId', 'interface `User`')], '/proj'));
    expect(sarif.version).toBe('2.1.0');
    const run = sarif.runs[0];
    expect(run.tool.driver.name).toBe('noref');
    expect(run.tool.driver.rules).toEqual([{ id: 'member' }]);
    const result = run.results[0];
    expect(result.ruleId).toBe('member');
    expect(result.message.text).toBe('unused property `legacyId` in interface `User`');
    expect(result.locations[0].physicalLocation.artifactLocation.uri).toBe('src/a.ts');
    expect(result.locations[0].physicalLocation.region).toEqual({ startLine: 4, startColumn: 3 });
  });

  it('produces an empty result set for a clean project', () => {
    const sarif = JSON.parse(formatSarif([], '/proj'));
    expect(sarif.runs[0].results).toEqual([]);
  });
});
