import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import type { Finding } from '../src/types';

function memberOf(findings: Finding[], name: string): Finding | undefined {
  return findings.find(f => f.kind === 'member' && f.name === name);
}

describe('the write scan behind the dead verdict', () => {
  it('sees a shorthand write inside an inference-typed literal', () => {
    // The React-context shape: the literal is typed by inference (useMemo has
    // no type argument), so the connection to the interface happens at
    // assignability level and no reference ever lands on the member.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface DiagramContextType {',
        '  diagramDevices: number[];',
        '  getDevice: () => void;',
        '}',
        'declare function useMemo<T>(factory: () => T, deps: unknown[]): T;',
        'declare function provide(value: DiagramContextType): void;',
        'declare const context: DiagramContextType;',
        'const diagramDevices: number[] = [];',
        'const getDevice = () => {};',
        'const contextValue = useMemo(',
        '  () => ({',
        '    diagramDevices,',
        '    getDevice,',
        '  }),',
        '  [diagramDevices, getDevice]',
        ');',
        'export const run = () => provide(contextValue);',
        'export const read = () => context.getDevice();',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const member = memberOf(findings, 'diagramDevices');
    expect(member?.verdict).toBe('write-only');
    expect(member?.evidence).toContain('main.ts');
  });

  it('sees a spread that carries the member into an inference-typed literal', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface Payload {',
        '  extra: number;',
        '  used: number;',
        '}',
        'declare function wrap<T>(factory: () => T): T;',
        'declare function send(p: Payload): void;',
        'declare const payload: Payload;',
        'declare const base: { extra: number };',
        'const value = wrap(() => ({ ...base, used: 1 }));',
        'export const run = () => send(value);',
        'export const read = () => payload.used;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    expect(memberOf(findings, 'extra')?.verdict).toBe('write-only');
  });

  it('sees a computed-key write with a literal name', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface Flags {',
        '  verbose: boolean;',
        '  quiet: boolean;',
        '}',
        'declare function wrap<T>(factory: () => T): T;',
        'declare function send(f: Flags): void;',
        'declare const flags: Flags;',
        "const value = wrap(() => ({ ['verbose']: true, quiet: false }));",
        'export const run = () => send(value as Flags);',
        'export const read = () => flags.quiet;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    expect(memberOf(findings, 'verbose')?.verdict).toBe('write-only');
  });

  it('names the write site in the evidence', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/types.ts',
      ['export interface Device {', '  ip: string;', '  port: number;', '}', ''].join('\n')
    );
    project.createSourceFile(
      '/main.ts',
      [
        "import type { Device } from './types';",
        'declare function wrap<T>(factory: () => T): T;',
        'declare const device: Device;',
        "const config = wrap(() => ({ ip: '10.0.0.1' }));",
        'export const run = () => [config, device.port];',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const member = memberOf(findings, 'ip');
    expect(member?.verdict).toBe('write-only');
    expect(member?.evidence).toMatch(/main\.ts:4/);
  });

  it('still calls a member dead when no write of the name exists anywhere', () => {
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
    expect(memberOf(findings, 'legacyId')?.verdict).toBe('dead');
  });
});
