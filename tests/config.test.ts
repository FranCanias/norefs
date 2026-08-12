import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { initConfig, loadConfig } from '../src/config';

function dirWith(content?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noref-config-'));
  if (content !== undefined) fs.writeFileSync(path.join(dir, 'noref.config.json'), content);
  return dir;
}

describe('loadConfig', () => {
  it('returns empty defaults when noref.config.json is missing', () => {
    expect(loadConfig(dirWith())).toEqual({
      project: [],
      entry: [],
      ignore: [],
      only: undefined,
      ignoreDependencies: [],
    });
  });

  it('parses a full config and normalizes a single project string to an array', () => {
    const dir = dirWith(
      JSON.stringify({
        project: 'tsconfig.app.json',
        entry: ['src/worker.ts'],
        ignore: ['src/generated/**'],
        only: ['files', 'exports'],
        ignoreDependencies: ['legacy-*'],
      })
    );
    expect(loadConfig(dir)).toEqual({
      project: ['tsconfig.app.json'],
      entry: ['src/worker.ts'],
      ignore: ['src/generated/**'],
      only: ['files', 'exports'],
      ignoreDependencies: ['legacy-*'],
    });
  });

  it('accepts an array of projects', () => {
    const dir = dirWith(JSON.stringify({ project: ['packages/a/tsconfig.json', 'packages/b/tsconfig.json'] }));
    expect(loadConfig(dir).project).toEqual(['packages/a/tsconfig.json', 'packages/b/tsconfig.json']);
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

describe('initConfig', () => {
  it('writes every key with its default, and loadConfig reads it back', () => {
    const dir = dirWith();
    expect(initConfig(dir)).toBe('noref.config.json');
    expect(fs.readFileSync(path.join(dir, 'noref.config.json'), 'utf8')).toBe(
      `${JSON.stringify(
        { project: ['tsconfig.json'], entry: [], ignore: [], only: [], ignoreDependencies: [] },
        null,
        2
      )}\n`
    );
    expect(loadConfig(dir)).toEqual({
      project: ['tsconfig.json'],
      entry: [],
      ignore: [],
      only: [],
      ignoreDependencies: [],
    });
  });

  it('refuses to overwrite an existing config', () => {
    const dir = dirWith('{ "entry": ["src/worker.ts"] }');
    expect(() => initConfig(dir)).toThrow(/already exists/);
    expect(loadConfig(dir).entry).toEqual(['src/worker.ts']);
  });
});
