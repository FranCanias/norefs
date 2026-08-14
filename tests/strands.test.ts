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
      'class RecipeBox {',
      '  loadRecipe(): Promise<unknown> {',
      "    return api.invoke('recipeBox:loadRecipe');",
      '  }',
      '  ping(): void {}',
      '}',
      'export const keep = () => new RecipeBox().ping();',
      '',
    ].join('\n')
  );
  project.createSourceFile(
    '/main.ts',
    [
      `${header}import { keep } from './src/app';`,
      'keep();',
      'declare function handle(channel: string, listener: () => unknown): void;',
      "handle('recipeBox:loadRecipe', () => 0);",
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
        'class RecipeBox {',
        '  loadRecipe(): Promise<unknown> {',
        "    return api.invoke('recipeBox:loadRecipe');",
        '  }',
        '  ping(): void {}',
        '}',
        'export const keep = () => new RecipeBox().ping();',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/index.ts',
      [
        "import { keep } from './app';",
        'keep();',
        'declare function handle(channel: string, listener: () => unknown): void;',
        "handle('recipeBox:loadRecipe', () => 0);",
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const wrapper = findings.find(f => f.kind === 'member' && f.name === 'loadRecipe');
    expect(wrapper?.verdict).toBe('dead');
    expect(wrapper?.strands).toContain("'recipeBox:loadRecipe'");
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
        'class RecipeBox {',
        '  loadRecipe(): Promise<unknown> {',
        "    return api.invoke('recipeBox:loadRecipe');",
        '  }',
        '  ping(): void {}',
        '}',
        'export const keep = () => new RecipeBox().ping();',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/index.ts',
      [
        "import { keep } from './app';",
        'keep();',
        'declare function handle(channel: string, listener: () => unknown): void;',
        "handle('recipeBox:loadRecipe', () => 0);",
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const stranded = findings.find(f => f.kind === 'stranded');
    expect(stranded?.name).toBe('recipeBox:loadRecipe');
    expect(stranded?.filePath).toBe('/index.ts');
    expect(stranded?.line).toBe(4);
    expect(stranded?.evidence).toContain('its only sender');
    expect(stranded?.evidence).toMatch(/`loadRecipe` at .*app\.ts:2/);
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
        'class RecipeBox {',
        '  loadRecipe(): Promise<unknown> {',
        "    return api.invoke('recipeBox:loadRecipe');",
        '  }',
        '  ping(): void {}',
        '}',
        'export const keep = () => new RecipeBox().ping();',
        "export const reload = () => api.invoke('recipeBox:loadRecipe');",
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
        "handle('recipeBox:loadRecipe', () => 0);",
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const wrapper = findings.find(f => f.kind === 'member' && f.name === 'loadRecipe');
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
        'class RecipeBox {',
        '  deleteRecipe(): Promise<unknown> {',
        "    return api.invoke('recipeBox:deleteRecipe');",
        '  }',
        '  ping(): void {}',
        '}',
        'declare function stash(payload: unknown): void;',
        'const deleteRecipe = () => {};',
        'export const send = () => stash({ deleteRecipe });',
        'export const keep = () => new RecipeBox().ping();',
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
        "handle('recipeBox:deleteRecipe', () => 0);",
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const wrapper = findings.find(f => f.kind === 'member' && f.name === 'deleteRecipe');
    expect(wrapper?.verdict).toBe('write-only');
    expect(wrapper?.strands).toContain("'recipeBox:deleteRecipe'");
    expect(findings.some(f => f.kind === 'stranded')).toBe(true);
  });

  it('says nothing when the sender only loses its export keyword', () => {
    // The 0.4.0 review's exhibit. `RecipeBoxService` is over-exported: the
    // fix removes a keyword and deletes nothing, so `saveRecipe` still sends
    // on every channel and no handler is stranded. Reported is not dying.
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
      '/service.ts',
      [
        'export class RecipeBoxService {',
        '  saveRecipe(recipe: unknown): Promise<unknown> {',
        "    return api.invoke('recipeBox:saveRecipe', recipe);",
        '  }',
        '}',
        'export const sidebar = () => new RecipeBoxService().saveRecipe(1);',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/index.ts',
      [
        "import { sidebar } from './service';",
        'sidebar();',
        'declare function handle(channel: string, listener: () => unknown): void;',
        "handle('recipeBox:saveRecipe', () => 0);",
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const service = findings.find(f => f.name === 'RecipeBoxService');
    expect(service?.verdict).toBe('over-exported');
    expect(service?.strands).toBeUndefined();
    expect(findings.some(f => f.kind === 'stranded')).toBe(false);
  });

  it('answers for the method that holds the sender, not the class around it', () => {
    // The other half of the same exhibit: one class, two channels, two fates.
    // `oldRecipe` is dead and strands its handler; `saveRecipe` has a live
    // caller and strands nothing. Flattening both into the class loses that.
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
      '/service.ts',
      [
        'export class RecipeBoxService {',
        '  saveRecipe(recipe: unknown): Promise<unknown> {',
        "    return api.invoke('recipeBox:saveRecipe', recipe);",
        '  }',
        '  oldRecipe(): Promise<unknown> {',
        "    return api.invoke('recipeBox:oldRecipe');",
        '  }',
        '}',
        'export const sidebar = () => new RecipeBoxService().saveRecipe(1);',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/index.ts',
      [
        "import { sidebar } from './service';",
        'sidebar();',
        'declare function handle(channel: string, listener: () => unknown): void;',
        "handle('recipeBox:saveRecipe', () => 0);",
        "handle('recipeBox:oldRecipe', () => 0);",
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    expect(findings.find(f => f.name === 'RecipeBoxService')?.verdict).toBe('over-exported');
    expect(findings.find(f => f.name === 'oldRecipe')?.strands).toContain("'recipeBox:oldRecipe'");
    const stranded = findings.filter(f => f.kind === 'stranded');
    expect(stranded.map(f => f.name)).toEqual(['recipeBox:oldRecipe']);
    // The method holding the sender, named — not the class holding both fates.
    expect(stranded[0]?.evidence).toContain('`oldRecipe`');
    expect(stranded[0]?.evidence).not.toContain('RecipeBoxService');
    expect(stranded[0]?.evidence).toContain('this report says to delete');
  });

  it('keeps the far side out of a report it was not asked for', () => {
    // The handler lives outside --scope, and a scoped run promises findings
    // declared under that path only. The note on the in-scope wrapper still
    // names it, so the coordinates are never lost — only the extra finding is.
    const project = scopedProject();
    const scoped = analyze(project, { scopeDir: '/src' });
    expect(scoped.some(f => f.kind === 'stranded')).toBe(false);
    expect(scoped.find(f => f.name === 'loadRecipe')?.strands).toMatch(/main\.ts:4/);
    // Unscoped, the same project reports it.
    expect(analyze(project).some(f => f.kind === 'stranded')).toBe(true);
  });

  it('honours a suppression on the handler file', () => {
    const project = scopedProject('// norefs-ignore-file\n');
    const findings = analyze(project);
    expect(findings.some(f => f.kind === 'stranded')).toBe(false);
    expect(findings.find(f => f.name === 'loadRecipe')?.strands).toBeDefined();
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
        'const useRecipeIpc = () => ({',
        "  loadRecipe: () => api.invoke('recipeBox:loadRecipe'),",
        '});',
        'export const keep = () => {',
        '  useRecipeIpc();',
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
        "handle('recipeBox:loadRecipe', () => 0);",
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const folded = findings.find(f => f.kind === 'empty-type' && f.name === 'useRecipeIpc');
    expect(folded).toBeDefined();
    expect(folded?.strands).toContain("'recipeBox:loadRecipe'");
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
        'class RecipeBox {',
        '  loadRecipe(): Promise<unknown> {',
        "    return api.invoke('recipeBox:loadRecipe');",
        '  }',
        '  ping(): void {}',
        '}',
        'export const keep = () => new RecipeBox().ping();',
        '',
      ].join('\n')
    );
    project.createSourceFile('/index.ts', "import { keep } from './app';\nkeep();\n");
    const findings = analyze(project);
    const wrapper = findings.find(f => f.kind === 'member' && f.name === 'loadRecipe');
    expect(wrapper?.verdict).toBe('dead');
    expect(wrapper?.strands).toBeUndefined();
  });
});
