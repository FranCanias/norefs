import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';

function findingsOf(files: Record<string, string>) {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, text] of Object.entries(files)) project.createSourceFile(filePath, text);
  return analyze(project);
}

describe('reachability-based unused files', () => {
  it('reports a dead import cycle even though the files reference each other', () => {
    const findings = findingsOf({
      '/main.ts': 'export const keep = 1;\n',
      '/a.ts': "import { b } from './b';\nexport function a(): number {\n  return b();\n}\n",
      '/b.ts': "import { a } from './a';\nexport function b(): number {\n  return a();\n}\n",
    });
    expect(findings.map(f => [f.kind, f.name])).toEqual([
      ['file', 'a.ts'],
      ['file', 'b.ts'],
    ]);
  });

  it('reports a file whose only importers are themselves unreachable', () => {
    const findings = findingsOf({
      '/main.ts': 'export const keep = 1;\n',
      '/dead.ts': "import { shared } from './shared';\nexport const value = shared;\n",
      '/shared.ts': 'export const shared = 1;\n',
    });
    expect(findings.map(f => [f.kind, f.name])).toEqual([
      ['file', 'dead.ts'],
      ['file', 'shared.ts'],
    ]);
  });

  it('treats a norefs-ignore-file file as a root that keeps its imports alive', () => {
    const findings = findingsOf({
      '/main.ts': 'export const keep = 1;\n',
      '/kept.ts': "// norefs-ignore-file\nimport { dep } from './dep';\nexport const value = dep;\n",
      '/dep.ts': 'export const dep = 1;\n',
    });
    expect(findings).toEqual([]);
  });
});
