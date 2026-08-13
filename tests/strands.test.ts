import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import { formatText } from '../src/engine/report';

/** A dead wrapper under /src whose handler lives in an entry file outside it. */
function scopedProject(header = ''): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(
    '/bridge.d.ts',
    ['interface Bridge {', '  invoke(channel: string): Promise<unknown>;', '}', 'declare const api: Bridge;', ''].join(
      '\n'
    )
  );
  project.createSourceFile(
    '/src/app.ts',
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
    '/main.ts',
    [
      `${header}import { keep } from './src/app';`,
      'keep();',
      'declare function handle(channel: string, listener: () => unknown): void;',
      "handle('deviceLibrary:loadDevice', () => 0);",
      '',
    ].join('\n')
  );
  return project;
}

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

  it('reports the far side as a finding of its own', () => {
    // The note says the handler is about to become invisible. The finding is
    // what makes it visible while it still can be: its own file, its own line.
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
    const stranded = findings.find(f => f.kind === 'stranded');
    expect(stranded?.name).toBe('deviceLibrary:loadDevice');
    expect(stranded?.filePath).toBe('/index.ts');
    expect(stranded?.line).toBe(4);
    expect(stranded?.evidence).toContain('its only sender');
    expect(stranded?.evidence).toMatch(/`loadDevice` at .*app\.ts:2/);
    expect(formatText(findings, '/')).toContain('stranded handler');
  });

  it('stays silent while another sender of the channel is alive', () => {
    // Deleting a dead wrapper strands nothing while a live one still sends
    // the same channel. The note is a claim about reachability, not about
    // who happens to be reported today.
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
        "export const reload = () => api.invoke('deviceLibrary:loadDevice');",
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/index.ts',
      [
        "import { keep, reload } from './app';",
        'keep();',
        'reload();',
        'declare function handle(channel: string, listener: () => unknown): void;',
        "handle('deviceLibrary:loadDevice', () => 0);",
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const wrapper = findings.find(f => f.kind === 'member' && f.name === 'loadDevice');
    expect(wrapper?.verdict).toBe('dead');
    expect(wrapper?.strands).toBeUndefined();
    expect(findings.some(f => f.kind === 'stranded')).toBe(false);
  });

  it('notes the far side of a wrapper the analysis could not call dead', () => {
    // A write-only wrapper is a wrapper a human may still delete. The note it
    // needs is the same one, and the strand rides on any reported verdict.
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
        '  deleteDevice(): Promise<unknown> {',
        "    return api.invoke('deviceLibrary:deleteDevice');",
        '  }',
        '  ping(): void {}',
        '}',
        'declare function stash(payload: unknown): void;',
        'const deleteDevice = () => {};',
        'export const send = () => stash({ deleteDevice });',
        'export const keep = () => new DeviceLibrary().ping();',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/index.ts',
      [
        "import { send, keep } from './app';",
        'send();',
        'keep();',
        'declare function handle(channel: string, listener: () => unknown): void;',
        "handle('deviceLibrary:deleteDevice', () => 0);",
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const wrapper = findings.find(f => f.kind === 'member' && f.name === 'deleteDevice');
    expect(wrapper?.verdict).toBe('write-only');
    expect(wrapper?.strands).toContain("'deviceLibrary:deleteDevice'");
    expect(findings.some(f => f.kind === 'stranded')).toBe(true);
  });

  it('keeps the far side out of a report it was not asked for', () => {
    // The handler lives outside --scope, and a scoped run promises findings
    // declared under that path only. The note on the in-scope wrapper still
    // names it, so the coordinates are never lost — only the extra finding is.
    const project = scopedProject();
    const scoped = analyze(project, { scopeDir: '/src' });
    expect(scoped.some(f => f.kind === 'stranded')).toBe(false);
    expect(scoped.find(f => f.name === 'loadDevice')?.strands).toMatch(/main\.ts:4/);
    // Unscoped, the same project reports it.
    expect(analyze(project).some(f => f.kind === 'stranded')).toBe(true);
  });

  it('honours a suppression on the handler file', () => {
    const project = scopedProject('// norefs-ignore-file\n');
    const findings = analyze(project);
    expect(findings.some(f => f.kind === 'stranded')).toBe(false);
    expect(findings.find(f => f.name === 'loadDevice')?.strands).toBeDefined();
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
