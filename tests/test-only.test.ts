import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import { isFixable } from '../src/engine/fix';

describe('test-only verdict', () => {
  it('flags an export whose only consumers are test files', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('/main.ts', 'export const keep = 1;\n');
    project.createSourceFile('/util.ts', 'export function helper(): number {\n  return 1;\n}\n');
    project.createSourceFile('/util.test.ts', "import { helper } from './util';\nvoid helper();\n");

    const findings = analyze(project);
    const helper = findings.find(f => f.name === 'helper');
    expect(helper?.kind).toBe('export');
    expect(helper?.verdict).toBe('test-only');
    expect(helper?.evidence).toContain('test files');
    // Never auto-fixable: deleting it means deleting its tests too.
    expect(isFixable(helper as NonNullable<typeof helper>, true)).toBe(false);
  });

  it('flags a member whose only references sit in test files', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('/main.ts', "import { width } from './geo';\nvoid width;\n");
    project.createSourceFile(
      '/geo.ts',
      [
        'export interface Size {',
        '  w: number;',
        '  h: number;',
        '}',
        'export const width = (s: Size) => s.w;',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/geo.test.ts',
      ["import type { Size } from './geo';", 'const s: Size = { w: 1, h: 2 };', 'void s;', ''].join('\n')
    );

    const findings = analyze(project);
    const h = findings.find(f => f.kind === 'member' && f.name === 'h');
    expect(h?.verdict).toBe('test-only');
  });

  it('stays quiet when a fixture in the harness serves only the harness', () => {
    // A helper under tests/ whose callers are tests is what a helper under
    // tests/ is for. The verdict is for shipping code the tests alone keep
    // alive, and saying it of the harness itself says nothing at all.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('/main.ts', 'export const keep = 1;\n');
    project.createSourceFile('/tests/fixture.ts', 'export function pantry(): number {\n  return 1;\n}\n');
    project.createSourceFile('/tests/box.test.ts', "import { pantry } from './fixture';\nvoid pantry();\n");

    const findings = analyze(project, { rootDirs: ['/'] });
    expect(findings.find(f => f.name === 'pantry')).toBeUndefined();
  });

  it('knows a harness directory by its shape, not by a list of words', () => {
    // Projects name them `tests`, `type-tests`, `js-tests`. All three are the
    // harness; `latest` is not, and only a separator tells them apart.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('/main.ts', 'export const keep = 1;\n');
    project.createSourceFile('/js-tests/fixture.ts', 'export function pantry(): number {\n  return 1;\n}\n');
    project.createSourceFile('/js-tests/box.test.ts', "import { pantry } from './fixture';\nvoid pantry();\n");
    project.createSourceFile('/latest/recipe.ts', 'export function shelf(): number {\n  return 1;\n}\n');
    project.createSourceFile('/latest/box.test.ts', "import { shelf } from './recipe';\nvoid shelf();\n");

    const findings = analyze(project, { rootDirs: ['/'] });
    expect(findings.find(f => f.name === 'pantry')).toBeUndefined();
    expect(findings.find(f => f.name === 'shelf')?.verdict).toBe('test-only');
  });

  it('stays quiet when production code uses the export in its own file', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('/main.ts', 'export const keep = 1;\n');
    project.createSourceFile('/util.ts', 'export function helper(): number {\n  return 1;\n}\nvoid helper();\n');
    project.createSourceFile('/util.test.ts', "import { helper } from './util';\nvoid helper();\n");

    const findings = analyze(project);
    expect(findings.find(f => f.name === 'helper')).toBeUndefined();
  });
});
