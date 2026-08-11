import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';

function findingsOf(files: Record<string, string>) {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, text] of Object.entries(files)) project.createSourceFile(filePath, text);
  return analyze(project);
}

describe('suppression comments', () => {
  it('suppresses a member with a comment on the line above or at the end of the line', () => {
    const findings = findingsOf({
      '/main.ts': [
        'export interface User {',
        '  name: string;',
        '  // noref-ignore: kept for API symmetry',
        '  legacyId: number;',
        '  probed: number; // noref-ignore',
        '  reallyDead: number;',
        '}',
        'export function greet(u: User): string {',
        '  return u.name;',
        '}',
        '',
      ].join('\n'),
    });
    expect(findings.map(f => f.name)).toEqual(['reallyDead']);
  });

  it('suppresses an export finding but still analyzes its members', () => {
    const findings = findingsOf({
      '/main.ts': "import { used } from './lib';\nused();\n",
      '/lib.ts': [
        '// noref-ignore: consumers arrive next release',
        'export interface DeadShape {',
        '  alsoDead: number;',
        '}',
        'export function used(): void {}',
        '',
      ].join('\n'),
    });
    expect(findings.map(f => [f.kind, f.name])).toEqual([['member', 'alsoDead']]);
  });

  it('suppresses everything in a file marked noref-ignore-file', () => {
    const findings = findingsOf({
      '/main.ts': 'export const keep = 1;\n',
      '/orphan.ts': '// noref-ignore-file: generated\nexport const gone = 1;\n',
    });
    expect(findings).toEqual([]);
  });

  it('ignores a noref-ignore-file comment that is not in the file header', () => {
    const findings = findingsOf({
      '/main.ts': 'export const keep = 1;\n',
      '/orphan.ts': 'export const gone = 1;\n// noref-ignore-file\n',
    });
    expect(findings.map(f => [f.kind, f.name])).toEqual([['file', 'orphan.ts']]);
  });

  it('does not let noref-ignore-file act as a line suppression', () => {
    const findings = findingsOf({
      '/main.ts': [
        'export interface User {',
        '  name: string;',
        '  // noref-ignore-file',
        '  dead: number;',
        '}',
        'export function greet(u: User): string {',
        '  return u.name;',
        '}',
        '',
      ].join('\n'),
    });
    expect(findings.map(f => f.name)).toEqual(['dead']);
  });
});
