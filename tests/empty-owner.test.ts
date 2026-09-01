import { describe, expect, it } from 'vitest';
import { isFixable } from '../src/engine/fix';
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
    const emptied = findings.find(f => f.kind === 'empty-type');
    expect(emptied?.context).toBe('interface');
    expect(emptied?.swallowed).toBe(2);
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
    const emptied = findings.find(f => f.kind === 'empty-type');
    expect(emptied?.context).toBe('type');
    expect(emptied?.swallowed).toBe(1);
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

describe('emptied nested shapes', () => {
  it('reports the property holding a literal that loses every member', () => {
    const findings = analyzeSource(
      [
        'const boxDefaults = {',
        '  shelves: 3,',
        '  labels: {',
        "    deadColor: 'red',",
        "    deadFont: 'serif',",
        '  },',
        '};',
        'export function shelves(): number {',
        '  return boxDefaults.shelves;',
        '}',
        'export function labelled(): boolean {',
        '  const { labels } = boxDefaults;',
        '  return labels ? true : false;',
        '}',
        '',
      ].join('\n')
    );
    // One death, told once, on the node a reader would delete. Without the
    // fold, --fix empties the brackets and leaves `labels: {}` behind.
    expect(findings.map(f => [f.kind, f.name])).toEqual([['empty-type', 'labels']]);
    const emptied = findings.find(f => f.kind === 'empty-type');
    expect(emptied?.context).toBe('property');
    expect(emptied?.swallowed).toBe(2);
    expect(emptied?.line).toBe(3);
    // The literal is named by the const that holds it, so the fold is too.
    expect(emptied?.anonymous).toBe(false);
  });

  it('reports the property holding a type literal that loses every member', () => {
    const findings = analyzeSource(
      [
        'interface RecipeCard {',
        '  title: string;',
        '  print: {',
        '    deadMargin: number;',
        '    deadPaper: string;',
        '  };',
        '}',
        'export function label(card: RecipeCard): string {',
        '  const { print } = card;',
        "  return print ? card.title : '';",
        '}',
        '',
      ].join('\n')
    );
    expect(findings.map(f => [f.kind, f.name])).toEqual([['empty-type', 'print']]);
    const emptied = findings.find(f => f.kind === 'empty-type');
    expect(emptied?.context).toBe('property');
    // An inline type has no name of its own, so --anon hides the fold exactly
    // where it hid the members that folded in.
    expect(emptied?.anonymous).toBe(true);
  });

  it('folds the innermost shape only, leaving the property that still reads', () => {
    const findings = analyzeSource(
      [
        'const boxDefaults = {',
        '  shelves: 3,',
        '  labels: {',
        '    print: {',
        '      deadMargin: 1,',
        '      deadPaper: 2,',
        '    },',
        '  },',
        '};',
        'export function shelves(): number {',
        '  return boxDefaults.shelves;',
        '}',
        'export function printed(): boolean {',
        '  const { print } = boxDefaults.labels;',
        '  return print ? true : false;',
        '}',
        '',
      ].join('\n')
    );
    // `labels` keeps a property something reads, so only `print` empties.
    expect(findings.map(f => [f.kind, f.name])).toEqual([['empty-type', 'print']]);
  });

  it('stays silent when the shape keeps a member', () => {
    const findings = analyzeSource(
      [
        'const boxDefaults = {',
        '  labels: {',
        "    color: 'red',",
        "    deadFont: 'serif',",
        '  },',
        '};',
        'export function color(): string {',
        '  return boxDefaults.labels.color;',
        '}',
        '',
      ].join('\n')
    );
    expect(findings.map(f => [f.kind, f.name])).toEqual([['member', 'deadFont']]);
  });

  it('stays silent when a spread carries members the fold cannot account for', () => {
    const findings = analyzeSource(
      [
        "const base = { paper: 'a4' };",
        'const boxDefaults = {',
        '  shelves: 3,',
        "  labels: { ...base, deadFont: 'serif' },",
        '};',
        'export function shelves(): number {',
        '  return boxDefaults.shelves;',
        '}',
        'export function labelled(): boolean {',
        '  const { labels } = boxDefaults;',
        '  return labels ? true : false;',
        '}',
        '',
      ].join('\n')
    );
    // Removing `labels` would take the spread's members with it, so the one
    // member norefs can account for answers on its own.
    expect(findings.map(f => [f.kind, f.name])).toEqual([['member', 'deadFont']]);
  });

  it('leaves the property alone: --fix never empties a shape it reported whole', () => {
    const findings = analyzeSource(
      [
        'const boxDefaults = {',
        '  shelves: 3,',
        "  labels: { deadColor: 'red' },",
        '};',
        'export function shelves(): number {',
        '  return boxDefaults.shelves;',
        '}',
        'export function labelled(): boolean {',
        '  const { labels } = boxDefaults;',
        '  return labels ? true : false;',
        '}',
        '',
      ].join('\n')
    );
    // The read that reached nothing is still there, so the edit is a human's
    // to make — the same answer an emptied interface gets.
    expect(findings.every(f => !isFixable(f, true))).toBe(true);
  });
});

describe('emptied top-level bindings', () => {
  it('folds a const object whose shape empties onto the binding', () => {
    const findings = analyzeSource(
      [
        'const box = {',
        '  deadColor: 1,',
        '  deadFont: 2,',
        '};',
        'export function legacy(): boolean {',
        "  return 'legacy' in box;",
        '}',
        '',
      ].join('\n')
    );
    expect(findings.map(f => [f.kind, f.name])).toEqual([['empty-type', 'box']]);
    const emptied = findings.find(f => f.kind === 'empty-type');
    expect(emptied?.context).toBe('const');
    expect(emptied?.swallowed).toBe(2);
    // The probe still reaches the binding, and only a person knows what for.
    expect(findings.some(f => isFixable(f, false))).toBe(false);
  });

  it('folds an array binding once, counting what the shape offers', () => {
    const findings = analyzeSource(
      [
        'const cards = [',
        "  { deadNote: 'draft' },",
        "  { deadNote: 'draft' },",
        '];',
        'export function count(): number {',
        '  return cards.length;',
        '}',
        '',
      ].join('\n')
    );
    expect(findings.map(f => [f.kind, f.name])).toEqual([['empty-type', 'cards']]);
    // Two elements writing one key offer one member between them.
    expect(findings.find(f => f.kind === 'empty-type')?.swallowed).toBe(1);
  });

  it('leaves a binding nothing reads to the members, so the whole const can go', () => {
    const findings = analyzeSource(
      [
        'const box = {',
        '  deadColor: 1,',
        '  deadFont: 2,',
        '};',
        'export function unrelated(): number {',
        '  return 1;',
        '}',
        '',
      ].join('\n')
    );
    // No reader survives the removal, so `--fix` takes the declaration whole.
    expect(findings.map(f => [f.kind, f.name])).toEqual([
      ['member', 'deadColor'],
      ['member', 'deadFont'],
    ]);
    expect(findings.every(f => isFixable(f, false))).toBe(true);
  });

  it('leaves a binding alone while one member still lives', () => {
    const findings = analyzeSource(
      [
        'const box = {',
        '  live: 1,',
        '  deadFont: 2,',
        '};',
        'export function color(): number {',
        '  return box.live;',
        '}',
        '',
      ].join('\n')
    );
    expect(findings.map(f => [f.kind, f.name])).toEqual([['member', 'deadFont']]);
  });
});
