import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import { loadProject } from '../src/engine/project';

const pkgA = path.resolve('tests/monorepo-fixtures/pkg-a');
const pkgB = path.resolve('tests/monorepo-fixtures/pkg-b');

describe('monorepo support', () => {
  it('loads several tsconfigs into one project and resolves cross-package usage', () => {
    const project = loadProject([path.join(pkgA, 'tsconfig.json'), path.join(pkgB, 'tsconfig.json')]);
    const findings = analyze(project, { rootDirs: [pkgA, pkgB] });
    // pkg-a/src/index.ts is an entry by convention; it uses pkg-b's lib.
    // Only the two orphans are unused.
    expect(findings.map(f => [f.kind, f.name])).toEqual([
      ['file', 'orphan-a.ts'],
      ['file', 'orphan-b.ts'],
    ]);
  });

  it('reports cross-package usage as missing when only one tsconfig is loaded', () => {
    const project = loadProject([path.join(pkgB, 'tsconfig.json')]);
    const findings = analyze(project, { rootDirs: [pkgB] });
    // Without pkg-a in the project, nothing reaches lib.ts.
    expect(findings.some(f => f.kind === 'file' && f.name === 'lib.ts')).toBe(true);
  });
});
