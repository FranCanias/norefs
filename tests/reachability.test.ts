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

describe('harness directories', () => {
  it('reads a name that carries its word before the separator, or the underscores around it', () => {
    // `test-d` is tsd's own directory and `bench` is where a benchmark lives.
    // `latest` has no separator at all, and `test-utils` carries a word on the
    // side that names what products ship, so both stay ordinary source.
    const findings = analyzeFiles({
      '/main.ts': 'export const keep = 1;\n',
      '/test-d/card.ts': 'export const checked = 1;\n',
      '/type-tests/card.ts': 'export const typed = 1;\n',
      '/__performance_tests__/card.ts': 'export const timed = 1;\n',
      '/bench/card.ts': 'export const measured = 1;\n',
      '/latest/card.ts': 'export const newest = 1;\n',
      '/test-utils/card.ts': 'export const helper = 1;\n',
    });
    expect(findings.filter(f => f.kind === 'file').map(f => f.filePath)).toEqual([
      '/latest/card.ts',
      '/test-utils/card.ts',
    ]);
  });
});

describe('harness file names', () => {
  it('reads the word with the suffix a tool gives it, and as the whole name', () => {
    // `pick.test-d.ts` is tsd's, `groupBy.test-prop.ts` is fast-check's, and a
    // benchmark script beside the sources is called what it is. `manifest.ts`
    // and `latest.ts` end in the same four letters and open no word, so they
    // are the source they look like.
    const findings = analyzeFiles({
      '/main.ts': 'export const keep = 1;\n',
      '/pick.test-d.ts': "import { keep } from './main';\nexport const checked = keep;\n",
      '/groupBy.test-prop.ts': "import { keep } from './main';\nexport const generated = keep;\n",
      '/benchmark.js': "import { keep } from './main';\nexport const timed = keep;\n",
      '/manifest.ts': 'export const listed = 1;\n',
      '/latest.ts': 'export const newest = 1;\n',
    });
    expect(findings.filter(f => f.kind === 'file').map(f => f.filePath)).toEqual(['/latest.ts', '/manifest.ts']);
  });
});
