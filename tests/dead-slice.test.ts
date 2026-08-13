import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';

describe('dead-slice producer findings', () => {
  it('folds a fully-unread returned object of a local producer into one finding', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'function computeColors() {',
        '  return {',
        '    primary: mix(1),',
        '    accent: mix(2),',
        '    border: mix(3),',
        '  };',
        '}',
        'function mix(n: number): string {',
        "  return '#' + n;",
        '}',
        'computeColors();',
        '',
      ].join('\n')
    );
    const findings = analyze(project);

    const slice = findings.find(f => f.kind === 'empty-type' && f.name === 'computeColors');
    expect(slice).toBeDefined();
    expect(slice?.context).toBe('returned object');
    expect(slice?.swallowed).toBe(3);
    // The three property findings folded in.
    expect(findings.filter(f => f.kind === 'member')).toEqual([]);
  });

  it('reports only the unread properties when some are read', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      ['function compute() {', '  return { used: 1, dead: 2 };', '}', 'export const value = compute().used;', ''].join(
        '\n'
      )
    );
    const findings = analyze(project);
    expect(findings.map(f => [f.kind, f.name])).toEqual([['member', 'dead']]);
    expect(findings[0].context).toContain('compute');
  });
});
