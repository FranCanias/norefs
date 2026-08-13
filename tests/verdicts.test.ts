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

  it('marks types crossing a project-declared bridge as contract, both directions', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/bridge.d.ts',
      [
        'interface Bridge {',
        '  invoke(channel: string, payload?: unknown): Promise<unknown>;',
        '}',
        'declare const api: Bridge;',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/main.ts',
      [
        'interface LibraryDevice {',
        '  ip: string;',
        '  label: string;',
        '}',
        'interface SavePayload {',
        '  device: LibraryDevice;',
        '  revision: number;',
        '}',
        'export async function load(): Promise<LibraryDevice[]> {',
        "  return (await api.invoke('deviceLibrary:list')) as LibraryDevice[];",
        '}',
        'export function save(payload: SavePayload): Promise<unknown> {',
        "  return api.invoke('deviceLibrary:save', payload);",
        '}',
        'export const show = (d: LibraryDevice) => d.label;',
        'export const device = (p: SavePayload) => p.device;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);

    // `ip` is unread in this process, but the type crosses the bridge.
    expect(verdictOf(findings, 'ip')?.verdict).toBe('contract');
    expect(verdictOf(findings, 'ip')?.evidence).toContain('api.invoke');
    // `revision` rides the send side of the same edge.
    expect(verdictOf(findings, 'revision')?.verdict).toBe('contract');
  });

  it('marks the asserted result of an untraced call as contract', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface Config {',
        '  retries: number;',
        '  timeout: number;',
        '}',
        'declare const response: { json(): Promise<any> };',
        'export async function load(): Promise<Config> {',
        '  return (await response.json()) as Config;',
        '}',
        'export const use = (c: Config) => c.timeout;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    expect(verdictOf(findings, 'retries')?.verdict).toBe('contract');
    expect(verdictOf(findings, 'retries')?.evidence).toContain('json');
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

  it('marks a member as shadowed when a same-named type overlaps the shape', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/a.ts',
      [
        'export interface IOWithSoundZones {',
        '  id?: string;',
        '  name?: string;',
        '  soundZones?: string[];',
        '  alias?: string;',
        '}',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/b.ts',
      [
        'export interface IOWithSoundZones {',
        '  id: string;',
        '  soundZones?: string[];',
        '}',
        'export const pick = (v: IOWithSoundZones) => v.id + (v.soundZones ?? []).length;',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/main.ts',
      [
        "import type { IOWithSoundZones } from './a';",
        "import { pick } from './b';",
        'declare const io: IOWithSoundZones;',
        "export const run = () => pick({ id: io.id ?? '', soundZones: io.soundZones }) + (io.alias ?? '');",
        '',
      ].join('\n')
    );
    const findings = analyze(project);

    const name = findings.find(f => f.kind === 'member' && f.name === 'name');
    expect(name?.verdict).toBe('shadowed');
    expect(name?.evidence).toContain('IOWithSoundZones');
    expect(name?.evidence).toContain('b.ts');
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
