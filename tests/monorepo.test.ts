import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import { findUnresolvedImports } from '../src/engine/diagnostics';
import { loadPackages, loadProject } from '../src/engine/project';
import { fixture } from './helpers';

const pkgA = fixture('monorepo-fixtures', 'pkg-a');
const pkgB = fixture('monorepo-fixtures', 'pkg-b');

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

describe('per-package compiler options', () => {
  // Both packages alias `~/*` to their own src/, so first-tsconfig-wins
  // resolution would leave pkg-b's imports dangling. pkg-b also names its
  // entry through package.json main + its own outDir, so lib.ts's otherwise
  // unused export `alone` counts as public API.
  const pathsPkgA = fixture('monorepo-paths-fixtures', 'pkg-a');
  const pathsPkgB = fixture('monorepo-paths-fixtures', 'pkg-b');
  const tsConfigs = [path.join(pathsPkgA, 'tsconfig.json'), path.join(pathsPkgB, 'tsconfig.json')];

  it('resolves each package with its own paths and maps entries through its own outDir', () => {
    const project = loadProject(tsConfigs);
    expect(findUnresolvedImports(project)).toEqual([]);
    const findings = analyze(project, { rootDirs: [pathsPkgA, pathsPkgB], packages: loadPackages(tsConfigs) });
    expect(findings).toEqual([]);
  });

  it('does not depend on the order of the tsconfigs', () => {
    const reversed = [...tsConfigs].reverse();
    const project = loadProject(reversed);
    expect(findUnresolvedImports(project)).toEqual([]);
    const findings = analyze(project, { rootDirs: [pathsPkgB, pathsPkgA], packages: loadPackages(reversed) });
    expect(findings).toEqual([]);
  });
});
