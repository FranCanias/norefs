import type { ts } from 'ts-morph';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import type { Finding } from '../src/types';

function depFindings(
  manifest: object,
  files: Record<string, string>,
  ignoreDependencies: string[] = [],
  compilerOptions: ts.CompilerOptions = {}
): Finding[] {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions });
  project.getFileSystem().writeFileSync('/package.json', JSON.stringify(manifest, null, 2));
  for (const [filePath, text] of Object.entries(files)) project.createSourceFile(filePath, text);
  return analyze(project, { rootDirs: ['/'], ignoreDependencies }).filter(
    f => f.kind === 'dependency' || f.kind === 'unlisted'
  );
}

describe('dependency checks', () => {
  it('reports a dependency nothing imports, at its line in package.json', () => {
    const findings = depFindings(
      { dependencies: { 'used-pkg': '1.0.0', 'dead-pkg': '1.0.0' } },
      { '/main.ts': "import { x } from 'used-pkg';\nexport const y = x;\n" }
    );
    expect(findings.map(f => [f.kind, f.name])).toEqual([['dependency', 'dead-pkg']]);
    expect(findings[0].filePath).toBe('/package.json');
    expect(findings[0].line).toBe(4);
  });

  it('counts deep imports and dynamic imports as usage', () => {
    const findings = depFindings(
      { dependencies: { 'used-pkg': '1.0.0', lazy: '1.0.0' } },
      {
        '/main.ts':
          "import { x } from 'used-pkg/sub/path';\nexport const load = () => import('lazy');\nexport const y = x;\n",
      }
    );
    expect(findings).toEqual([]);
  });

  it('reports an unlisted package at its first import site', () => {
    const findings = depFindings(
      { dependencies: {} },
      { '/main.ts': "import { x } from 'not-listed';\nexport const y = x;\n" }
    );
    expect(findings.map(f => [f.kind, f.name])).toEqual([['unlisted', 'not-listed']]);
    expect(findings[0].filePath).toBe('/main.ts');
  });

  it('never reports devDependencies unused, but they satisfy the unlisted check', () => {
    const findings = depFindings(
      { devDependencies: { toolpkg: '1.0.0' } },
      { '/main.ts': "import { x } from 'toolpkg';\nexport const y = x;\nexport const z = 1;\n" }
    );
    expect(findings).toEqual([]);
  });

  it('skips @types packages and lets them satisfy their base package', () => {
    const findings = depFindings(
      { dependencies: { '@types/react': '1.0.0' } },
      { '/main.ts': "import { x } from 'react';\nexport const y = x;\n" }
    );
    expect(findings).toEqual([]);
  });

  it('ignores node builtins and relative imports', () => {
    const findings = depFindings(
      { dependencies: {} },
      {
        '/main.ts':
          "import fs from 'node:fs';\nimport path from 'path';\nimport { z } from './lib';\nexport const y = [fs, path, z];\n",
        '/lib.ts': 'export const z = 1;\n',
      }
    );
    expect(findings).toEqual([]);
  });

  it('honors ignoreDependencies globs', () => {
    const findings = depFindings(
      { dependencies: { 'legacy-thing': '1.0.0' } },
      { '/main.ts': 'export const y = 1;\n' },
      ['legacy-*']
    );
    expect(findings).toEqual([]);
  });

  it('never mistakes a path alias for a scoped package, query suffix or not', () => {
    const findings = depFindings(
      { dependencies: {} },
      { '/main.ts': "import Icon from '@/assets/icons/Attention.svg?react';\nexport const y = Icon;\n" }
    );
    expect(findings).toEqual([]);
  });

  it('treats a specifier matching a tsconfig paths pattern as project code', () => {
    const findings = depFindings(
      { dependencies: {} },
      { '/main.ts': "import logo from 'assets/logo.svg?url';\nexport const y = logo;\n" },
      [],
      { paths: { 'assets/*': ['./src/assets/*'] } }
    );
    expect(findings).toEqual([]);
  });

  it('ignores Node subpath imports and strips query suffixes from real packages', () => {
    const findings = depFindings(
      { dependencies: {} },
      {
        '/main.ts': "import { a } from '#internal/util';\nimport raw from 'somepkg?raw';\nexport const y = [a, raw];\n",
      }
    );
    expect(findings.map(f => [f.kind, f.name])).toEqual([['unlisted', 'somepkg']]);
  });

  it('honors a norefs-ignore comment on an unlisted import line', () => {
    const findings = depFindings(
      { dependencies: {} },
      { '/main.ts': "import { x } from 'mystery'; // norefs-ignore: injected at runtime\nexport const y = x;\n" }
    );
    expect(findings).toEqual([]);
  });

  it('honors the block form on an import too, so both pipelines agree', () => {
    // An import has nothing nested inside it, so the block mark reaches the
    // same one line the syntax-only scanner gives it.
    const findings = depFindings(
      { dependencies: {} },
      { '/main.ts': "// norefs-ignore-block: injected at runtime\nimport { x } from 'mystery';\nexport const y = x;\n" }
    );
    expect(findings).toEqual([]);
  });
});
