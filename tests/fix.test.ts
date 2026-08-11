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
        'export interface User {',
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
        'export enum Status {',
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
        'export class Greeter {',
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
        'export class Service {',
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
    project.createSourceFile('/main.ts', 'export interface A { dead: number }\n');
    const files = applyFixes(analyze(project));
    expect(files).toEqual(['/main.ts']);
    expect(project.getFileSystem().readFileSync('/main.ts')).not.toContain('dead');
  });
});
