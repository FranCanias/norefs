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
        'interface RecipeIO {',
        '  id: string;',
        '  count: number;',
        '}',
        'interface LibraryFile {',
        '  recipes: RecipeIO[];',
        '  version: number;',
        '}',
        'declare const text: string;',
        'export const load = (): LibraryFile => JSON.parse(text) as LibraryFile;',
        'export const version = (f: LibraryFile) => f.version;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);

    expect(verdictOf(findings, 'recipes')?.verdict).toBe('contract');
    expect(verdictOf(findings, 'recipes')?.evidence).toContain('JSON.parse');

    // RecipeIO loses every member, so the cascade folds into one finding.
    const emptied = findings.find(f => f.kind === 'empty-type' && f.name === 'RecipeIO');
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
        'interface BoxRecipe {',
        '  ip: string;',
        '  label: string;',
        '}',
        'interface SavePayload {',
        '  recipe: BoxRecipe;',
        '  revision: number;',
        '}',
        'export async function load(): Promise<BoxRecipe[]> {',
        "  return (await api.invoke('recipeBox:list')) as BoxRecipe[];",
        '}',
        'export function save(payload: SavePayload): Promise<unknown> {',
        "  return api.invoke('recipeBox:save', payload);",
        '}',
        'export const show = (d: BoxRecipe) => d.label;',
        'export const recipe = (p: SavePayload) => p.recipe;',
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
        'export interface IOWithTags {',
        '  id?: string;',
        '  name?: string;',
        '  tags?: string[];',
        '  alias?: string;',
        '}',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/b.ts',
      [
        'export interface IOWithTags {',
        '  id: string;',
        '  tags?: string[];',
        '}',
        'export const pick = (v: IOWithTags) => v.id + (v.tags ?? []).length;',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/main.ts',
      [
        "import type { IOWithTags } from './a';",
        "import { pick } from './b';",
        'declare const io: IOWithTags;',
        "export const run = () => pick({ id: io.id ?? '', tags: io.tags }) + (io.alias ?? '');",
        '',
      ].join('\n')
    );
    const findings = analyze(project);

    const name = findings.find(f => f.kind === 'member' && f.name === 'name');
    expect(name?.verdict).toBe('shadowed');
    expect(name?.evidence).toContain('IOWithTags');
    expect(name?.evidence).toContain('b.ts');
  });

  it('merges contract and shadowed when the twin sits across the boundary', () => {
    // One wire format, declared once per process. The far side crosses a
    // project-declared bridge; the near side is its same-named drifted copy.
    // That is one conceptual fact, and both findings must tell it as one
    // contract instead of competing by precedence.
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
      '/electron.ts',
      [
        'interface RecipeIO {',
        '  ip: string;',
        '  mask: string;',
        '  gateway: string;',
        '}',
        'declare const io: RecipeIO;',
        "export const persist = () => api.invoke('recipeBox:save', io);",
        'export const gateway = () => io.gateway;',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/renderer.ts',
      [
        'interface RecipeIO {',
        '  ip: string;',
        '  mask: string;',
        '  label: string;',
        '}',
        'declare const local: RecipeIO;',
        'export const render = () => local.label;',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/index.ts',
      "import { persist, gateway } from './electron';\nimport { render } from './renderer';\npersist();\nrender();\ngateway();\n"
    );
    const findings = analyze(project);

    const nearSide = findings.find(f => f.kind === 'member' && f.name === 'ip' && f.filePath === '/renderer.ts');
    expect(nearSide?.verdict).toBe('contract');
    expect(nearSide?.evidence).toContain('far side');
    expect(nearSide?.evidence).toContain('electron.ts');

    const farSide = findings.find(f => f.kind === 'member' && f.name === 'ip' && f.filePath === '/electron.ts');
    expect(farSide?.verdict).toBe('contract');
    expect(farSide?.evidence).toContain('api.invoke');
    // The far side names its twin too: one fact, told from both ends.
    expect(farSide?.evidence).toContain('renderer.ts');
  });

  it('does not let a read structural twin mask a boundary twin', () => {
    // shared.ts holds a structurally identical, read copy; main.ts holds a
    // same-named drifted copy across the bridge. The cross-boundary link
    // must win, not whichever twin an iterator yields first.
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
      '/renderer.ts',
      [
        'interface Options {',
        '  alpha: string;',
        '  beta: string;',
        '  gamma: string;',
        '}',
        'declare const options: Options;',
        'export const render = () => options.gamma;',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/shared.ts',
      [
        'interface Options {',
        '  alpha: string;',
        '  beta: string;',
        '  gamma: string;',
        '}',
        'declare const shared: Options;',
        'export const use = () => [shared.alpha, shared.beta, shared.gamma];',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/main.ts',
      [
        'interface Options {',
        '  alpha: string;',
        '  beta: string;',
        '  wire: string;',
        '}',
        'declare const wireOptions: Options;',
        "export const persist = () => api.invoke('options:save', wireOptions);",
        'export const wire = () => wireOptions.wire;',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/index.ts',
      [
        "import { render } from './renderer';",
        "import { use } from './shared';",
        "import { persist, wire } from './main';",
        'render();',
        'use();',
        'persist();',
        'wire();',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const nearSide = findings.find(f => f.kind === 'member' && f.name === 'alpha' && f.filePath === '/renderer.ts');
    expect(nearSide?.verdict).toBe('contract');
    expect(nearSide?.evidence).toContain('main.ts');
  });

  it('spells out three write sites and counts the rest honestly', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface Config {',
        '  retries: number;',
        '  timeout: number;',
        '}',
        'export const read = (c: Config) => c.retries;',
        'declare function stash(payload: unknown): void;',
        'stash({ timeout: 1 });',
        'stash({ timeout: 2 });',
        'stash({ timeout: 3 });',
        'stash({ timeout: 4 });',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const member = findings.find(f => f.kind === 'member' && f.name === 'timeout');
    expect(member?.verdict).toBe('write-only');
    expect(member?.evidence).toMatch(/main\.ts:7, .*main\.ts:8, .*main\.ts:9 and 1 more site\b/);
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
