import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findConfigProblems } from '../src/engine/diagnostics';
import { runCli, withTempDir, writeFiles } from './helpers';

function problemsOf(files: Record<string, string>, names: string[] = ['tsconfig.json']): string[] {
  return withTempDir('norefs-tsconfig-', dir => {
    writeFiles(dir, files);
    return findConfigProblems(names.map(name => path.join(dir, name)));
  });
}

describe('a tsconfig that makes a run meaningless', () => {
  it('says so when the config holds no files but points at others', () => {
    // A solution-style config scans nothing and reports a clean run, which
    // reads exactly like a clean project.
    const problems = problemsOf({
      'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.build.json' }] }),
      'tsconfig.build.json': JSON.stringify({ include: ['src'] }),
      'src/main.ts': 'export const main = 1;\n',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('lists no files of its own');
    expect(problems[0]).toContain('-p tsconfig.build.json');
  });

  it('says so when the config matches no files at all', () => {
    const problems = problemsOf({
      'tsconfig.json': JSON.stringify({ include: ['nowhere'] }),
      'src/main.ts': 'export const main = 1;\n',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('matches no files');
  });

  it('says so when the config extends something that is not installed', () => {
    // Without those options `outDir` never resolves, the published entry maps
    // back to nothing, and every file in the project reads as dead.
    const problems = problemsOf({
      'tsconfig.json': JSON.stringify({ extends: '@someone/tsconfig', include: ['src'] }),
      'src/main.ts': 'export const main = 1;\n',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('extends a config that is not there');
    expect(problems[0]).toContain('@someone/tsconfig');
  });

  it('says what the run scanned, not what the config did', () => {
    // A run holding other configs read plenty. Telling the reader nothing was
    // scanned, above two hundred findings, teaches them to distrust the
    // findings instead of the config.
    const problems = problemsOf(
      {
        'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './packages/box' }] }),
        'packages/box/tsconfig.json': JSON.stringify({ include: ['src'] }),
        'packages/box/src/main.ts': 'export const main = 1;\n',
      },
      ['tsconfig.json', 'packages/box/tsconfig.json']
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Nothing in it was scanned');
    expect(problems[0]).not.toContain('-p ');
  });

  it('stays quiet about a config that holds files and resolves', () => {
    const problems = problemsOf({
      'tsconfig.json': JSON.stringify({ include: ['src'] }),
      'src/main.ts': 'export const main = 1;\n',
    });
    expect(problems).toEqual([]);
  });

  it('reads a config written with comments and trailing commas', () => {
    const problems = problemsOf({
      'tsconfig.json': '{\n\t// the shared base\n\t"extends": "@someone/tsconfig",\n\t"include": ["src"],\n}\n',
      'src/main.ts': 'export const main = 1;\n',
    });
    expect(problems[0]).toContain('extends a config that is not there');
  });
});

describe('a run that resolves no entry point', () => {
  it('says so before it reports every file unused', () => {
    // Nothing is public API and no import chain has a root, so the report is
    // the whole project. `norefs entries` has always said this; an ordinary
    // run never reached the line.
    withTempDir('norefs-entries-', dir => {
      writeFiles(dir, {
        'tsconfig.json': JSON.stringify({ include: ['src'] }),
        'package.json': JSON.stringify({ name: 'box' }),
        'src/shelf.ts': 'export const shelf = 1;\n',
      });
      const run = runCli(dir);
      expect(run.stderr).toContain('no entry point resolves');
      expect(run.stdout).toContain('shelf.ts');
    });
  });

  it('stays quiet when the manifest names one', () => {
    withTempDir('norefs-entries-', dir => {
      writeFiles(dir, {
        'tsconfig.json': JSON.stringify({ include: ['src'] }),
        'package.json': JSON.stringify({ name: 'box', main: 'src/shelf.ts' }),
        'src/shelf.ts': 'export const shelf = 1;\n',
      });
      const run = runCli(dir);
      expect(run.stderr).not.toContain('no entry point');
    });
  });
});
