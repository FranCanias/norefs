import { describe, expect, it } from 'vitest';
import { analyzeFiles } from './helpers';

describe('reachability-based unused files', () => {
  it('reports a dead import cycle even though the files reference each other', () => {
    const findings = analyzeFiles({
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
    const findings = analyzeFiles({
      '/main.ts': 'export const keep = 1;\n',
      '/dead.ts': "import { shared } from './shared';\nexport const value = shared;\n",
      '/shared.ts': 'export const shared = 1;\n',
    });
    expect(findings.map(f => [f.kind, f.name])).toEqual([
      ['file', 'dead.ts'],
      ['file', 'shared.ts'],
    ]);
  });

  it('keeps the JavaScript a hand-written declaration file stands for', () => {
    // `import './grammar'` resolves to `grammar.d.ts` and the type graph stops
    // there. The runtime loads `grammar.js`, so calling it dead is advice that
    // breaks the build — while a `.js` nothing pairs with is still dead.
    const findings = analyzeFiles({
      '/main.ts': "import { parse } from './grammar';\nexport const keep = parse();\n",
      '/grammar.d.ts': 'export declare function parse(): number;\n',
      '/grammar.js': 'export function parse() {\n  return 1;\n}\n',
      '/orphan.js': 'export function nobody() {\n  return 1;\n}\n',
    });
    expect(findings.map(f => [f.kind, f.name])).toEqual([['file', 'orphan.js']]);
  });

  it('treats a norefs-ignore-file file as a root that keeps its imports alive', () => {
    const findings = analyzeFiles({
      '/main.ts': 'export const keep = 1;\n',
      '/kept.ts': "// norefs-ignore-file\nimport { dep } from './dep';\nexport const value = dep;\n",
      '/dep.ts': 'export const dep = 1;\n',
    });
    expect(findings).toEqual([]);
  });
});
