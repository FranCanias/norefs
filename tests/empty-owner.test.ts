import { describe, expect, it } from 'vitest';
import { analyzeSource } from './helpers';

describe('empty-owner findings', () => {
  it('reports an interface that becomes empty when all its members are unused', () => {
    const findings = analyzeSource(
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
    // The member findings fold into the one logical finding.
    expect(findings.map(f => [f.kind, f.name])).toEqual([['empty-type', 'Zone']]);
    expect(findings[0].context).toBe('interface');
    expect(findings[0].swallowed).toBe(2);
  });

  it('reports a type alias that becomes empty', () => {
    const findings = analyzeSource(
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
    expect(findings.map(f => [f.kind, f.name])).toEqual([['empty-type', 'Options']]);
    expect(findings[0].context).toBe('type');
    expect(findings[0].swallowed).toBe(1);
  });

  it('stays silent when some member is used', () => {
    const findings = analyzeSource(
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
    const findings = analyzeSource(
      ['interface Ghost {', '  dead: number;', '}', 'export const keep = 1;', ''].join('\n')
    );
    expect(findings.map(f => [f.kind, f.name])).toEqual([['member', 'dead']]);
  });

  it('stays silent for an interface that extends another', () => {
    const findings = analyzeSource(
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
