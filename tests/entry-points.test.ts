import path from 'node:path';
import type { CompilerOptions } from 'ts-morph';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import { analyzeSyntax, listEntryPoints } from '../src/engine/syntax-analyze';

function findingsOf(manifest: object, files: Record<string, string>, compilerOptions: CompilerOptions = {}) {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions });
  project.getFileSystem().writeFileSync('/package.json', JSON.stringify(manifest));
  for (const [filePath, text] of Object.entries(files)) project.createSourceFile(filePath, text);
  return analyze(project, { rootDirs: ['/'] });
}

/** Files a build tool reads but TypeScript does not compile: HTML, configs. */
function findingsWith(
  manifest: object,
  plainFiles: Record<string, string>,
  sourceFiles: Record<string, string>,
  compilerOptions: CompilerOptions = {}
) {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions });
  const fileSystem = project.getFileSystem();
  fileSystem.writeFileSync('/package.json', JSON.stringify(manifest));
  for (const [filePath, text] of Object.entries(plainFiles)) fileSystem.writeFileSync(filePath, text);
  for (const [filePath, text] of Object.entries(sourceFiles)) project.createSourceFile(filePath, text);
  return analyze(project, { rootDirs: ['/'] });
}

function names(findings: ReturnType<typeof analyze>): string[] {
  return findings.filter(f => f.kind === 'file').map(f => f.name);
}

describe('package.json-aware entries', () => {
  it('maps main, bin, and exports through outDir back to source entry points', () => {
    const findings = findingsOf(
      {
        main: 'dist/app.js',
        bin: { tool: './dist/tool.js' },
        exports: {
          '.': { import: './dist/lib.mjs' },
          './direct': './src/direct.ts',
        },
      },
      {
        '/src/app.ts': 'export const app = 1;\n',
        '/src/tool.ts': 'export const tool = 1;\n',
        '/src/lib.ts': 'export const lib = 1;\n',
        '/src/direct.ts': 'export const direct = 1;\n',
        '/src/orphan.ts': 'export const orphan = 1;\n',
      },
      { outDir: 'dist', rootDir: 'src' }
    );
    // The named files are entry points: not unused, exports never reported.
    // The control file stays a finding.
    expect(findings.map(f => [f.kind, f.name])).toEqual([['file', 'orphan.ts']]);
  });

  it('skips exports patterns with wildcards', () => {
    const findings = findingsOf(
      { exports: { './*': './dist/*' } },
      { '/src/anything.ts': 'export const anything = 1;\n' },
      { outDir: 'dist', rootDir: 'src' }
    );
    expect(findings.map(f => [f.kind, f.name])).toEqual([['file', 'anything.ts']]);
  });
});

describe('entry points the build declares', () => {
  it('a script that runs a source file names an entry point', () => {
    const findings = findingsOf(
      { scripts: { serve: 'tsx src/server.ts', lint: 'biome lint .' } },
      {
        '/src/server.ts': 'export const server = 1;\n',
        '/src/orphan.ts': 'export const orphan = 1;\n',
      }
    );
    expect(names(findings)).toEqual(['orphan.ts']);
  });

  it('a script flag written with = still names its file', () => {
    // Deliberately not a *.config.ts and not index/main/cli: those are entry
    // points already, and a test they pass without the token parsing proves
    // nothing about the token parsing.
    const findings = findingsOf(
      { scripts: { gen: 'codegen --schema=src/schema.ts' } },
      {
        '/src/schema.ts': 'export const schema = 1;\n',
        '/src/orphan.ts': 'export const orphan = 1;\n',
      }
    );
    expect(names(findings)).toEqual(['orphan.ts']);
  });

  it("an HTML file's script src names an entry point, root-absolute included", () => {
    const findings = findingsWith(
      {},
      { '/index.html': '<script type="module" src="/src/renderer/boot.tsx"></script>' },
      { '/src/renderer/boot.tsx': 'export const boot = 1;\n', '/src/orphan.ts': 'export const orphan = 1;\n' }
    );
    expect(names(findings)).toEqual(['orphan.ts']);
  });

  it('a path written in a tool config names an entry point', () => {
    const findings = findingsWith(
      {},
      { '/vite.config.ts': "export default { build: { rollupOptions: { input: 'src/preload.ts' } } };" },
      { '/src/preload.ts': 'export const preload = 1;\n', '/src/orphan.ts': 'export const orphan = 1;\n' }
    );
    expect(names(findings)).toEqual(['orphan.ts']);
  });

  it('a string that names no project file changes nothing', () => {
    // The loose split is only safe because the resolver throws away what it
    // cannot land on a file. A config full of prose must not silence anything.
    const findings = findingsWith(
      { scripts: { build: 'tsc && vite build --mode production' } },
      { '/app.config.ts': "export default { title: 'src', mode: './nothing/here.ts' };" },
      { '/src/orphan.ts': 'export const orphan = 1;\n' }
    );
    expect(names(findings)).toEqual(['orphan.ts']);
  });

  it('build output is never walked for configs', () => {
    const findings = findingsWith(
      {},
      { '/dist/stale.config.js': "export default { input: 'src/orphan.ts' };" },
      { '/src/orphan.ts': 'export const orphan = 1;\n' }
    );
    expect(names(findings)).toEqual(['orphan.ts']);
  });
});

describe('a real project on disk', () => {
  const dir = path.resolve('tests/entry-fixtures');
  const tsConfig = path.join(dir, 'tsconfig.json');

  it('names every entry point and what declared it', () => {
    const found = listEntryPoints([tsConfig], {}, { rootDirs: [dir] }).map(entry => [
      path.relative(dir, entry.filePath),
      entry.source,
    ]);
    expect(found).toEqual([
      ['src/boot.tsx', '<script src> in index.html'],
      ['src/main.ts', 'index/main/cli beside a tsconfig'],
      ['src/preload.ts', 'a path named in vite.config.ts'],
      ['src/server.ts', 'package.json scripts.serve'],
    ]);
  });

  it('leaves the syntax-only run with the one true finding', () => {
    const findings = analyzeSyntax([tsConfig], {}, { rootDirs: [dir] });
    expect(findings.map(f => f.name)).toEqual(['orphan.ts']);
  });
});
