import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import { applyFixes } from '../src/engine/fix';

function fix(source: string): string {
  const project = new Project({ useInMemoryFileSystem: true });
  const file = project.createSourceFile('/main.ts', source);
  applyFixes(analyze(project));
  return file.getFullText();
}

describe('applyFixes', () => {
  it('removes an unused interface property', () => {
    const text = fix(
      [
        'interface User {',
        '  name: string;',
        '  legacyId: number;',
        '}',
        'export function greet(u: User): string {',
        '  return u.name;',
        '}',
        '',
      ].join('\n')
    );
    expect(text).not.toContain('legacyId');
    expect(text).toContain('name: string;');
  });

  it('removes an unused enum member', () => {
    const text = fix(
      [
        'enum Status {',
        "  Active = 'active',",
        "  Dead = 'dead-value',",
        '}',
        'export function isActive(s: Status): boolean {',
        '  return s === Status.Active;',
        '}',
        '',
      ].join('\n')
    );
    expect(text).not.toContain('Dead');
    expect(text).toContain("Active = 'active'");
  });

  it('removes unused class members', () => {
    const text = fix(
      [
        'class Greeter {',
        "  greeting = 'hi';",
        '  deadProp = 0;',
        '',
        '  greet(): string {',
        '    return this.greeting;',
        '  }',
        '',
        '  deadMethod(): void {}',
        '}',
        'new Greeter().greet();',
        '',
      ].join('\n')
    );
    expect(text).not.toContain('deadProp');
    expect(text).not.toContain('deadMethod');
    expect(text).toContain('greet(): string');
  });

  it('demotes an unused parameter property to a plain parameter', () => {
    const text = fix(
      [
        'class Service {',
        '  constructor(',
        '    private readonly db: string,',
        '    private readonly deadDep: number',
        '  ) {}',
        '',
        '  query(): string {',
        '    return this.db;',
        '  }',
        '}',
        "new Service('d', 1).query();",
        '',
      ].join('\n')
    );
    expect(text).toContain('deadDep: number');
    expect(text).not.toContain('readonly deadDep');
    expect(text).not.toContain('private readonly deadDep');
    expect(text).toContain('private readonly db: string');
    expect(text).toContain("new Service('d', 1)");
  });

  it('saves the touched files and returns their paths', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('/main.ts', 'interface A { dead: number }\n');
    const result = applyFixes(analyze(project));
    expect(result.filePaths).toEqual(['/main.ts']);
    expect(project.getFileSystem().readFileSync('/main.ts')).not.toContain('dead');
  });

  it('removes only the export keyword when the declaration is still used in its file', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('/main.ts', "import { used } from './lib';\nused();\n");
    const lib = project.createSourceFile(
      '/lib.ts',
      [
        'export function used(): number {',
        '  return local();',
        '}',
        'export function local(): number {',
        '  return 1;',
        '}',
        '',
      ].join('\n')
    );
    applyFixes(analyze(project));
    expect(lib.getFullText()).toContain('function local');
    expect(lib.getFullText()).not.toContain('export function local');
    expect(lib.getFullText()).toContain('export function used');
  });

  it('removes a declaration with zero references whole, including its export specifier', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('/main.ts', "import { used } from './lib';\nused();\n");
    const lib = project.createSourceFile(
      '/lib.ts',
      ['export function used(): void {}', 'function dead(): void {}', 'export { dead };', ''].join('\n')
    );
    applyFixes(analyze(project));
    expect(lib.getFullText()).not.toContain('dead');
    expect(lib.getFullText()).toContain('export function used');
  });

  it('removes barrel re-exports and unused imports of a removed export', () => {
    const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { noUnusedLocals: true } });
    project.createSourceFile('/main.ts', "import { used } from './barrel';\nused();\n");
    const barrel = project.createSourceFile('/barrel.ts', "export { used, dead } from './lib';\n");
    const lib = project.createSourceFile(
      '/lib.ts',
      [
        "import { helper } from './helper';",
        'export function used(): number {',
        '  return 1;',
        '}',
        'export function dead(): number {',
        '  return helper();',
        '}',
        '',
      ].join('\n')
    );
    project.createSourceFile('/helper.ts', 'export function helper(): number {\n  return 2;\n}\n');
    applyFixes(analyze(project));
    expect(lib.getFullText()).not.toContain('dead');
    expect(barrel.getFullText()).toBe("export { used } from './lib';\n");
    // The import only the removed function used is cleaned up too.
    expect(lib.getFullText()).not.toContain('helper');
  });

  it('removes local declarations orphaned by a removed export', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('/main.ts', "import { used } from './lib';\nused();\n");
    const lib = project.createSourceFile(
      '/lib.ts',
      [
        'const SPACING = 8;',
        'function layout(): number {',
        '  return SPACING;',
        '}',
        'export function dead(): number {',
        '  return layout();',
        '}',
        'export function used(): number {',
        '  return 1;',
        '}',
        '',
      ].join('\n')
    );
    applyFixes(analyze(project));
    expect(lib.getFullText()).not.toContain('dead');
    expect(lib.getFullText()).not.toContain('layout');
    expect(lib.getFullText()).not.toContain('SPACING');
    expect(lib.getFullText()).toContain('export function used');
  });

  it('mutates only the in-memory project when save is false', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const file = project.createSourceFile('/main.ts', 'interface A { dead: number }\n');
    file.saveSync();
    const result = applyFixes(analyze(project), { save: false });
    expect(result.fixed).toBe(1);
    expect(file.getFullText()).not.toContain('dead');
    expect(project.getFileSystem().readFileSync('/main.ts')).toContain('dead');
  });

  it('fixes dead members but holds write-only ones for --fix-unsafe', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const file = project.createSourceFile(
      '/main.ts',
      [
        'interface Config {',
        '  retries: number;',
        '  timeout: number;',
        '}',
        'export const read = (c: Config) => c.retries;',
        'declare function stash(payload: unknown): void;',
        'stash({ timeout: 250 });',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const timeout = findings.find(f => f.kind === 'member' && f.name === 'timeout');
    expect(timeout?.verdict).toBe('write-only');
    const result = applyFixes(findings);
    expect(result.fixed).toBe(0);
    expect(file.getFullText()).toContain('timeout');
    applyFixes(findings, { unsafe: true });
    expect(file.getFullText()).not.toContain('timeout: number');
  });

  it('reports unused files as skipped instead of deleting them', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('/main.ts', 'export const keep = 1;\n');
    project.createSourceFile('/orphan.ts', 'export const gone = 1;\n');
    const result = applyFixes(analyze(project));
    expect(result.skipped).toBe(1);
    expect(project.getSourceFile('/orphan.ts')).toBeDefined();
  });
});
