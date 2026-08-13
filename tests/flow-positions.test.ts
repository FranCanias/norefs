import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import type { Finding } from '../src/types';

function memberOf(findings: Finding[], name: string): Finding | undefined {
  return findings.find(f => f.kind === 'member' && f.name === name);
}

describe('the two positions a factory literal leaves through', () => {
  it('discards a write the callee types from the value itself and cannot be this owner', () => {
    // The imperative-handle shape: the literal flows out through an argument
    // position, and the callee infers that position from the literal. What it
    // holds is this literal's own shape — which the checker would reject
    // where `DeviceLibraryService` is expected, so the write cannot reach the
    // service method that shares the name.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/app.ts',
      [
        'class DeviceLibraryService {',
        '  deleteDevice(): void {}',
        '  ping(): void {}',
        '}',
        'interface DiagramHandle { deleteDevice(): void; focus(): void }',
        'declare function useImperativeHandle<T, R extends T>(ref: { current: T | null }, init: () => R): void;',
        'declare const ref: { current: DiagramHandle | null };',
        'const deleteDevice = () => {};',
        'export function mount(): void {',
        '  useImperativeHandle(ref, () => ({ deleteDevice, focus() {} }));',
        '}',
        'export const keep = () => new DeviceLibraryService().ping();',
        'declare const handle: DiagramHandle;',
        'export const use = () => handle.focus();',
        '',
      ].join('\n')
    );
    project.createSourceFile('/index.ts', "import { mount, keep, use } from './app';\nmount();\nkeep();\nuse();\n");
    const findings = analyze(project);
    const member = memberOf(findings, 'deleteDevice');
    expect(member?.verdict).toBe('dead');
    expect(member?.evidence).toContain('every write of the name feeds another type');
    expect(member?.evidence).toMatch(/app\.ts:10/);
  });

  it('gives uncalled siblings the same verdict whatever the collision position', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/app.ts',
      [
        'class DeviceLibraryService {',
        '  loadDevice(): void {}',
        '  listDevicesByCategory(): void {}',
        '  deleteDevice(): void {}',
        '  ping(): void {}',
        '}',
        'interface DiagramHandle { deleteDevice(): void; focus(): void }',
        'declare function useImperativeHandle<T, R extends T>(ref: { current: T | null }, init: () => R): void;',
        'declare const ref: { current: DiagramHandle | null };',
        'const deleteDevice = () => {};',
        'export function mount(): void {',
        '  useImperativeHandle(ref, () => ({ deleteDevice, focus() {} }));',
        '}',
        'export const keep = () => new DeviceLibraryService().ping();',
        'declare const handle: DiagramHandle;',
        'export const use = () => handle.focus();',
        '',
      ].join('\n')
    );
    project.createSourceFile('/index.ts', "import { mount, keep, use } from './app';\nmount();\nkeep();\nuse();\n");
    const findings = analyze(project);
    for (const name of ['loadDevice', 'listDevicesByCategory', 'deleteDevice']) {
      expect(memberOf(findings, name)?.verdict).toBe('dead');
    }
  });

  it('reads the proof off a return annotation instead of guessing', () => {
    // `useMemo` infers its type argument from the factory, so the literal's
    // contextual type is its own shape. The annotation on the hook is the
    // destination: every caller reads the result as `LimiterColors`.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/app.ts',
      [
        'export interface LimiterColors {',
        '  track: string;',
        '  thumb: string;',
        '}',
        'declare function useMemo<T>(factory: () => T, deps: unknown[]): T;',
        'export function useLimiterColors(): LimiterColors {',
        '  const track = "a";',
        '  const thumb = "b";',
        '  return useMemo(() => ({ track, thumb }), []);',
        '}',
        'declare const colors: LimiterColors;',
        'export const read = () => colors.thumb;',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/index.ts',
      "import { useLimiterColors, read } from './app';\nuseLimiterColors();\nread();\n"
    );
    const findings = analyze(project);
    const member = memberOf(findings, 'track');
    expect(member?.verdict).toBe('write-only');
    expect(member?.evidence).toContain('a typed write at');
    expect(member?.evidence).toContain('proven, never read');
    expect(member?.evidence).toMatch(/app\.ts:9/);
  });

  it('reads the annotation on an arrow hook too', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/app.ts',
      [
        'export interface LimiterColors {',
        '  track: string;',
        '  thumb: string;',
        '}',
        'declare function useMemo<T>(factory: () => T, deps: unknown[]): T;',
        'export const useLimiterColors = (): LimiterColors => useMemo(() => ({ track: "a", thumb: "b" }), []);',
        'declare const colors: LimiterColors;',
        'export const read = () => colors.thumb;',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/index.ts',
      "import { useLimiterColors, read } from './app';\nuseLimiterColors();\nread();\n"
    );
    const findings = analyze(project);
    expect(memberOf(findings, 'track')?.evidence).toContain('a typed write at');
  });

  it('keeps the write unverified when the shape could be the owner after all', () => {
    // Same argument position, but the literal carries everything the class
    // declares. Nothing rules the write out, so the label stays honest.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/app.ts',
      [
        'class Api {',
        '  deleteDevice(): void {}',
        '}',
        'declare function register<T>(init: () => T): void;',
        'const deleteDevice = () => {};',
        'export function mount(): void {',
        '  register(() => ({ deleteDevice }));',
        '}',
        'export const keep = () => new Api();',
        '',
      ].join('\n')
    );
    project.createSourceFile('/index.ts', "import { mount, keep } from './app';\nmount();\nkeep();\n");
    const findings = analyze(project);
    const member = memberOf(findings, 'deleteDevice');
    expect(member?.verdict).toBe('write-only');
    expect(member?.evidence).toContain('unverified name match');
  });

  it('keeps a write that escapes past the argument position', () => {
    // The value does reach a call that types it from itself, but it also
    // lands in an array nobody typed. One unaccounted exit is enough.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface Device {',
        '  ip: string;',
        '  port: number;',
        '}',
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
    expect(member?.evidence).toContain('unverified name match');
  });
});
