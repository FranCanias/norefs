import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';

describe('public API closure', () => {
  it('exempts declarations and members reached from an entry through export *', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    // main.ts is the entry; api.ts is public surface only through the star.
    project.createSourceFile('/main.ts', "export * from './api';\nimport './internal';\n");
    project.createSourceFile(
      '/api.ts',
      [
        'export interface Options {',
        '  retries: number;',
        '  timeout: number;',
        '}',
        'export function configure(o: Options): Options {',
        '  return o;',
        '}',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/internal.ts',
      [
        'interface Hidden {',
        '  kept: number;',
        '  dead: number;',
        '}',
        'export const read = (h: Hidden) => h.kept;',
        'void read;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);

    // Nothing in api.ts is reportable: its consumers live outside the program.
    expect(findings.filter(f => f.filePath === '/api.ts')).toEqual([]);
    // Internal code is still analyzed member-deep, and its needless export shows.
    expect(findings.map(f => [f.kind, f.name, f.verdict])).toEqual([
      ['member', 'dead', 'dead'],
      ['export', 'read', 'over-exported'],
    ]);
  });
  it('follows an exported alias to the arms it is made of', () => {
    // The entry re-exports the union by name; each arm is a local interface a
    // consumer holds one of. `--fix` used to empty the arm and call it
    // verified, because the type check it runs never held a consumer.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('/main.ts', "export type { ShelfEvent } from './shelf';\nimport './shelf';\n");
    project.createSourceFile(
      '/shelf.ts',
      [
        'interface RecipeAdded {',
        "  kind: 'added';",
        '  recipe: string;',
        '  shelf: number;',
        '}',
        'interface ShelfCleared {',
        "  kind: 'cleared';",
        '}',
        'export type ShelfEvent = RecipeAdded | ShelfCleared;',
        '',
      ].join('\n')
    );
    expect(analyze(project)).toEqual([]);
  });

  it('follows a public function to the shape it hands back', () => {
    // ts-pattern's shape: the entry exports `match`, and every method of the
    // chaining API lives on the interface its return type names. Nothing
    // imports that interface, and it is the whole reason the package exists.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('/main.ts', "export { measure } from './scale';\n");
    project.createSourceFile(
      '/scale.ts',
      [
        'interface Weighed {',
        '  grams(): number;',
        '  ounces(): number;',
        '}',
        'export function measure(): Weighed {',
        "  throw new Error('the scale is broken');",
        '}',
        '',
      ].join('\n')
    );
    expect(analyze(project)).toEqual([]);
  });

  it('still reports a shape only a private signature names', () => {
    // The control: nothing public reaches `Hidden`, so its members answer for
    // themselves.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('/main.ts', "export { grams } from './scale';\n");
    project.createSourceFile(
      '/scale.ts',
      [
        'interface Hidden {',
        '  kept: number;',
        '  dead: number;',
        '}',
        'declare const hidden: Hidden;',
        'export function grams(): number {',
        '  return hidden.kept;',
        '}',
        '',
      ].join('\n')
    );
    expect(analyze(project).map(f => [f.kind, f.name])).toEqual([['member', 'dead']]);
  });
});
