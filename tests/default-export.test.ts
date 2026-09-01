import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import { applyFixes } from '../src/engine/fix';
import { formatText } from '../src/engine/report';
import type { Finding } from '../src/types';
import { analyzeFiles } from './helpers';

/** A recipe box whose module also exports something nobody argues about. */
function box(...lines: string[]): string {
  return ['export const shelfCount = 4;', ...lines, ''].join('\n');
}

/** The importer that keeps `/box.ts` alive without touching its default. */
const reader = "import { shelfCount } from './box';\nexport const total = shelfCount;\n";

function named(findings: Finding[]): string[] {
  return findings.map(f => `${f.kind} ${f.name}`);
}

describe('a default export with no name', () => {
  it('reports an anonymous class', () => {
    const findings = analyzeFiles({
      '/box.ts': box('export default class {', '  open(): string {', '    return "open";', '  }', '}'),
      '/main.ts': reader,
    });
    expect(named(findings)).toEqual(['export default']);
    // `default` is the module system's word, not the author's, so the report
    // says what the export is instead of quoting a name nobody wrote.
    expect(formatText(findings, '/')).toContain('dead default export');
  });

  it('reports an object literal, an arrow, and a bare value the same way', () => {
    for (const value of ['{ lid: true }', '(): string => "open"', '42']) {
      const findings = analyzeFiles({ '/box.ts': box(`export default ${value};`), '/main.ts': reader });
      expect(named(findings), value).toEqual(['export default']);
    }
  });

  it('reports an anonymous function', () => {
    const findings = analyzeFiles({
      '/box.ts': box('export default function (): string {', '  return "open";', '}'),
      '/main.ts': reader,
    });
    expect(named(findings)).toEqual(['export default']);
  });

  it('says nothing when a default import reads it', () => {
    const findings = analyzeFiles({
      '/box.ts': box('export default { lid: true };'),
      '/main.ts':
        "import lid, { shelfCount } from './box';\nexport const total = shelfCount;\nexport const open = lid;\n",
    });
    expect(named(findings)).toEqual([]);
  });

  it('says nothing when a barrel carries it to a reader', () => {
    const findings = analyzeFiles({
      '/box.ts': box('export default { lid: true };'),
      '/barrel.ts': "export { default as Lid } from './box';\nexport { shelfCount } from './box';\n",
      '/main.ts':
        "import { Lid, shelfCount } from './barrel';\nexport const total = shelfCount;\nexport const open = Lid;\n",
    });
    expect(named(findings)).toEqual([]);
  });

  it('reports it when the barrel that forwards it has no reader of its own', () => {
    const findings = analyzeFiles({
      '/box.ts': box('export default { lid: true };'),
      '/barrel.ts': "export { default as Lid } from './box';\nexport { shelfCount } from './box';\n",
      '/main.ts': "import { shelfCount } from './barrel';\nexport const total = shelfCount;\n",
    });
    expect(named(findings)).toEqual(['export default']);
  });

  it('leaves the finding on the named declaration a default export forwards', () => {
    // `export default lid` hands the question to a declaration that has a name
    // of its own, and one death is told once.
    const findings = analyzeFiles({
      '/box.ts': box('const lid = { closed: true };', 'export default lid;'),
      '/main.ts': reader,
    });
    expect(named(findings)).toEqual(['export lid']);
  });

  it('leaves a named default class exactly as it was', () => {
    const findings = analyzeFiles({
      '/box.ts': box('export default class Lid {', '  open(): string {', '    return "open";', '  }', '}'),
      '/main.ts': reader,
    });
    expect(named(findings)).toEqual(['export Lid']);
  });

  it('never reports the default export of a tool config', () => {
    // A config is loaded by name, not imported. Its default export is how the
    // tool takes its input, and nothing in the project will ever name it.
    const findings = analyzeFiles({
      '/vitest.config.ts': "import { shelfCount } from './box';\nexport default { retry: shelfCount };\n",
      '/box.ts': 'export const shelfCount = 4;\n',
      '/main.ts': reader,
    });
    expect(named(findings)).toEqual([]);
  });

  it('calls it test-only when only the harness reads it', () => {
    const findings = analyzeFiles({
      '/box.ts': box('export default { lid: true };'),
      '/main.ts': reader,
      '/box.test.ts': "import lid from './box';\nexport const open = lid;\n",
    });
    const member = findings.find(f => f.name === 'default');
    expect(member?.verdict).toBe('test-only');
  });

  it('honours a suppression comment', () => {
    const findings = analyzeFiles({
      '/box.ts': box('// norefs-ignore', 'export default { lid: true };'),
      '/main.ts': reader,
    });
    expect(named(findings)).toEqual([]);
  });
});

describe('the members of a default-exported class with no name', () => {
  /** A lid whose latch nobody lifts. */
  const latch = [
    'export default class {',
    '  open(): string {',
    '    return "open";',
    '  }',
    '  deadLatch(): string {',
    '    return "stuck";',
    '  }',
    '}',
    '',
  ].join('\n');

  it('reports the one nothing reads', () => {
    const findings = analyzeFiles({
      '/box.ts': latch,
      '/main.ts': "import Box from './box';\nexport const open = new Box().open();\n",
    });
    expect(named(findings)).toEqual(['member deadLatch']);
    // There is no class name to print, so the sentence says where it lives.
    expect(formatText(findings, '/')).toContain('dead property `deadLatch` in the default-exported class');
  });

  it('reports a parameter property the same way', () => {
    const findings = analyzeFiles({
      '/box.ts': [
        'export default class {',
        '  constructor(private readonly deadTag: string) {}',
        '  open(): string {',
        '    return "open";',
        '  }',
        '}',
        '',
      ].join('\n'),
      '/main.ts': 'import Box from \'./box\';\nexport const open = new Box("brass").open();\n',
    });
    expect(named(findings)).toEqual(['member deadTag']);
  });

  it('stays silent when the instance escapes into an interface', () => {
    // A structural implementation is called through the interface, so its
    // members collect no references while being used. The escape check has to
    // reach this class the same way it reaches a named one.
    const findings = analyzeFiles({
      '/box.ts': `export interface Lid {\n  open(): string;\n}\n${latch}`,
      '/main.ts': [
        "import Box, { type Lid } from './box';",
        'export const lid: Lid = new Box();',
        'export const open = lid.open();',
        '',
      ].join('\n'),
    });
    expect(named(findings)).toEqual([]);
  });

  it('stays silent when a subclass lets the instance out', () => {
    const findings = analyzeFiles({
      '/box.ts': latch,
      '/crate.ts': [
        "import Box from './box';",
        'export interface Lid {',
        '  open(): string;',
        '}',
        'export class Crate extends Box {}',
        'export const lid: Lid = new Crate();',
        '',
      ].join('\n'),
      '/main.ts': "import { lid } from './crate';\nexport const open = lid.open();\n",
    });
    expect(named(findings).filter(name => name.startsWith('member'))).toEqual([]);
  });

  it('stays silent when something enumerates its keys', () => {
    const findings = analyzeFiles({
      '/box.ts': [
        'export default class {',
        '  static open(): string {',
        '    return "open";',
        '  }',
        '  static deadLatch(): string {',
        '    return "stuck";',
        '  }',
        '}',
        '',
      ].join('\n'),
      '/main.ts': [
        "import Box from './box';",
        'export type Keys = keyof typeof Box;',
        'export const open = Box.open();',
        '',
      ].join('\n'),
    });
    expect(named(findings)).toEqual([]);
  });
});

describe('--fix on a default export with no name', () => {
  function fixed(files: Record<string, string>): Record<string, string> {
    const project = new Project({ useInMemoryFileSystem: true });
    for (const [filePath, text] of Object.entries(files)) project.createSourceFile(filePath, text);
    applyFixes(analyze(project));
    return Object.fromEntries(
      Object.keys(files).map(filePath => [filePath, project.getSourceFile(filePath)?.getFullText() ?? ''])
    );
  }

  it('removes the statement that exports it', () => {
    const after = fixed({ '/box.ts': box('export default { lid: true };'), '/main.ts': reader });
    expect(after['/box.ts']).toBe('export const shelfCount = 4;\n');
  });

  it('takes a dangling default import with it, and keeps the rest of the clause', () => {
    const after = fixed({
      '/box.ts': box('export default { lid: true };'),
      '/main.ts': "import lid, { shelfCount } from './box';\nexport const total = shelfCount;\n",
    });
    expect(after['/main.ts']).toBe("import { shelfCount } from './box';\nexport const total = shelfCount;\n");
  });

  it('removes an import statement the default binding was holding up alone', () => {
    const after = fixed({
      '/box.ts': box('export default { lid: true };'),
      '/main.ts': "import lid from './box';\nimport { shelfCount } from './box';\nexport const total = shelfCount;\n",
    });
    expect(after['/main.ts']).toBe("import { shelfCount } from './box';\nexport const total = shelfCount;\n");
  });

  it('takes the barrel specifier that forwarded it', () => {
    const after = fixed({
      '/box.ts': box('export default { lid: true };'),
      '/barrel.ts': "export { default as Lid } from './box';\nexport { shelfCount } from './box';\n",
      '/main.ts': "import { shelfCount } from './barrel';\nexport const total = shelfCount;\n",
    });
    expect(after['/barrel.ts']).toBe("export { shelfCount } from './box';\n");
  });
});
