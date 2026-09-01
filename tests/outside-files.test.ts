import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import { isFixable } from '../src/engine/fix';
import { loadPackages, loadProject, optionsForDir } from '../src/engine/project';
import { analyzeSyntax } from '../src/engine/syntax-analyze';
import type { Finding } from '../src/types';
import { tempDirs, writeFiles } from './helpers';

/**
 * A tsconfig decides what a run holds, and code the project keeps sits outside
 * it all the time: an `exclude` that names the tests, a script nobody
 * compiles, the JavaScript behind a hand-written declaration file. Those files
 * import the project, and a run that cannot see them calls what they import
 * private, or dead.
 */
const dirs = tempDirs('norefs-outside-');
afterEach(dirs.removeAll);

function project(files: Record<string, string>): { findings: Finding[]; syntax: Finding[]; dir: string } {
  const dir = dirs.make();
  writeFiles(dir, files);
  const tsConfigPath = path.join(dir, 'tsconfig.json');
  const packages = loadPackages([tsConfigPath]);
  const options = { rootDirs: [dir], packages };
  return {
    findings: analyze(loadProject([tsConfigPath]), options),
    syntax: analyzeSyntax([tsConfigPath], optionsForDir(packages, dir) ?? {}, options),
    dir,
  };
}

const CONFIG = JSON.stringify({ include: ['src'], exclude: ['**/*.test.ts'] });

describe('code beside the program', () => {
  it('counts a name an excluded script imports as used', () => {
    // superjson's shape, with a build script rather than a test: nothing in
    // `seal.ts` is analyzed, and the import is real all the same — so `--fix`
    // used to delete an export something outside needs.
    const { findings } = project({
      'tsconfig.json': CONFIG,
      'package.json': JSON.stringify({ name: 'box' }),
      'src/index.ts': "export { measure } from './scale';\n",
      'src/scale.ts':
        'export function measure(): number {\n  return 1;\n}\nexport function weigh(): number {\n  return measure();\n}\n',
      'scripts/seal.ts': "import { weigh } from '../src/scale';\nweigh();\n",
    });
    expect(findings).toEqual([]);
  });

  it('calls an export only an excluded test imports test-only, not used', () => {
    // Where a test sits is not what decides the verdict. The excluded test
    // imports `weigh` and nothing shipped does, which is the same answer the
    // run gives when the test is inside the program — so the config stops
    // deciding whether the reader hears about it.
    const { findings } = project({
      'tsconfig.json': CONFIG,
      'package.json': JSON.stringify({ name: 'box' }),
      'src/index.ts': "export { measure } from './scale';\n",
      'src/scale.ts':
        'export function measure(): number {\n  return 1;\n}\nexport function weigh(): number {\n  return measure();\n}\n',
      'src/scale.test.ts': "import { weigh } from './scale';\nweigh();\n",
    });
    expect(findings.map(f => [f.kind, f.name, f.verdict])).toEqual([['export', 'weigh', 'test-only']]);
    // A test-only finding is never fixed: the fix is deleting the tests too.
    expect(isFixable(findings[0] as Finding, true)).toBe(false);
  });

  it('keeps a file alive when only an excluded file imports it', () => {
    const { findings, syntax } = project({
      'tsconfig.json': CONFIG,
      'package.json': JSON.stringify({ name: 'box' }),
      'src/index.ts': 'export const box = 1;\n',
      'src/jars.ts': 'export const jars = 2;\n',
      'src/lids.ts': 'export const lids = 3;\n',
      'src/jars.test.ts': "import { jars } from './jars';\njars();\n",
    });
    // `lids.ts` is the control: nothing anywhere reaches it.
    expect(findings.filter(f => f.kind === 'file').map(f => f.name)).toEqual(['lids.ts']);
    expect(syntax.filter(f => f.kind === 'file').map(f => f.name)).toEqual(['lids.ts']);
  });

  it('counts a package an excluded file imports as used', () => {
    // execa's shape: the tsconfig compiles one declaration file, and every
    // runtime dependency is imported by the JavaScript beside it.
    const { syntax } = project({
      'tsconfig.json': JSON.stringify({ files: ['src/index.d.ts'] }),
      'package.json': JSON.stringify({ name: 'box', dependencies: { 'jar-sealer': '1.0.0' } }),
      'node_modules/jar-sealer/package.json': JSON.stringify({ name: 'jar-sealer', version: '1.0.0' }),
      'node_modules/jar-sealer/index.js': 'module.exports = 1;\n',
      'src/index.d.ts': 'export declare function seal(): number;\n',
      'src/index.js': "import sealer from 'jar-sealer';\nexport function seal() {\n  return sealer();\n}\n",
    });
    expect(syntax.filter(f => f.kind === 'dependency')).toEqual([]);
  });

  it('never asks for a package an outside file names, or says which section it belongs in', () => {
    // Nothing in that file was analyzed. It can say a listed name is used, and
    // it cannot say the name is missing, or that shipping code needs it.
    const { syntax } = project({
      'tsconfig.json': CONFIG,
      'package.json': JSON.stringify({ name: 'box', devDependencies: { 'jar-sealer': '1.0.0' } }),
      'node_modules/jar-sealer/package.json': JSON.stringify({ name: 'jar-sealer', version: '1.0.0' }),
      'node_modules/jar-sealer/index.js': 'module.exports = 1;\n',
      'src/index.ts': 'export const box = 1;\n',
      'scripts/seal.ts': "import sealer from 'jar-sealer';\nimport shelf from 'shelf-stacker';\nsealer(shelf);\n",
    });
    expect(syntax.filter(f => ['dependency', 'unlisted', 'misplaced'].includes(f.kind))).toEqual([]);
  });

  it('leaves the build output alone', () => {
    // `dist` is the same code twice. Reading it would let yesterday's build
    // keep today's dead code alive.
    const { findings } = project({
      'tsconfig.json': JSON.stringify({ include: ['src'], compilerOptions: { outDir: 'dist' } }),
      'package.json': JSON.stringify({ name: 'box' }),
      'src/index.ts': 'export const box = 1;\n',
      'src/jars.ts': 'export const jars = 2;\n',
      'dist/index.js': "import { jars } from '../src/jars';\njars();\n",
    });
    expect(findings.map(f => [f.kind, f.name])).toEqual([['file', 'jars.ts']]);
  });

  it('reports a member an outside file may read, and refuses to fix it', () => {
    // The names a clause takes are the whole of what the text gives up. A
    // property read needs a type checker, and the file the program excluded
    // has no types — so the claim stands and nothing this run does could
    // prove a deletion safe. `--fix` says so by leaving it alone; a green
    // "Verified" over a deleted member is what the alternative looks like.
    const { findings } = project({
      'tsconfig.json': CONFIG,
      'package.json': JSON.stringify({ name: 'box' }),
      'src/index.ts': "import { shelf } from './shelf';\nexport const jars = shelf.jars;\n",
      'src/shelf.ts': 'export const shelf = { jars: 1, lids: 2 };\n',
      'src/shelf.test.ts': "import { shelf } from './shelf';\nshelf.lids;\n",
    });
    expect(findings.map(f => [f.kind, f.name])).toEqual([['member', 'lids']]);
    expect(isFixable(findings[0] as Finding, false)).toBe(false);
    // A human can still say otherwise, which is what --fix-unsafe is.
    expect(isFixable(findings[0] as Finding, true)).toBe(true);
  });

  it('fixes a member no file outside the program can reach', () => {
    // The control: the excluded test names nothing from `shelf.ts`, so the
    // type check the fix runs holds every reader there is.
    const { findings } = project({
      'tsconfig.json': CONFIG,
      'package.json': JSON.stringify({ name: 'box' }),
      'src/index.ts': "import { shelf } from './shelf';\nexport const jars = shelf.jars;\n",
      'src/shelf.ts': 'export const shelf = { jars: 1, lids: 2 };\n',
      'src/index.test.ts': "import { jars } from './index';\njars;\n",
    });
    expect(findings.map(f => [f.kind, f.name])).toEqual([['member', 'lids']]);
    expect(isFixable(findings[0] as Finding, false)).toBe(true);
  });
  it('reads the code beside a config that holds no files of its own', () => {
    // hono's shape: a solution-style tsconfig with `files: []` and references
    // to the real ones. The program holds nothing, so the walk used to be
    // switched off in exactly the case it was built for — and every package
    // the sources import read as dead.
    const { syntax } = project({
      'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './src' }] }),
      'package.json': JSON.stringify({ name: 'box', dependencies: { 'jar-sealer': '1.0.0' } }),
      'node_modules/jar-sealer/package.json': JSON.stringify({ name: 'jar-sealer', version: '1.0.0' }),
      'node_modules/jar-sealer/index.js': 'module.exports = 1;\n',
      'src/index.ts': "import sealer from 'jar-sealer';\nexport const box = sealer;\n",
    });
    expect(syntax.filter(f => f.kind === 'dependency')).toEqual([]);
  });

  it('leaves a build directory only the manifest names', () => {
    // A `tsc` build names its output in the tsconfig; a bundler's is named
    // nowhere the compiler reads. Left in the walk, yesterday's bundle imports
    // every package today's sources dropped.
    const { syntax } = project({
      'tsconfig.json': JSON.stringify({ include: ['src'], compilerOptions: { noEmit: true } }),
      'package.json': JSON.stringify({
        name: 'box',
        main: 'dist/index.js',
        dependencies: { 'jar-sealer': '1.0.0' },
      }),
      'node_modules/jar-sealer/package.json': JSON.stringify({ name: 'jar-sealer', version: '1.0.0' }),
      'node_modules/jar-sealer/index.js': 'module.exports = 1;\n',
      'src/index.ts': 'export const box = 1;\n',
      'dist/index.js': "const sealer = require('jar-sealer');\nmodule.exports = sealer;\n",
    });
    expect(syntax.map(f => [f.kind, f.name])).toEqual([['dependency', 'jar-sealer']]);
  });

  it('keeps a source directory the manifest happens to name', () => {
    // `"source": "src/index.ts"` is a real field, and `"main": "index.js"`
    // beside the sources names the package root. A directory holding a file
    // the program holds is source, whatever the manifest calls it.
    const { syntax } = project({
      'tsconfig.json': JSON.stringify({ include: ['src'], exclude: ['**/*.test.ts'] }),
      'package.json': JSON.stringify({
        name: 'box',
        source: 'src/index.ts',
        main: 'src/index.js',
        dependencies: { 'jar-sealer': '1.0.0' },
      }),
      'node_modules/jar-sealer/package.json': JSON.stringify({ name: 'jar-sealer', version: '1.0.0' }),
      'node_modules/jar-sealer/index.js': 'module.exports = 1;\n',
      'src/index.ts': 'export const box = 1;\n',
      'src/index.test.ts': "import sealer from 'jar-sealer';\nsealer();\n",
    });
    expect(syntax.filter(f => f.kind === 'dependency')).toEqual([]);
  });
});

function manifestClaims(findings: Finding[]): Array<[string, string]> {
  return findings
    .filter(f => f.kind === 'dependency' || f.kind === 'unlisted' || f.kind === 'misplaced')
    .map(f => [f.kind, f.name]);
}

describe('a host used only beside the program', () => {
  it('still answers for the peers it loads', () => {
    // swr's shape: `@testing-library/react` is imported by tests the tsconfig
    // leaves out, and its peer list names `@testing-library/dom`. The host was
    // used enough not to be reported and not used enough to answer for its
    // plugin, which was called dead.
    const { findings, syntax } = project({
      'tsconfig.json': CONFIG,
      'package.json': JSON.stringify({
        name: 'pantry',
        main: 'src/index.ts',
        devDependencies: { 'pantry-host': '1.0.0', 'pantry-plugin': '1.0.0' },
      }),
      'node_modules/pantry-host/package.json': JSON.stringify({
        name: 'pantry-host',
        peerDependencies: { 'pantry-plugin': '1.0.0' },
      }),
      'node_modules/pantry-plugin/package.json': JSON.stringify({ name: 'pantry-plugin' }),
      'src/index.ts': 'export const box = 1;\n',
      'src/index.test.ts': "import 'pantry-host';\n",
    });
    expect(manifestClaims(findings)).toEqual([]);
    expect(manifestClaims(syntax)).toEqual([]);
  });
});

describe('a workspace under one tsconfig', () => {
  /**
   * changesets' shape: `include` at the root covers every package, and no
   * package has a tsconfig of its own. The root is private and lists nothing.
   */
  function monorepo(): { findings: Finding[]; syntax: Finding[] } {
    return project({
      'package.json': JSON.stringify({ name: 'shelf', private: true, workspaces: ['packages/*'] }),
      // The root's `outDir` says nothing about where a package builds.
      'tsconfig.json': JSON.stringify({ include: ['packages'], compilerOptions: { outDir: 'build' } }),
      'packages/pantry/package.json': JSON.stringify({
        name: 'pantry',
        main: 'dist/index.js',
        dependencies: { 'spice-rack': '1.0.0', 'stale-jar': '1.0.0' },
      }),
      'packages/pantry/src/index.ts': "import { grind } from 'spice-rack';\nexport const plate = grind();\n",
      'packages/pantry/src/orphan.ts': 'export const orphan = 1;\n',
    });
  }

  it("reads each package's own manifest, for its entries and for its dependencies", () => {
    // Only the root manifest was read, so every package dependency read as
    // unlisted and every package entry read as dead. The declaration the
    // package manager reads says where the other manifests are — and the
    // package's own dead dependency is a finding the run can now make.
    const { findings, syntax } = monorepo();
    for (const found of [findings, syntax]) {
      expect(found.filter(f => f.kind === 'file').map(f => f.name)).toEqual(['orphan.ts']);
      expect(manifestClaims(found)).toEqual([['dependency', 'stale-jar']]);
      expect(found.find(f => f.kind === 'dependency')?.filePath.endsWith('packages/pantry/package.json')).toBe(true);
    }
  });
});

describe('the two runs read a require() alike', () => {
  it('counts the package a TypeScript file loads with require()', () => {
    // The full run used to see no import here at all, and the syntax-only run
    // saw the call — so the same project answered two ways.
    const { findings, syntax } = project({
      'tsconfig.json': JSON.stringify({ include: ['src'] }),
      'package.json': JSON.stringify({ name: 'pantry', main: 'src/index.ts', dependencies: { 'spice-rack': '1.0.0' } }),
      'src/index.ts': "const rack = require('spice-rack');\nexport const plate = (): string => rack.grind();\n",
    });
    expect(manifestClaims(findings)).toEqual([]);
    expect(manifestClaims(syntax)).toEqual([]);
  });
});

describe('the packages beside the one a run was pointed at', () => {
  /** A workspace whose test package imports the package under analysis. */
  function workspace(): { findings: Finding[]; syntax: Finding[] } {
    const dir = dirs.make();
    writeFiles(dir, {
      'package.json': JSON.stringify({ name: 'shelf', private: true, workspaces: ['packages/*'] }),
      'packages/box/package.json': JSON.stringify({ name: 'box', main: 'src/index.ts' }),
      'packages/box/tsconfig.json': JSON.stringify({ include: ['src'] }),
      'packages/box/src/index.ts': 'export const box = 1;\n',
      'packages/box/src/lid.ts': 'export const lid = 2;\n',
      'packages/box/src/tray.ts': 'export const tray = 3;\n',
      'packages/tests/package.json': JSON.stringify({ name: 'tests', private: true }),
      'packages/tests/lid.test.ts': "import { lid } from '../box/src/lid';\nimport 'shelf-stacker';\nlid;\n",
    });
    const tsConfigPath = path.join(dir, 'packages/box/tsconfig.json');
    const packages = loadPackages([tsConfigPath]);
    const options = { rootDirs: [path.join(dir, 'packages/box')], packages };
    return {
      findings: analyze(loadProject([tsConfigPath]), options),
      syntax: analyzeSyntax([tsConfigPath], optionsForDir(packages, path.join(dir, 'packages/box')) ?? {}, options),
    };
  }

  it('reads a sibling package for what it takes from this one', () => {
    // trpc's shape: `packages/tests` imports helpers out of `packages/server`,
    // and `--fix` deleted every one of them. Where a tsconfig sits is a layout
    // decision, not a boundary of the code.
    const { findings, syntax } = workspace();
    // `tray.ts` is the control: nothing in the workspace reaches it.
    expect(findings.filter(f => f.kind === 'file').map(f => f.name)).toEqual(['tray.ts']);
    expect(syntax.filter(f => f.kind === 'file').map(f => f.name)).toEqual(['tray.ts']);
  });

  it('never lets a sibling answer for the manifest of the package asked about', () => {
    // Nothing in that package was analyzed, and it is not the package being
    // asked about. A claim built on both would be two guesses deep.
    const { syntax } = workspace();
    expect(syntax.filter(f => ['dependency', 'unlisted', 'misplaced'].includes(f.kind))).toEqual([]);
  });
});
