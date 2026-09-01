import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import { applyFixes, isFixable } from '../src/engine/fix';
import type { Finding } from '../src/types';
import { analyzeFiles } from './helpers';

function named(findings: Finding[]): string[] {
  return findings.map(f => `${f.kind} ${f.name}`).sort();
}

describe("a project's own declaration file", () => {
  it('reports the exported types nothing imports', () => {
    const findings = analyzeFiles({
      '/box.d.ts': [
        'export interface Card {',
        '  title: string;',
        '  deadNote: string;',
        '}',
        'export interface DeadShelf {',
        '  slots: number;',
        '}',
        'export type Slot = number;',
        '',
      ].join('\n'),
      '/main.ts': "import type { Card } from './box';\nexport const title = (c: Card): string => c.title;\n",
    });
    // The members answer for themselves too: a `.d.ts` is source.
    expect(named(findings)).toEqual(['member deadNote', 'type DeadShelf', 'type Slot']);
  });

  it('says nothing about a type its importers read', () => {
    const findings = analyzeFiles({
      '/box.d.ts': 'export interface Card {\n  title: string;\n}\n',
      '/main.ts': "import type { Card } from './box';\nexport const title = (c: Card): string => c.title;\n",
    });
    expect(named(findings)).toEqual([]);
  });

  it('never claims a declaration is over-exported', () => {
    // The `export` keyword is what makes the file a module rather than a
    // script of globals. Dropping it moves every declaration beside it into
    // the global scope, and the augmentation below stops compiling.
    const findings = analyzeFiles({
      '/bridge.d.ts': [
        'export interface Bridge {',
        '  open(path: string): void;',
        '}',
        'declare global {',
        '  interface RecipeGlobals {',
        '    bridge: Bridge;',
        '  }',
        '}',
        '',
      ].join('\n'),
      '/main.ts': "import './bridge';\nexport const open = (g: RecipeGlobals, p: string): void => g.bridge.open(p);\n",
    });
    expect(named(findings)).toEqual([]);
  });

  it('keeps a member a heritage clause written there requires', () => {
    // `interface Tin extends Card` forces Tin to stay assignable to Card, so
    // the override is load-bearing whatever its reference count — and a
    // declaration file is one of the places that clause can be written.
    const findings = analyzeFiles({
      '/card.ts': 'export interface Card {\n  title: string;\n}\n',
      '/tin.d.ts': [
        "import type { Card } from './card';",
        'export interface Tin extends Card {',
        '  title: string;',
        '}',
        '',
      ].join('\n'),
      '/main.ts': "import type { Tin } from './tin';\nexport const hold = (t: Tin): Tin => t;\n",
    });
    expect(named(findings)).toEqual([]);
  });

  it('is reported and never fixed', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const box = project.createSourceFile('/box.d.ts', 'export interface DeadShelf {\n  slots: number;\n}\n');
    project.createSourceFile('/main.ts', 'export const shelves = 4;\n');
    const findings = analyze(project);

    expect(findings.some(f => f.name === 'DeadShelf')).toBe(true);
    for (const finding of findings) {
      expect(isFixable(finding, true), finding.name).toBe(false);
    }
    applyFixes(findings);
    expect(box.getFullText()).toBe('export interface DeadShelf {\n  slots: number;\n}\n');
  });

  it('shadows a member its twin beside it reads', () => {
    // A shape declared twice is one shape as far as reads go, and the twin
    // that reads it can live in a declaration file like anywhere else.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/shared.d.ts',
      ['export interface EdgeData {', '  label: string;', '  color: string;', '  zone: string;', '}', ''].join('\n')
    );
    project.createSourceFile(
      '/main.ts',
      [
        "import type { EdgeData } from './shared';",
        'export const tag = (e: EdgeData): string => e.label;',
        'interface LocalEdgeData {',
        '  label: string;',
        '  color: string;',
        '  zone: string;',
        '}',
        'declare const data: unknown;',
        'const local = data as LocalEdgeData;',
        'export const run = (): string => tag(local) + local.color + local.zone;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);

    const color = findings.find(f => f.kind === 'member' && f.name === 'color' && f.filePath.endsWith('/shared.d.ts'));
    expect(color?.verdict).toBe('shadowed');
  });
});
