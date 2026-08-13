import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyBaseline, writeBaseline } from '../src/baseline';
import type { Finding, FindingKind } from '../src/types';

function make(cwd: string, kind: FindingKind, relativePath: string, name: string, line = 1): Finding {
  return { kind, filePath: path.join(cwd, relativePath), line, column: 1, name, context: '', anonymous: false };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'norefs-baseline-'));
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

  it('throws on an invalid baseline file', () => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, 'norefs-baseline.json'), '{ nope');
    expect(() => applyBaseline([], cwd)).toThrow(/not valid JSON/);
  });
});
