import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ReadOnlyFileSystem } from '../src/engine/file-system';
import { findWorkspace } from '../src/engine/workspaces';
import { fixture } from './helpers';

/** A repository as a flat map of paths to contents. Directories are implied. */
function repo(files: Record<string, string>): ReadOnlyFileSystem {
  return {
    readFile: filePath => files[filePath],
    readDir(dirPath) {
      const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
      const names = new Set<string>();
      const out: Array<{ path: string; isDirectory: boolean; isSymlink: boolean }> = [];
      for (const filePath of Object.keys(files)) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        const slash = rest.indexOf('/');
        const name = slash === -1 ? rest : rest.slice(0, slash);
        if (names.has(name)) continue;
        names.add(name);
        out.push({ path: prefix + name, isDirectory: slash !== -1, isSymlink: false });
      }
      return out;
    },
  };
}

const TSCONFIG = '{"include":["src"]}';

function found(files: Record<string, string>) {
  const workspace = findWorkspace('/repo', repo(files));
  return {
    source: workspace?.source,
    packages: workspace?.tsConfigPaths.map(p => path.relative('/repo', p)),
    skipped: workspace?.withoutTsConfig,
  };
}

describe('the packages a workspace declares', () => {
  it('reads a pnpm-workspace.yaml block sequence, with its comments and its neighbours', () => {
    // The comment, the negation, the bare scalar, and a key after the list —
    // every one of them appears in a real pnpm-workspace.yaml.
    const result = found({
      '/repo/pnpm-workspace.yaml': [
        'packages:',
        "  - 'apps/*'",
        "  - 'packages/*'   # everything we publish",
        "  - '!packages/legacy'",
        '  - tools/build',
        '',
        'onlyBuiltDependencies:',
        '  - esbuild',
        '',
      ].join('\n'),
      '/repo/apps/web/package.json': '{}',
      '/repo/apps/web/tsconfig.json': TSCONFIG,
      '/repo/packages/core/package.json': '{}',
      '/repo/packages/core/tsconfig.json': TSCONFIG,
      '/repo/packages/legacy/package.json': '{}',
      '/repo/packages/legacy/tsconfig.json': TSCONFIG,
      '/repo/tools/build/package.json': '{}',
      '/repo/tools/build/tsconfig.json': TSCONFIG,
      '/repo/tools/scratch/package.json': '{}',
    });
    expect(result.source).toBe('pnpm-workspace.yaml');
    expect(result.packages).toEqual([
      'apps/web/tsconfig.json',
      'packages/core/tsconfig.json',
      'tools/build/tsconfig.json',
    ]);
    // `!packages/legacy` is excluded, and `tools/scratch` was never declared.
    expect(result.skipped).toEqual([]);
  });

  it('reads a flow sequence written on the key itself', () => {
    const result = found({
      '/repo/pnpm-workspace.yaml': 'packages: [\'apps/*\', "packages/*"]\n',
      '/repo/apps/web/package.json': '{}',
      '/repo/apps/web/tsconfig.json': TSCONFIG,
      '/repo/packages/core/package.json': '{}',
      '/repo/packages/core/tsconfig.json': TSCONFIG,
    });
    expect(result.packages).toEqual(['apps/web/tsconfig.json', 'packages/core/tsconfig.json']);
  });

  it('reads npm workspaces, as a list and as an object', () => {
    const files = {
      '/repo/apps/web/package.json': '{}',
      '/repo/apps/web/tsconfig.json': TSCONFIG,
    };
    expect(found({ ...files, '/repo/package.json': '{"workspaces":["apps/*"]}' })).toMatchObject({
      source: 'package.json workspaces',
      packages: ['apps/web/tsconfig.json'],
    });
    expect(found({ ...files, '/repo/package.json': '{"workspaces":{"packages":["apps/*"]}}' })).toMatchObject({
      packages: ['apps/web/tsconfig.json'],
    });
  });

  it('names the declared packages that hold no tsconfig, instead of dropping them quietly', () => {
    // Nothing analyzes them. A run that silently covers less than the workspace
    // is a run whose findings mean less than they look like they mean.
    const result = found({
      '/repo/package.json': '{"workspaces":["packages/*"]}',
      '/repo/packages/core/package.json': '{}',
      '/repo/packages/core/tsconfig.json': TSCONFIG,
      '/repo/packages/jsonly/package.json': '{}',
    });
    expect(result.packages).toEqual(['packages/core/tsconfig.json']);
    expect(result.skipped).toEqual(['packages/jsonly']);
  });

  it('offers the root itself when the declaration names it', () => {
    // valtio's shape: `.` beside `website`. The root is the library the reader
    // came for, and a walk that only offered the directories under the root
    // analyzed the website alone.
    const result = found({
      '/repo/pnpm-workspace.yaml': 'packages:\n  - .\n  - website\n',
      '/repo/package.json': '{"name":"pantry"}',
      '/repo/tsconfig.json': TSCONFIG,
      '/repo/website/package.json': '{}',
      '/repo/website/tsconfig.json': TSCONFIG,
    });
    expect(result.packages).toEqual(['tsconfig.json', 'website/tsconfig.json']);
    expect(result.skipped).toEqual([]);
  });

  it('finds nothing when no workspace is declared', () => {
    expect(findWorkspace('/repo', repo({ '/repo/package.json': '{"name":"solo"}' }))).toBeUndefined();
    expect(findWorkspace('/repo', repo({}))).toBeUndefined();
  });

  it('finds nothing when the declaration matches no package directory', () => {
    // A glob that lands on nothing is dropped, the same rule the entry points
    // follow. There is no way for this to invent a project.
    expect(findWorkspace('/repo', repo({ '/repo/package.json': '{"workspaces":["packages/*"]}' }))).toBeUndefined();
  });

  it('never descends into node_modules or a package it already found', () => {
    const result = found({
      '/repo/package.json': '{"workspaces":["**"]}',
      '/repo/node_modules/dep/package.json': '{}',
      '/repo/node_modules/dep/tsconfig.json': TSCONFIG,
      '/repo/apps/web/package.json': '{}',
      '/repo/apps/web/tsconfig.json': TSCONFIG,
      // A vendored copy inside a package: the walk stops at apps/web.
      '/repo/apps/web/vendor/inner/package.json': '{}',
      '/repo/apps/web/vendor/inner/tsconfig.json': TSCONFIG,
    });
    expect(result.packages).toEqual(['apps/web/tsconfig.json']);
  });
});

describe('a real monorepo on disk', () => {
  it('turns the declaration into the projects a run analyzes', () => {
    const dir = fixture('workspace-fixtures');
    const workspace = findWorkspace(dir);
    expect(workspace?.source).toBe('pnpm-workspace.yaml');
    expect(workspace?.tsConfigPaths.map(p => path.relative(dir, p))).toEqual([
      'apps/web/tsconfig.json',
      'packages/core/tsconfig.json',
    ]);
    expect(workspace?.withoutTsConfig).toEqual(['tools/jsonly']);
  });
});
