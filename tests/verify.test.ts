import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { errorInventory, newErrors, snapshotTexts } from '../src/engine/verify';

describe('fix verification', () => {
  it('reports only errors that were not there before', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    // One pre-existing error the fixes must not be blamed for.
    const file = project.createSourceFile('/main.ts', 'export const broken: number = "text";\nexport const n = 1;\n');
    const before = errorInventory(project);
    expect(before.size).toBeGreaterThan(0);

    // The same project again: nothing new.
    expect(newErrors(before, project, '/')).toEqual([]);

    // A bad edit introduces a fresh error; the pre-existing one stays covered.
    file.replaceWithText('export const broken: number = "text";\nexport const n: string = 2;\n');
    const fresh = newErrors(before, project, '/');
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toContain('main.ts:2');
    expect(fresh[0]).toContain('TS2322');
  });

  it('does not mistake a moved pre-existing error for a new one', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const file = project.createSourceFile('/main.ts', 'export const broken: number = "text";\n');
    const before = errorInventory(project);

    // Lines shift, the error stays the same error.
    file.replaceWithText('// a comment pushed everything down\n\nexport const broken: number = "text";\n');
    expect(newErrors(before, project, '/')).toEqual([]);
  });

  it('snapshots every file text for the revert', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('/a.ts', 'export const a = 1;\n');
    project.createSourceFile('/b.ts', 'export const b = 2;\n');
    const texts = snapshotTexts(project);
    expect(texts.get('/a.ts')).toBe('export const a = 1;\n');
    expect(texts.get('/b.ts')).toBe('export const b = 2;\n');
  });
});
