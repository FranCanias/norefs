import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyBaseline, writeBaseline } from '../src/baseline';
import type { Finding, FindingKind } from '../src/types';
import { tempDirs } from './helpers';

function make(cwd: string, kind: FindingKind, relativePath: string, name: string, line = 1): Finding {
  return { kind, filePath: path.join(cwd, relativePath), line, column: 1, name, context: '', anonymous: false };
}

const dirs = tempDirs('norefs-baseline-');
afterEach(dirs.removeAll);

function tempDir(): string {
  return dirs.make();
}

describe('baseline', () => {
  it('applyBaseline returns undefined when no baseline file exists', () => {
    const cwd = tempDir();
    expect(applyBaseline([make(cwd, 'export', 'src/a.ts', 'x')], cwd)).toBeUndefined();
  });

  it('suppresses recorded findings and keeps new ones', () => {
    const cwd = tempDir();
    const old = make(cwd, 'export', 'src/a.ts', 'x');
    writeBaseline([old], cwd);

    const moved = make(cwd, 'export', 'src/a.ts', 'x', 42); // same finding, new line
    const fresh = make(cwd, 'member', 'src/b.ts', 'y');
    const result = applyBaseline([moved, fresh], cwd);
    expect(result?.fresh).toEqual([fresh]);
    expect(result?.matched).toBe(1);
    expect(result?.stale).toBe(0);
  });

  it('folds duplicate keys into counts and matches them one-to-one', () => {
    const cwd = tempDir();
    const a = make(cwd, 'member', 'src/a.ts', 'x', 1);
    const b = make(cwd, 'member', 'src/a.ts', 'x', 9);
    writeBaseline([a, b], cwd);
    const entries = JSON.parse(fs.readFileSync(path.join(cwd, 'norefs-baseline.json'), 'utf8'));
    expect(entries).toHaveLength(1);
    expect(entries[0].count).toBe(2);

    const third = make(cwd, 'member', 'src/a.ts', 'x', 20);
    const result = applyBaseline([a, b, third], cwd);
    expect(result?.fresh).toEqual([third]);
    expect(result?.matched).toBe(2);
  });

  it('counts baseline entries that no longer occur as stale', () => {
    const cwd = tempDir();
    writeBaseline([make(cwd, 'export', 'src/gone.ts', 'x')], cwd);
    const result = applyBaseline([], cwd);
    expect(result?.fresh).toEqual([]);
    expect(result?.stale).toBe(1);
  });

  it('hands back the matched findings so a ratchet can rewrite without the stale rest', () => {
    const cwd = tempDir();
    const kept = make(cwd, 'export', 'src/a.ts', 'x');
    const gone = make(cwd, 'export', 'src/gone.ts', 'y');
    writeBaseline([kept, gone], cwd);

    const result = applyBaseline([kept], cwd);
    expect(result?.stale).toBe(1);
    expect(result?.matchedFindings).toEqual([kept]);

    // The ratchet: rewrite with the matched findings only, and the stale entry is gone.
    writeBaseline(result?.matchedFindings ?? [], cwd);
    const after = applyBaseline([kept], cwd);
    expect(after?.stale).toBe(0);
    expect(after?.matched).toBe(1);
  });

  it('throws on an invalid baseline file', () => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, 'norefs-baseline.json'), '{ nope');
    expect(() => applyBaseline([], cwd)).toThrow(/not valid JSON/);
  });
});
