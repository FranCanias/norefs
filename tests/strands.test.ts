import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import { formatText } from '../src/engine/report';
import type { Boundary, EmptyTypeFinding, ExportFinding, Finding, MemberFinding } from '../src/types';

/** Find a reported wrapper by name, narrowed to the kinds that carry a strand note. */
function sender(findings: Finding[], name: string): MemberFinding | ExportFinding | undefined {
  return findings.find(
    (f): f is MemberFinding | ExportFinding => (f.kind === 'member' || f.kind === 'export') && f.name === name
  );
}

/** The bridge every case here varies: one `invoke` channel API, plus these files. */
function bridgeProject(files: Record<string, string>): Project {
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
  for (const [filePath, text] of Object.entries(files)) project.createSourceFile(filePath, text);
  return project;
}

/** The far side, as an entry file registers it. */
const HANDLE = 'declare function handle(channel: string, listener: () => unknown): void;';

/** A class with one dead bridge wrapper on `channel`, and one live method. */
function deadWrapper(name: string, channel: string): string {
  return [
    'class RecipeBox {',
    `  ${name}(): Promise<unknown> {`,
    `    return api.invoke('${channel}');`,
    '  }',
    '  ping(): void {}',
    '}',
    'export const keep = () => new RecipeBox().ping();',
    '',
  ].join('\n');
}

/** A dead wrapper under /src whose handler lives in an entry file outside it. */
function scopedProject(header = ''): Project {
  return bridgeProject({
    '/src/app.ts': deadWrapper('loadRecipe', 'recipeBox:loadRecipe'),
    '/main.ts': [
      `${header}import { keep } from './src/app';`,
      'keep();',
      HANDLE,
      "handle('recipeBox:loadRecipe', () => 0);",
      '',
    ].join('\n'),
  });
}

describe('stranded far sides of dead bridge wrappers', () => {
  it('names the registration that shares the dead wrapper channel, and reports it', () => {
    // The note tells the reader the handler is about to become invisible. The
    // finding is what makes it visible while it still can be: its own file,
    // its own line.
    const project = bridgeProject({
      '/app.ts': deadWrapper('loadRecipe', 'recipeBox:loadRecipe'),
      '/index.ts': [
        "import { keep } from './app';",
        'keep();',
        HANDLE,
        "handle('recipeBox:loadRecipe', () => 0);",
        '',
      ].join('\n'),
    });
    const findings = analyze(project);

    const found = sender(findings, 'loadRecipe');
    expect(found?.verdict).toBe('dead');
    expect(found?.strands).toContain("'recipeBox:loadRecipe'");
    expect(found?.strands).toMatch(/index\.ts:4/);

    const stranded = findings.find(f => f.kind === 'stranded');
    expect(stranded?.name).toBe('recipeBox:loadRecipe');
    expect(stranded?.filePath).toBe('/index.ts');
    expect(stranded?.line).toBe(4);
    expect(stranded?.evidence).toContain('its only sender');
    expect(stranded?.evidence).toMatch(/`loadRecipe` at .*app\.ts:2/);

    // Both ride in the default report, not only behind --explain.
    const report = formatText(findings, '/');
    expect(report).toContain('strands the far side');
    expect(report).toContain('stranded handler');
  });

  it('stays silent while another sender of the channel is alive', () => {
    // Deleting a dead wrapper strands nothing while a live one still sends
    // the same channel. The note is a claim about reachability, not about
    // who happens to be reported today.
    const project = bridgeProject({
      '/app.ts': [
        'class RecipeBox {',
        '  loadRecipe(): Promise<unknown> {',
        "    return api.invoke('recipeBox:loadRecipe');",
        '  }',
        '  ping(): void {}',
        '}',
        'export const keep = () => new RecipeBox().ping();',
        "export const reload = () => api.invoke('recipeBox:loadRecipe');",
        '',
      ].join('\n'),
      '/index.ts': [
        "import { keep, reload } from './app';",
        'keep();',
        'reload();',
        HANDLE,
        "handle('recipeBox:loadRecipe', () => 0);",
        '',
      ].join('\n'),
    });
    const findings = analyze(project);
    const wrapper = sender(findings, 'loadRecipe');
    expect(wrapper?.verdict).toBe('dead');
    expect(wrapper?.strands).toBeUndefined();
    expect(findings.some(f => f.kind === 'stranded')).toBe(false);
  });

  it('notes the far side of a wrapper the analysis could not call dead', () => {
    // A write-only wrapper is a wrapper a human may still delete. The note it
    // needs is the same one, and the strand rides on any reported verdict.
    const project = bridgeProject({
      '/app.ts': [
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
      ].join('\n'),
      '/index.ts': [
        "import { send, keep } from './app';",
        'send();',
        'keep();',
        HANDLE,
        "handle('recipeBox:deleteRecipe', () => 0);",
        '',
      ].join('\n'),
    });
    const findings = analyze(project);
    const wrapper = sender(findings, 'deleteRecipe');
    expect(wrapper?.verdict).toBe('write-only');
    expect(wrapper?.strands).toContain("'recipeBox:deleteRecipe'");
    expect(findings.some(f => f.kind === 'stranded')).toBe(true);
  });

  it('says nothing when the sender only loses its export keyword', () => {
    // The 0.4.0 review's exhibit. `RecipeBoxService` is over-exported: the
    // fix removes a keyword and deletes nothing, so `saveRecipe` still sends
    // on every channel and no handler is stranded. Reported is not dying.
    const project = bridgeProject({
      '/service.ts': [
        'export class RecipeBoxService {',
        '  saveRecipe(recipe: unknown): Promise<unknown> {',
        "    return api.invoke('recipeBox:saveRecipe', recipe);",
        '  }',
        '}',
        'export const sidebar = () => new RecipeBoxService().saveRecipe(1);',
        '',
      ].join('\n'),
      '/index.ts': [
        "import { sidebar } from './service';",
        'sidebar();',
        HANDLE,
        "handle('recipeBox:saveRecipe', () => 0);",
        '',
      ].join('\n'),
    });
    const findings = analyze(project);
    const service = sender(findings, 'RecipeBoxService');
    expect(service?.verdict).toBe('over-exported');
    expect(service?.strands).toBeUndefined();
    expect(findings.some(f => f.kind === 'stranded')).toBe(false);
  });

  it('answers for the method that holds the sender, not the class around it', () => {
    // The other half of the same exhibit: one class, two channels, two fates.
    // `oldRecipe` is dead and strands its handler; `saveRecipe` has a live
    // caller and strands nothing. Flattening both into the class loses that.
    const project = bridgeProject({
      '/service.ts': [
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
      ].join('\n'),
      '/index.ts': [
        "import { sidebar } from './service';",
        'sidebar();',
        HANDLE,
        "handle('recipeBox:saveRecipe', () => 0);",
        "handle('recipeBox:oldRecipe', () => 0);",
        '',
      ].join('\n'),
    });
    const findings = analyze(project);
    expect(findings.find(f => f.name === 'RecipeBoxService')?.verdict).toBe('over-exported');
    expect(sender(findings, 'oldRecipe')?.strands).toContain("'recipeBox:oldRecipe'");
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
    expect(sender(scoped, 'loadRecipe')?.strands).toMatch(/main\.ts:4/);
    // Unscoped, the same project reports it.
    expect(analyze(project).some(f => f.kind === 'stranded')).toBe(true);
  });

  it('honours a suppression on the handler file', () => {
    const project = scopedProject('// norefs-ignore-file\n');
    const findings = analyze(project);
    expect(findings.some(f => f.kind === 'stranded')).toBe(false);
    expect(sender(findings, 'loadRecipe')?.strands).toBeDefined();
  });

  it('never treats a payload string as a channel', () => {
    const project = bridgeProject({
      '/app.ts': [
        'class Settings {',
        '  save(): Promise<unknown> {',
        "    return api.invoke('config:save', 'defaultProfile');",
        '  }',
        '  ping(): void {}',
        '}',
        'export const keep = () => new Settings().ping();',
        '',
      ].join('\n'),
      '/index.ts': [
        "import { keep } from './app';",
        'keep();',
        'declare function t(key: string, fallback: string): string;',
        "t('defaultProfile', 'Default');",
        '',
      ].join('\n'),
    });
    const findings = analyze(project);
    const wrapper = sender(findings, 'save');
    expect(wrapper?.verdict).toBe('dead');
    expect(wrapper?.strands).toBeUndefined();
  });

  it('never cites another dead wrapper as the far side', () => {
    // A bridge call is a near side by definition. Two dead wrappers sharing
    // a channel with no registration anywhere must both stay silent.
    const project = bridgeProject({
      '/a.ts': [
        'export class A {',
        '  load(): Promise<unknown> {',
        "    return api.invoke('d:load');",
        '  }',
        '  ping(): void {}',
        '}',
        '',
      ].join('\n'),
      '/b.ts': [
        'export class B {',
        '  reload(): Promise<unknown> {',
        "    return api.invoke('d:load');",
        '  }',
        '  ping(): void {}',
        '}',
        '',
      ].join('\n'),
      '/index.ts': [
        "import { A } from './a';",
        "import { B } from './b';",
        'new A().ping();',
        'new B().ping();',
        '',
      ].join('\n'),
    });
    const findings = analyze(project);
    for (const name of ['load', 'reload']) {
      const wrapper = sender(findings, name);
      expect(wrapper?.verdict).toBe('dead');
      expect(wrapper?.strands).toBeUndefined();
    }
  });

  it('carries the note onto the empty-type finding when the whole wrapper dies', () => {
    const project = bridgeProject({
      '/app.ts': [
        'const useRecipeIpc = () => ({',
        "  loadRecipe: () => api.invoke('recipeBox:loadRecipe'),",
        '});',
        'export const keep = () => {',
        '  useRecipeIpc();',
        '};',
        '',
      ].join('\n'),
      '/index.ts': [
        "import { keep } from './app';",
        'keep();',
        HANDLE,
        "handle('recipeBox:loadRecipe', () => 0);",
        '',
      ].join('\n'),
    });
    const findings = analyze(project);
    const folded = findings.find((f): f is EmptyTypeFinding => f.kind === 'empty-type' && f.name === 'useRecipeIpc');
    expect(folded).toBeDefined();
    expect(folded?.strands).toContain("'recipeBox:loadRecipe'");
    expect(formatText(findings, '/')).toContain('strands the far side');
  });

  it('stays silent when the channel string never reappears', () => {
    const project = bridgeProject({
      '/app.ts': deadWrapper('loadRecipe', 'recipeBox:loadRecipe'),
      '/index.ts': "import { keep } from './app';\nkeep();\n",
    });
    const findings = analyze(project);
    const wrapper = sender(findings, 'loadRecipe');
    expect(wrapper?.verdict).toBe('dead');
    expect(wrapper?.strands).toBeUndefined();
  });
});

/**
 * A REST project: a client that fetches, a route table that registers, and an
 * entry that imports both. The route table exports nothing — the way route
 * tables are written — so it reaches the analysis only through a side-effect
 * import.
 */
function restProject(clientBody: string, routes: string[]): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(
    '/server.d.ts',
    [
      'interface Router {',
      '  get(path: string, handler: () => void): void;',
      '  post(path: string, handler: () => void): void;',
      '}',
      'declare const app: Router;',
      'declare function fetch(input: string, init?: unknown): Promise<unknown>;',
      '',
    ].join('\n')
  );
  project.createSourceFile('/routes.ts', `${routes.join('\n')}\n`);
  project.createSourceFile('/client.ts', clientBody);
  project.createSourceFile(
    '/index.ts',
    ["import './routes';", "import { ApiClient } from './client';", 'new ApiClient().live();', ''].join('\n')
  );
  return project;
}

const CLIENT = [
  'export class ApiClient {',
  '  live(): Promise<unknown> {',
  "    return fetch('/api/recipes');",
  '  }',
  '  gone(): Promise<unknown> {',
  "    return fetch('/api/recipes/legacy', { method: 'POST' });",
  '  }',
  '}',
  '',
].join('\n');

const REST: Boundary[] = [{ send: ['fetch'], handle: ['app.get', 'app.post'] }];

describe('boundaries the project declares', () => {
  it('pairs a dead fetch with the route it was the last sender of', () => {
    const project = restProject(CLIENT, [
      "app.get('/api/recipes', () => {});",
      "app.post('/api/recipes/legacy', () => {});",
    ]);
    const findings = analyze(project, { boundaries: REST });
    const gone = sender(findings, 'gone');
    expect(gone?.strands).toContain("far side of `'/api/recipes/legacy'`");
    const stranded = findings.filter(f => f.kind === 'stranded');
    expect(stranded.map(f => f.name)).toEqual(['/api/recipes/legacy']);
    // The live route keeps its handler: `live` still sends to it.
    expect(stranded[0]?.filePath).toBe('/routes.ts');
  });

  it('finds nothing without the declaration — the shape alone never pairs', () => {
    // The whole point of the config key. `fetch` and `app.post` are ordinary
    // library calls; no shape says one feeds the other.
    const project = restProject(CLIENT, [
      "app.get('/api/recipes', () => {});",
      "app.post('/api/recipes/legacy', () => {});",
    ]);
    const findings = analyze(project);
    expect(findings.filter(f => f.kind === 'stranded')).toEqual([]);
    expect(sender(findings, 'gone')?.strands).toBeUndefined();
  });

  it('a surviving sender of the same route strands nothing', () => {
    const client = CLIENT.replace("'/api/recipes/legacy', { method: 'POST' }", "'/api/recipes'");
    const project = restProject(client, ["app.get('/api/recipes', () => {});"]);
    const findings = analyze(project, { boundaries: REST });
    expect(findings.filter(f => f.kind === 'stranded')).toEqual([]);
    expect(findings.find(f => f.name === 'gone')?.verdict).toBe('dead');
  });

  it('matches a template-literal fetch against a :param route, and names the route as written', () => {
    const client = CLIENT.replace("'/api/recipes/legacy', { method: 'POST' }", `\`/api/audit/\${String(1)}/history\``);
    const project = restProject(client, [
      "app.get('/api/recipes', () => {});",
      "app.get('/api/audit/:id/history', () => {});",
    ]);
    const findings = analyze(project, { boundaries: REST });
    const stranded = findings.filter(f => f.kind === 'stranded');
    // Matching cuts the route at its first hole; the report never does.
    expect(stranded.map(f => f.name)).toEqual(['/api/audit/:id/history']);
  });

  it('keeps the list route apart from the item route under it', () => {
    // The pair every REST API has. Matching a route by its static head alone
    // would fold these into one channel, and the live sender of the list route
    // would then hide the stranded handler of the item route.
    const client = CLIENT.replace("'/api/recipes/legacy', { method: 'POST' }", `\`/api/recipes/\${String(1)}\``);
    const project = restProject(client, [
      "app.get('/api/recipes', () => {});",
      "app.get('/api/recipes/:id', () => {});",
    ]);
    const findings = analyze(project, { boundaries: REST });
    expect(findings.filter(f => f.kind === 'stranded').map(f => f.name)).toEqual(['/api/recipes/:id']);
  });

  it('does not pair across two boundaries that share a channel', () => {
    const project = restProject(CLIENT, [
      "app.get('/api/recipes', () => {});",
      "app.post('/api/recipes/legacy', () => {});",
    ]);
    // `queue.push` sends nothing here, so the route has no declared sender at
    // all and the dead fetch belongs to a boundary that registers elsewhere.
    const findings = analyze(project, { boundaries: [{ send: ['queue.push'], handle: ['queue.on'] }] });
    expect(findings.filter(f => f.kind === 'stranded')).toEqual([]);
  });

  it('matches a callee by its tail, so `app.get` covers `this.app.get`', () => {
    const project = restProject(CLIENT, [
      'class Server {',
      '  app = app;',
      '  routes(): void {',
      "    this.app.get('/api/recipes', () => {});",
      "    this.app.post('/api/recipes/legacy', () => {});",
      '  }',
      '}',
      'new Server().routes();',
    ]);
    const findings = analyze(project, { boundaries: REST });
    expect(findings.filter(f => f.kind === 'stranded').map(f => f.name)).toEqual(['/api/recipes/legacy']);
  });
});
