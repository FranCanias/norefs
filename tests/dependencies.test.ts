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

  it('an imported devDependency is used, and satisfies the unlisted check', () => {
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

/** A project whose installed packages declare their own binaries. */
function installed(manifest: object, files: Record<string, string>, packages: Record<string, object> = {}): Finding[] {
  const project = new Project({ useInMemoryFileSystem: true });
  const fileSystem = project.getFileSystem();
  fileSystem.writeFileSync('/package.json', JSON.stringify(manifest, null, 2));
  for (const [name, data] of Object.entries(packages)) {
    fileSystem.writeFileSync(`/node_modules/${name}/package.json`, JSON.stringify(data));
  }
  for (const [filePath, text] of Object.entries(files)) project.createSourceFile(filePath, text);
  return analyze(project, { rootDirs: ['/'] }).filter(f => f.kind === 'dependency' || f.kind === 'misplaced');
}

describe('what a script says a package is for', () => {
  it('a binary named in a script is that package being used', () => {
    // `tsc` is typescript. No import says so, and the script always did.
    const findings = installed(
      {
        scripts: { build: 'tsc -p tsconfig.json', lint: 'biome lint .' },
        devDependencies: { typescript: '5.0.0', '@biomejs/biome': '2.0.0', unused: '1.0.0' },
      },
      { '/main.ts': 'export const x = 1;\n' },
      {
        typescript: { name: 'typescript', bin: { tsc: './bin/tsc', tsserver: './bin/tsserver' } },
        '@biomejs/biome': { name: '@biomejs/biome', bin: { biome: './bin/biome' } },
        unused: { name: 'unused' },
      }
    );
    expect(findings.map(f => [f.kind, f.name])).toEqual([['dependency', 'unused']]);
  });

  it('a scoped package with a string bin is run by the tail of its name', () => {
    // `bin: "./bin/prettier"` publishes the command under the unscoped name.
    const findings = installed(
      { scripts: { fmt: 'prettier --write .' }, devDependencies: { '@scope/prettier': '1.0.0' } },
      { '/main.ts': 'export const x = 1;\n' },
      { '@scope/prettier': { name: '@scope/prettier', bin: './bin/prettier' } }
    );
    expect(findings).toEqual([]);
  });

  it('will not read a bare token as a scoped package that declares no such binary', () => {
    // `npm run build` is a script calling a script. Reading `build` as the tail
    // of `@acme/build` would silence a real finding on a name collision.
    const findings = installed(
      { scripts: { ci: 'npm run build', build: 'echo built' }, devDependencies: { '@acme/build': '1.0.0' } },
      { '/main.ts': 'export const x = 1;\n' },
      { '@acme/build': { name: '@acme/build' } }
    );
    expect(findings.map(f => [f.kind, f.name])).toEqual([['dependency', '@acme/build']]);
  });

  it('will not call a devDependency unused when the package is not installed', () => {
    // Its binaries live in its own manifest. Without one there is nothing to
    // read, so the claim has no evidence and norefs does not make it.
    const findings = installed({ devDependencies: { mystery: '1.0.0' } }, { '/main.ts': 'export const x = 1;\n' });
    expect(findings).toEqual([]);
    // Installed, with no binary and no import, it is reported.
    expect(
      installed(
        { devDependencies: { mystery: '1.0.0' } },
        { '/main.ts': 'export const x = 1;\n' },
        {
          mystery: { name: 'mystery' },
        }
      ).map(f => f.name)
    ).toEqual(['mystery']);
  });
});

describe('a dependency in the wrong section', () => {
  it('names a devDependency that production code imports', () => {
    // The one that ships broken: `npm install --omit=dev` and it is gone.
    const findings = installed(
      { devDependencies: { runtime: '1.0.0' } },
      { '/main.ts': "import 'runtime';\nexport const x = 1;\n" },
      { runtime: { name: 'runtime' } }
    );
    expect(findings.map(f => [f.kind, f.name, f.context])).toEqual([['misplaced', 'runtime', 'devDependencies']]);
    expect(findings[0].evidence).toContain('production code imports it');
  });

  it('names a dependency that only the harness imports', () => {
    const findings = installed(
      { dependencies: { fixtures: '1.0.0' } },
      { '/main.ts': 'export const x = 1;\n', '/main.test.ts': "import 'fixtures';\nexport const t = 1;\n" },
      { fixtures: { name: 'fixtures' } }
    );
    expect(findings.map(f => [f.kind, f.name, f.context])).toEqual([['misplaced', 'fixtures', 'dependencies']]);
    expect(findings[0].evidence).toContain('ships for nothing');
  });

  it('leaves a devDependency that production code reads for types alone', () => {
    // `import type` is erased at compile time. Moving it into `dependencies`
    // would ship a package the build output never loads.
    const findings = installed(
      { devDependencies: { shapes: '1.0.0' } },
      { '/main.ts': "import type { Recipe } from 'shapes';\nexport const x = (r: Recipe): Recipe => r;\n" },
      { shapes: { name: 'shapes' } }
    );
    expect(findings).toEqual([]);
  });

  it('reads inline type bindings the same way, and a value binding beside them differently', () => {
    const erased = installed(
      { devDependencies: { shapes: '1.0.0' } },
      { '/main.ts': "import { type Recipe } from 'shapes';\nexport const x = (r: Recipe): Recipe => r;\n" },
      { shapes: { name: 'shapes' } }
    );
    expect(erased).toEqual([]);

    // One value in the braces and the import survives the compile.
    const kept = installed(
      { devDependencies: { shapes: '1.0.0' } },
      { '/main.ts': "import { type Recipe, load } from 'shapes';\nexport const x = (): Recipe => load();\n" },
      { shapes: { name: 'shapes' } }
    );
    expect(kept.map(f => [f.kind, f.name])).toEqual([['misplaced', 'shapes']]);
  });

  it('still counts a type import as the package being used at all', () => {
    // Erased at run time, but far from unused: deleting the entry breaks the
    // compile. Only the section question turns on how it is imported.
    const findings = installed(
      { devDependencies: { shapes: '1.0.0' } },
      { '/main.test.ts': "import type { Recipe } from 'shapes';\nexport const t = (r: Recipe): Recipe => r;\n" },
      { shapes: { name: 'shapes' } }
    );
    expect(findings).toEqual([]);
  });

  it('says nothing when both sections match how the package is used', () => {
    const findings = installed(
      { dependencies: { runtime: '1.0.0' }, devDependencies: { harness: '1.0.0' } },
      {
        '/main.ts': "import 'runtime';\nexport const x = 1;\n",
        '/main.test.ts': "import 'harness';\nexport const t = 1;\n",
      },
      { runtime: { name: 'runtime' }, harness: { name: 'harness' } }
    );
    expect(findings).toEqual([]);
  });

  it('points at the section it is talking about, not at the script that runs it', () => {
    const manifest = { scripts: { check: 'nothing' }, devDependencies: { nothing: '1.0.0' } };
    const findings = installed(
      manifest,
      { '/main.ts': "import 'nothing';\nexport const x = 1;\n" },
      {
        nothing: { name: 'nothing' },
      }
    );
    const text = JSON.stringify(manifest, null, 2).split('\n');
    expect(text[findings[0].line - 1]).toContain('"nothing": "1.0.0"');
  });
});
