import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import type { Finding } from '../src/types';

function verdictOf(findings: Finding[], name: string): Finding | undefined {
  return findings.find(f => f.kind === 'member' && f.name === name);
}

describe('verdicts', () => {
  it('marks members of a JSON-parsed type as contract, transitively', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface DeviceIO {',
        '  id: string;',
        '  count: number;',
        '}',
        'interface LibraryFile {',
        '  devices: DeviceIO[];',
        '  version: number;',
        '}',
        'declare const text: string;',
        'export const load = (): LibraryFile => JSON.parse(text) as LibraryFile;',
        'export const version = (f: LibraryFile) => f.version;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);

    expect(verdictOf(findings, 'devices')?.verdict).toBe('contract');
    expect(verdictOf(findings, 'devices')?.evidence).toContain('JSON.parse');

    // DeviceIO loses every member, so the cascade folds into one finding.
    const emptied = findings.find(f => f.kind === 'empty-type' && f.name === 'DeviceIO');
    expect(emptied?.verdict).toBe('contract');
    expect(emptied?.swallowed).toBe(2);
    expect(verdictOf(findings, 'id')).toBeUndefined();
    expect(verdictOf(findings, 'count')).toBeUndefined();
  });

  it('marks a member as shadowed when a structural twin reads it', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/shared.ts',
      [
        'export interface EdgeData {',
        '  label: string;',
        '  color: string;',
        '  zone: string;',
        '}',
        'export const tag = (e: EdgeData) => e.label;',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/main.ts',
      [
        "import { tag } from './shared';",
        'interface LocalEdgeData {',
        '  label: string;',
        '  color: string;',
        '  zone: string;',
        '}',
        'declare const data: unknown;',
        'const local = data as LocalEdgeData;',
        'export const run = () => tag(local) + local.color + local.zone;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);

    const color = findings.find(f => f.kind === 'member' && f.name === 'color' && f.context.includes('EdgeData'));
    expect(color?.verdict).toBe('shadowed');
    expect(color?.evidence).toContain('LocalEdgeData');
    expect(color?.evidence).toContain('`color`');
  });

  it('leaves a member with no signals dead', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface User {',
        '  name: string;',
        '  legacyId: number;',
        '}',
        'export const greet = (u: User) => u.name;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    expect(verdictOf(findings, 'legacyId')?.verdict).toBe('dead');
  });

  it('gives export findings their verdict at the source', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('/main.ts', "import { used } from './lib';\nused();\n");
    project.createSourceFile(
      '/lib.ts',
      [
        'export function used(): number {',
        '  return local();',
        '}',
        'export function local(): number {',
        '  return 1;',
        '}',
        'export function gone(): void {}',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    expect(findings.find(f => f.name === 'local')?.verdict).toBe('over-exported');
    expect(findings.find(f => f.name === 'gone')?.verdict).toBe('dead');
  });
});
