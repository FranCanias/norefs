import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import type { Finding } from '../src/types';

/**
 * The shipping code path alone. `test-only` says a thing is alive because the
 * tests hold it up; `--production` asks the stricter question — what is left
 * standing when they are not there at all.
 */
const PROJECT: Record<string, string> = {
  '/index.ts': "import { ship } from './lib';\nexport const boot = (): string => ship();\n",
  '/lib.ts': [
    'export interface Widget {',
    '  shipped: string;',
    '  onlyTestsRead: string;',
    '}',
    "export const ship = (): string => 'ok';",
    'export const helperForTests = (w: Widget): string => w.onlyTestsRead;',
    '',
  ].join('\n'),
  // Under src, named like production code, and only the test imports it.
  '/fixtures.ts': "export const sample = { shipped: 'a', onlyTestsRead: 'b' };\n",
  '/lib.test.ts': [
    "import { helperForTests } from './lib';",
    "import { sample } from './fixtures';",
    'export const check = (): string => helperForTests(sample);',
    '',
  ].join('\n'),
};

function run(production: boolean, files: Record<string, string> = PROJECT): Finding[] {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, text] of Object.entries(files)) project.createSourceFile(filePath, text);
  return analyze(project, { rootDirs: ['/'], production });
}

function named(findings: Finding[]): Array<[string, string, string]> {
  return findings.map(f => [f.kind, f.name, f.verdict ?? '']);
}

describe('--production, against the same project', () => {
  it('reports a file only the tests import as dead', () => {
    // Normally a harness file is a reachability root, so what it imports stays
    // alive and only its exports get the test-only label.
    expect(named(run(false))).toContainEqual(['export', 'sample', 'test-only']);
    expect(named(run(true))).toContainEqual(['file', 'fixtures.ts', 'dead']);
    // And the file-level finding swallows the export-level one.
    expect(named(run(true))).not.toContainEqual(['export', 'sample', 'test-only']);
  });

  it('turns a test-only export into a dead one', () => {
    expect(named(run(false))).toContainEqual(['export', 'helperForTests', 'test-only']);
    expect(named(run(true))).toContainEqual(['export', 'helperForTests', 'dead']);
  });

  it('reports nothing inside the files it treats as absent', () => {
    // `check` is a dead export of the test file in a normal run.
    expect(named(run(false))).toContainEqual(['export', 'check', 'dead']);
    expect(run(true).some(f => f.filePath === '/lib.test.ts')).toBe(false);
  });

  it('turns a member only the tests read into a dead one', () => {
    const files = {
      '/index.ts': "import { ship } from './lib';\nexport const boot = (): string => ship();\n",
      '/lib.ts':
        'export interface Config {\n  shipped: string;\n  probed: string;\n}\ndeclare const held: Config;\nexport const ship = (): string => held.shipped;\n',
      '/lib.test.ts': "import type { Config } from './lib';\nexport const read = (c: Config): string => c.probed;\n",
    };
    expect(named(run(false, files))).toContainEqual(['member', 'probed', 'test-only']);
    expect(named(run(true, files))).toContainEqual(['member', 'probed', 'dead']);
  });

  it('leaves the shipping path itself alone', () => {
    expect(run(true).some(f => f.name === 'boot' || f.name === 'ship')).toBe(false);
  });

  it('does not cite a write from a file it just called dead', () => {
    // `shipped` is written in fixtures.ts and read nowhere. Normally that
    // fixture is alive and the write is real proof. In production mode the
    // report says the file is going away, so `proven, never read` would point
    // its evidence at a corpse — and the member is simply dead.
    const before = run(false).find(f => f.name === 'shipped');
    expect(before?.verdict).toBe('write-only');
    const after = run(true).find(f => f.name === 'shipped');
    expect(after?.verdict).toBe('dead');
    expect(after?.evidence).not.toContain('fixtures.ts');
  });
});

describe('--production and package.json', () => {
  function deps(production: boolean): Finding[] {
    const project = new Project({ useInMemoryFileSystem: true });
    const fileSystem = project.getFileSystem();
    fileSystem.writeFileSync(
      '/package.json',
      JSON.stringify({ dependencies: { 'only-in-tests': '1.0.0' }, devDependencies: { unused: '1.0.0' } }, null, 2)
    );
    fileSystem.writeFileSync('/node_modules/unused/package.json', '{"name":"unused"}');
    fileSystem.writeFileSync('/node_modules/only-in-tests/package.json', '{"name":"only-in-tests"}');
    project.createSourceFile('/shims.d.ts', "declare module 'only-in-tests';\n");
    project.createSourceFile('/index.ts', 'export const boot = 1;\n');
    project.createSourceFile('/app.test.ts', "import 'only-in-tests';\nexport const t = 1;\n");
    return analyze(project, { rootDirs: ['/'], production }).filter(
      f => f.kind === 'dependency' || f.kind === 'misplaced'
    );
  }

  it('calls a dependency only the tests import dead, instead of misplaced', () => {
    // Normally the answer is "move it to devDependencies". With the tests
    // absent there is nothing importing it at all.
    expect(named(deps(false))).toContainEqual(['misplaced', 'only-in-tests', '']);
    expect(named(deps(true))).toContainEqual(['dependency', 'only-in-tests', 'dead']);
  });

  it('says only what it read, since the tests it skipped do import the package', () => {
    // The test file imports `only-in-tests`. "No source file imports it" would
    // be false; the shipping path is the half this run actually looked at.
    const evidence = deps(true).find(f => f.name === 'only-in-tests')?.evidence;
    expect(evidence).toBe('no file on the shipping path imports it, no script runs it, and no config or host names it');
    expect(deps(false).find(f => f.name === 'unused')?.evidence).toBe(
      'no source file imports it, no script runs it, and no config or host names it'
    );
  });

  it('says nothing about devDependencies, which exist to build and test', () => {
    expect(named(deps(false))).toContainEqual(['dependency', 'unused', 'dead']);
    expect(deps(true).some(f => f.name === 'unused')).toBe(false);
  });
});
