import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';

function findingsOf(source: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile('/main.ts', source);
  return analyze(project);
}

describe('empty-owner findings', () => {
  it('reports an interface that becomes empty when all its members are unused', () => {
    const findings = findingsOf(
      [
        'interface Zone {',
        '  dead1: number;',
        '  dead2: number;',
        '}',
        'export function useZone(zone: Zone): number {',
        '  return 0;',
        '}',
        '',
      ].join('\n')
    );
    expect(findings.map(f => [f.kind, f.name])).toEqual([
      ['empty-type', 'Zone'],
      ['member', 'dead1'],
      ['member', 'dead2'],
    ]);
    expect(findings[0].context).toBe('interface');
  });

  it('reports a type alias that becomes empty', () => {
    const findings = findingsOf(
      [
        'type Options = {',
        '  verbose: boolean;',
        '};',
        'export function useOptions(options: Options): number {',
        '  return 0;',
        '}',
        '',
      ].join('\n')
    );
    expect(findings.map(f => [f.kind, f.name])).toEqual([
      ['empty-type', 'Options'],
      ['member', 'verbose'],
    ]);
    expect(findings[0].context).toBe('type');
  });

  it('stays silent when some member is used', () => {
    const findings = findingsOf(
      [
        'interface Partial1 {',
        '  used: number;',
        '  dead: number;',
        '}',
        'export function usePartial(v: Partial1): number {',
        '  return v.used;',
        '}',
        '',
      ].join('\n')
    );
    expect(findings.map(f => [f.kind, f.name])).toEqual([['member', 'dead']]);
  });

  it('stays silent when nothing references the type', () => {
    const findings = findingsOf(['interface Ghost {', '  dead: number;', '}', 'export const keep = 1;', ''].join('\n'));
    expect(findings.map(f => [f.kind, f.name])).toEqual([['member', 'dead']]);
  });

  it('stays silent for an interface that extends another', () => {
    const findings = findingsOf(
      [
        'interface Base {',
        '  kept: number;',
        '}',
        'interface Derived extends Base {',
        '  extra: string;',
        '}',
        'export function useDerived(d: Derived): number {',
        '  return d.kept;',
        '}',
        '',
      ].join('\n')
    );
    expect(findings.map(f => [f.kind, f.name])).toEqual([['member', 'extra']]);
  });
});
