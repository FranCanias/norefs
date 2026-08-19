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
    expect(findings[0]?.filePath).toBe('/package.json');
    expect(findings[0]?.line).toBe(4);
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
    expect(findings[0]?.filePath).toBe('/main.ts');
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

/** A project whose tool configs the compiler never reads, plus what is installed. */
function withConfigs(
  manifest: object,
  plainFiles: Record<string, string>,
  sourceFiles: Record<string, string>,
  packages: Record<string, object> = {}
): Finding[] {
  const project = new Project({ useInMemoryFileSystem: true });
  const fileSystem = project.getFileSystem();
  fileSystem.writeFileSync('/package.json', JSON.stringify(manifest, null, 2));
  for (const [name, data] of Object.entries(packages)) {
    fileSystem.writeFileSync(`/node_modules/${name}/package.json`, JSON.stringify(data));
  }
  for (const [filePath, text] of Object.entries(plainFiles)) fileSystem.writeFileSync(filePath, text);
  for (const [filePath, text] of Object.entries(sourceFiles)) project.createSourceFile(filePath, text);
  return analyze(project, { rootDirs: ['/'] }).filter(f => f.kind === 'dependency' || f.kind === 'misplaced');
}

describe('what a config says a package is for', () => {
  it('a package a tool config imports is a package in use', () => {
    // An ESLint config is a JavaScript file the TypeScript program never holds,
    // so its plugins had no import anywhere and looked dead. The config is right
    // there next to the manifest, saying otherwise.
    const findings = withConfigs(
      {
        scripts: { lint: 'eslint .' },
        devDependencies: { eslint: '9.0.0', 'eslint-plugin-pantry': '1.0.0', unused: '1.0.0' },
      },
      { '/eslint.config.js': "import pantry from 'eslint-plugin-pantry';\nexport default [pantry.configs.strict];\n" },
      { '/main.ts': 'export const x = 1;\n' },
      {
        eslint: { name: 'eslint', bin: { eslint: './bin/eslint.js' } },
        'eslint-plugin-pantry': { name: 'eslint-plugin-pantry' },
        unused: { name: 'unused' },
      }
    );
    expect(findings.map(f => f.name)).toEqual(['unused']);
  });

  it('a package named as a plain string in a config counts too', () => {
    // `environment: 'jsdom'` is how a test runner is told to load jsdom.
    const findings = withConfigs(
      { devDependencies: { jsdom: '1.0.0' } },
      { '/vitest.config.ts': "export default { test: { environment: 'jsdom' } };" },
      { '/main.ts': 'export const x = 1;\n' },
      { jsdom: { name: 'jsdom' } }
    );
    expect(findings).toEqual([]);
  });

  it('a package named only inside a comment is not a package in use', () => {
    // A commented-out plugin import is exactly the case where the package is
    // dead. Reading the config's raw text put the name in the used set and the
    // finding vanished; the strings come off the token stream instead.
    const findings = withConfigs(
      { devDependencies: { 'gone-plugin': '1.0.0' } },
      { '/vitest.config.ts': "// import gone from 'gone-plugin';\nexport default {};\n" },
      { '/main.ts': 'export const x = 1;\n' },
      { 'gone-plugin': { name: 'gone-plugin' } }
    );
    expect(findings.map(f => [f.kind, f.name])).toEqual([['dependency', 'gone-plugin']]);
  });

  it('a plugin its host declares as a peer is loaded through that host', () => {
    // `--coverage` names no package, and the coverage plugin is in use. The host
    // lists it as a peer dependency, which is how a plugin says who loads it.
    const findings = withConfigs(
      {
        scripts: { test: 'harness --coverage' },
        devDependencies: { harness: '1.0.0', 'harness-coverage': '1.0.0', orphan: '1.0.0' },
      },
      {},
      { '/main.ts': 'export const x = 1;\n' },
      {
        harness: { name: 'harness', bin: { harness: './cli.js' }, peerDependencies: { 'harness-coverage': '1.0.0' } },
        'harness-coverage': { name: 'harness-coverage' },
        orphan: { name: 'orphan' },
      }
    );
    expect(findings.map(f => f.name)).toEqual(['orphan']);
  });

  it('a peer of a package nothing uses is not spared', () => {
    // The host has to be in use for "the host loads it" to mean anything.
    const findings = withConfigs(
      { devDependencies: { harness: '1.0.0', 'harness-coverage': '1.0.0' } },
      {},
      { '/main.ts': 'export const x = 1;\n' },
      {
        harness: { name: 'harness', peerDependencies: { 'harness-coverage': '1.0.0' } },
        'harness-coverage': { name: 'harness-coverage' },
      }
    );
    expect(findings.map(f => f.name)).toEqual(['harness', 'harness-coverage']);
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
    expect(findings[0]?.evidence).toContain('production code imports it');
  });

  it("a second target's config is still a config, not production code", () => {
    // `vite.config.server.ts` imports the bundler. Recognizing only
    // `*.config.ts` made that import look like something the product loads at
    // run time, and every build tool in devDependencies came back misplaced.
    const findings = withConfigs(
      { devDependencies: { bundler: '1.0.0' } },
      {},
      {
        '/vite.config.server.ts': "import { defineConfig } from 'bundler';\nexport default defineConfig({});\n",
        '/main.ts': 'export const x = 1;\n',
      },
      { bundler: { name: 'bundler' } }
    );
    expect(findings).toEqual([]);
  });

  it('names a dependency that only the harness imports', () => {
    const findings = installed(
      { dependencies: { fixtures: '1.0.0' } },
      { '/main.ts': 'export const x = 1;\n', '/main.test.ts': "import 'fixtures';\nexport const t = 1;\n" },
      { fixtures: { name: 'fixtures' } }
    );
    expect(findings.map(f => [f.kind, f.name, f.context])).toEqual([['misplaced', 'fixtures', 'dependencies']]);
    expect(findings[0]?.evidence).toContain('ships for nothing');
  });

  it('names a dependency only a config uses', () => {
    // `environment: 'dom-shim'` is the test runner loading it, which is why it
    // is not dead. It is still weight the product ships for nothing, and until
    // now no check asked: the config use silenced the dead verdict, and the
    // section check only ever looked at imports.
    const findings = withConfigs(
      { dependencies: { 'dom-shim': '1.0.0' } },
      { '/vitest.config.ts': "export default { test: { environment: 'dom-shim' } };" },
      { '/main.ts': 'export const x = 1;\n' },
      { 'dom-shim': { name: 'dom-shim' } }
    );
    expect(findings.map(f => [f.kind, f.name, f.context])).toEqual([['misplaced', 'dom-shim', 'dependencies']]);
    expect(findings[0]?.evidence).toContain('ships for nothing');
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

  it('says nothing about the section of a module the environment provides', () => {
    // `declare module 'host-shell'` in the package's own types: the binary that
    // loads the code brings the module with it. Which section it sits in is the
    // packager's call — electron-builder wants `electron` in devDependencies and
    // reads it from there — and no install is what puts the module in place.
    const findings = withConfigs(
      { devDependencies: { 'host-shell': '1.0.0' } },
      { '/node_modules/host-shell/shell.d.ts': "declare module 'host-shell' {\n  export const app: unknown;\n}\n" },
      { '/main.ts': "import { app } from 'host-shell';\nexport const x = app;\n" },
      { 'host-shell': { name: 'host-shell', main: 'index.js', types: 'shell.d.ts' } }
    );
    expect(findings).toEqual([]);

    // Shipping types is not the claim. A package whose types are a plain module
    // is resolved out of node_modules like anything else, and the install that
    // skips dev dependencies really is missing it.
    const plain = withConfigs(
      { devDependencies: { 'plain-lib': '1.0.0' } },
      { '/node_modules/plain-lib/index.d.ts': 'export declare const helper: unknown;\n' },
      { '/main.ts': "import { helper } from 'plain-lib';\nexport const x = helper;\n" },
      { 'plain-lib': { name: 'plain-lib', types: 'index.d.ts' } }
    );
    expect(plain.map(f => [f.kind, f.name])).toEqual([['misplaced', 'plain-lib']]);
  });

  it('reads an ambient declaration in one direction only', () => {
    // `declare module` is also how a library older than ES modules ships its
    // types — @xterm/headless, node-pty and toml all write it, and all three are
    // ordinary packages a product installs and ships. Reading it as "the host
    // provides this" would call every one of them misplaced. It withholds a
    // claim; it never makes one.
    const findings = withConfigs(
      { dependencies: { 'plain-lib': '1.0.0' } },
      { '/node_modules/plain-lib/index.d.ts': "declare module 'plain-lib' {\n  export const helper: unknown;\n}\n" },
      { '/main.ts': "import { helper } from 'plain-lib';\nexport const x = helper;\n" },
      { 'plain-lib': { name: 'plain-lib', main: 'index.js', types: 'index.d.ts' } }
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
    expect(text[(findings[0]?.line ?? 0) - 1]).toContain('"nothing": "1.0.0"');
  });
});
