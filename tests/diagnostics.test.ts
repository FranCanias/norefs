import { describe, expect, it } from 'vitest';
import { findUnresolvedImports } from '../src/engine/diagnostics';
import { loadProject } from '../src/engine/project';
import { fixture } from './helpers';

describe('unresolved-import detection', () => {
  it('reports broken specifiers, ignores side-effect and ambient-declared imports', () => {
    const project = loadProject([fixture('broken-fixtures', 'tsconfig.json')]);
    expect(findUnresolvedImports(project)).toEqual(['./does-not-exist', 'not-installed-package']);
  });

  it('finds nothing in a healthy project', () => {
    const project = loadProject([fixture('fixtures', 'tsconfig.json')]);
    expect(findUnresolvedImports(project)).toEqual([]);
  });
});
