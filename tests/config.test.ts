import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

function dirWith(content?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noref-config-'));
  if (content !== undefined) fs.writeFileSync(path.join(dir, 'noref.json'), content);
  return dir;
}

describe('loadConfig', () => {
  it('returns empty defaults when noref.json is missing', () => {
    expect(loadConfig(dirWith())).toEqual({ entry: [], ignore: [], project: undefined, only: undefined });
  });

  it('parses a full config', () => {
    const dir = dirWith(
      JSON.stringify({
        project: 'tsconfig.app.json',
        entry: ['src/worker.ts'],
        ignore: ['src/generated/**'],
        only: ['files', 'exports'],
      })
    );
    expect(loadConfig(dir)).toEqual({
      project: 'tsconfig.app.json',
      entry: ['src/worker.ts'],
      ignore: ['src/generated/**'],
      only: ['files', 'exports'],
    });
  });

  it('throws on invalid JSON', () => {
    expect(() => loadConfig(dirWith('{ nope'))).toThrow(/not valid JSON/);
  });

  it('throws on an unknown key', () => {
    expect(() => loadConfig(dirWith('{ "entries": [] }'))).toThrow(/unknown key "entries"/);
  });

  it('throws on a wrong value type', () => {
    expect(() => loadConfig(dirWith('{ "entry": "src" }'))).toThrow(/"entry" must be an array of strings/);
  });
});
