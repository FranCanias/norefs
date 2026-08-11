import type { CompilerOptions } from 'ts-morph';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';

function findingsOf(manifest: object, files: Record<string, string>, compilerOptions: CompilerOptions = {}) {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions });
  project.getFileSystem().writeFileSync('/package.json', JSON.stringify(manifest));
  for (const [filePath, text] of Object.entries(files)) project.createSourceFile(filePath, text);
  return analyze(project, { rootDirs: ['/'] });
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
