import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';

describe('public API closure', () => {
  it('exempts declarations and members reached from an entry through export *', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    // main.ts is the entry; api.ts is public surface only through the star.
    project.createSourceFile('/main.ts', "export * from './api';\nimport './internal';\n");
    project.createSourceFile(
      '/api.ts',
      [
        'export interface Options {',
        '  retries: number;',
        '  timeout: number;',
        '}',
        'export function configure(o: Options): Options {',
        '  return o;',
        '}',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/internal.ts',
      [
        'interface Hidden {',
        '  kept: number;',
        '  dead: number;',
        '}',
        'export const read = (h: Hidden) => h.kept;',
        'void read;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);

    // Nothing in api.ts is reportable: its consumers live outside the program.
    expect(findings.filter(f => f.filePath === '/api.ts')).toEqual([]);
    // Internal code is still analyzed member-deep, and its needless export shows.
    expect(findings.map(f => [f.kind, f.name, f.verdict])).toEqual([
      ['member', 'dead', 'dead'],
      ['export', 'read', 'over-exported'],
    ]);
  });
});
