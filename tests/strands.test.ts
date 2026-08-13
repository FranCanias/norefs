import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import { formatText } from '../src/engine/report';

describe('stranded far sides of dead bridge wrappers', () => {
  it('names the registration that shares the dead wrapper channel string', () => {
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
      '/app.ts',
      [
        'class DeviceLibrary {',
        '  loadDevice(): Promise<unknown> {',
        "    return api.invoke('deviceLibrary:loadDevice');",
        '  }',
        '  ping(): void {}',
        '}',
        'export const keep = () => new DeviceLibrary().ping();',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/index.ts',
      [
        "import { keep } from './app';",
        'keep();',
        'declare function handle(channel: string, listener: () => unknown): void;',
        "handle('deviceLibrary:loadDevice', () => 0);",
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const wrapper = findings.find(f => f.kind === 'member' && f.name === 'loadDevice');
    expect(wrapper?.verdict).toBe('dead');
    expect(wrapper?.strands).toContain("'deviceLibrary:loadDevice'");
    expect(wrapper?.strands).toMatch(/index\.ts:4/);
    // The pair rides in the default report, not only behind --explain.
    expect(formatText(findings, '/')).toContain('strands the far side');
  });

  it('never treats a payload string as a channel', () => {
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
      '/app.ts',
      [
        'class Settings {',
        '  save(): Promise<unknown> {',
        "    return api.invoke('config:save', 'defaultProfile');",
        '  }',
        '  ping(): void {}',
        '}',
        'export const keep = () => new Settings().ping();',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/index.ts',
      [
        "import { keep } from './app';",
        'keep();',
        'declare function t(key: string, fallback: string): string;',
        "t('defaultProfile', 'Default');",
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const wrapper = findings.find(f => f.kind === 'member' && f.name === 'save');
    expect(wrapper?.verdict).toBe('dead');
    expect(wrapper?.strands).toBeUndefined();
  });

  it('never cites another dead wrapper as the far side', () => {
    // A bridge call is a near side by definition. Two dead wrappers sharing
    // a channel with no registration anywhere must both stay silent.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/bridge.d.ts',
      [
        'interface Bridge {',
        '  invoke(channel: string): Promise<unknown>;',
        '}',
        'declare const api: Bridge;',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/a.ts',
      [
        'export class A {',
        '  load(): Promise<unknown> {',
        "    return api.invoke('d:load');",
        '  }',
        '  ping(): void {}',
        '}',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/b.ts',
      [
        'export class B {',
        '  reload(): Promise<unknown> {',
        "    return api.invoke('d:load');",
        '  }',
        '  ping(): void {}',
        '}',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/index.ts',
      ["import { A } from './a';", "import { B } from './b';", 'new A().ping();', 'new B().ping();', ''].join('\n')
    );
    const findings = analyze(project);
    for (const name of ['load', 'reload']) {
      const wrapper = findings.find(f => f.kind === 'member' && f.name === name);
      expect(wrapper?.verdict).toBe('dead');
      expect(wrapper?.strands).toBeUndefined();
    }
  });

  it('carries the note onto the empty-type finding when the whole wrapper dies', () => {
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
      '/app.ts',
      [
        'const useDeviceIpc = () => ({',
        "  loadDevice: () => api.invoke('deviceLibrary:loadDevice'),",
        '});',
        'export const keep = () => {',
        '  useDeviceIpc();',
        '};',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/index.ts',
      [
        "import { keep } from './app';",
        'keep();',
        'declare function handle(channel: string, listener: () => unknown): void;',
        "handle('deviceLibrary:loadDevice', () => 0);",
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const folded = findings.find(f => f.kind === 'empty-type' && f.name === 'useDeviceIpc');
    expect(folded).toBeDefined();
    expect(folded?.strands).toContain("'deviceLibrary:loadDevice'");
    expect(formatText(findings, '/')).toContain('strands the far side');
  });

  it('stays silent when the channel string never reappears', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/bridge.d.ts',
      [
        'interface Bridge {',
        '  invoke(channel: string): Promise<unknown>;',
        '}',
        'declare const api: Bridge;',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/app.ts',
      [
        'class DeviceLibrary {',
        '  loadDevice(): Promise<unknown> {',
        "    return api.invoke('deviceLibrary:loadDevice');",
        '  }',
        '  ping(): void {}',
        '}',
        'export const keep = () => new DeviceLibrary().ping();',
        '',
      ].join('\n')
    );
    project.createSourceFile('/index.ts', "import { keep } from './app';\nkeep();\n");
    const findings = analyze(project);
    const wrapper = findings.find(f => f.kind === 'member' && f.name === 'loadDevice');
    expect(wrapper?.verdict).toBe('dead');
    expect(wrapper?.strands).toBeUndefined();
  });
});
