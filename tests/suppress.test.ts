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
        'interface User {',
        '  name: string;',
        '  // norefs-ignore: kept for API symmetry',
        '  legacyId: number;',
        '  probed: number; // norefs-ignore',
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
        '// norefs-ignore: consumers arrive next release',
        'export interface DeadShape {',
        '  alsoDead: number;',
        '}',
        'export function used(): void {}',
        '',
      ].join('\n'),
    });
    expect(findings.map(f => [f.kind, f.name])).toEqual([['member', 'alsoDead']]);
  });

  it('suppresses every member of a declaration marked norefs-ignore-block', () => {
    // The reason the mark exists: five flagged members, one comment.
    const findings = findingsOf({
      '/main.ts': [
        '// norefs-ignore-block: wire format, kept in sync by hand',
        'interface Payload {',
        '  a: string;',
        '  b: string;',
        '  c: string;',
        '  d: string;',
        '  e: string;',
        '}',
        'interface Other {',
        '  kept: number;',
        '  gone: number;',
        '}',
        'export function send(p: Payload, o: Other): unknown {',
        '  return [p.a, o.kept];',
        '}',
        '',
      ].join('\n'),
    });
    expect(findings.map(f => f.name)).toEqual(['gone']);
  });

  it('reads the block mark above or below a doc comment, and on the line itself', () => {
    const findings = findingsOf({
      '/main.ts': [
        '/** The wire format. */',
        '// norefs-ignore-block',
        'interface Above {',
        '  a: string;',
        '}',
        '// norefs-ignore-block',
        '/**',
        ' * The other wire format.',
        ' */',
        'interface Below {',
        '  b: string;',
        '}',
        'interface Trailing { // norefs-ignore-block',
        '  c: string;',
        '}',
        'export function send(x: Above, y: Below, z: Trailing): unknown {',
        '  return [x, y, z];',
        '}',
        '',
      ].join('\n'),
    });
    expect(findings).toEqual([]);
  });

  it('stops the block mark at the declaration it covers', () => {
    const findings = findingsOf({
      '/main.ts': [
        'interface Covered {',
        '  // norefs-ignore-block',
        '  nested: { deep: string };',
        '  sibling: string;',
        '}',
        'export function send(c: Covered): unknown {',
        '  return c;',
        '}',
        '',
      ].join('\n'),
    });
    // The mark covers `nested` and the type literal under it, and nothing else.
    expect(findings.map(f => f.name)).toEqual(['sibling']);
  });

  it('suppresses an export and its members together with the block mark', () => {
    // The line form deliberately keeps looking inside a suppressed export.
    // The block form is the one that does not.
    const findings = findingsOf({
      '/main.ts': "import { used } from './lib';\nused();\n",
      '/lib.ts': [
        '// norefs-ignore-block: consumers arrive next release',
        'export interface DeadShape {',
        '  alsoDead: number;',
        '}',
        'export function used(): void {}',
        '',
      ].join('\n'),
    });
    expect(findings).toEqual([]);
  });

  it('covers every declaration that holds findings', () => {
    // docs/configuration.md names these shapes, so the docs are tested.
    const entry = { '/index.ts': "import { go } from './lib';\ngo();\n" };
    const clean = (lib: string) => findingsOf({ ...entry, '/lib.ts': lib });

    expect(
      clean(
        [
          '// norefs-ignore-block',
          'class Svc {',
          '  a(): void {}',
          '  b(): void {}',
          '  keep(): void {}',
          '}',
          'export const go = () => new Svc().keep();',
          '',
        ].join('\n')
      )
    ).toEqual([]);

    expect(
      clean(
        [
          '// norefs-ignore-block',
          'export namespace N {',
          '  export const a = 1;',
          '  export const keep = 2;',
          '}',
          'export const go = () => N.keep;',
          '',
        ].join('\n')
      )
    ).toEqual([]);

    expect(
      clean(['// norefs-ignore-block', 'enum E { A = 1, Keep = 2 }', 'export const go = () => E.Keep;', ''].join('\n'))
    ).toEqual([]);

    // The dead-slice producer: its members fold into one `empty-type` finding,
    // and the fold has nothing left to make once they are suppressed.
    expect(
      findingsOf({
        '/main.ts': [
          '// norefs-ignore-block',
          'function computeColors() {',
          '  return { primary: mix(1), accent: mix(2) };',
          '}',
          'function mix(n: number): string {',
          "  return '#' + n;",
          '}',
          'computeColors();',
          '',
        ].join('\n'),
      })
    ).toEqual([]);
  });

  it('does not let norefs-ignore-block act as a plain line suppression elsewhere', () => {
    const findings = findingsOf({
      '/main.ts': [
        'interface User {',
        '  // norefs-ignore-block',
        '  covered: number;',
        '  dead: number;',
        '  name: string;',
        '}',
        'export function greet(u: User): string {',
        '  return u.name;',
        '}',
        '',
      ].join('\n'),
    });
    expect(findings.map(f => f.name)).toEqual(['dead']);
  });

  it('suppresses everything in a file marked norefs-ignore-file', () => {
    const findings = findingsOf({
      '/main.ts': 'export const keep = 1;\n',
      '/orphan.ts': '// norefs-ignore-file: generated\nexport const gone = 1;\n',
    });
    expect(findings).toEqual([]);
  });

  it('ignores a norefs-ignore-file comment that is not in the file header', () => {
    const findings = findingsOf({
      '/main.ts': 'export const keep = 1;\n',
      '/orphan.ts': 'export const gone = 1;\n// norefs-ignore-file\n',
    });
    expect(findings.map(f => [f.kind, f.name])).toEqual([['file', 'orphan.ts']]);
  });

  it('does not let norefs-ignore-file act as a line suppression', () => {
    const findings = findingsOf({
      '/main.ts': [
        'interface User {',
        '  name: string;',
        '  // norefs-ignore-file',
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
