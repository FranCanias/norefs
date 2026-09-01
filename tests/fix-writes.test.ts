import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import { applyFixes, isFixable, unremovableWrites } from '../src/engine/fix';
import type { Finding } from '../src/types';

function memberOf(findings: Finding[], name: string): Finding | undefined {
  return findings.find(f => f.kind === 'member' && f.name === name);
}

/** A hook that computes two colors into a value only its interface describes. */
function legendProject(): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(
    '/colors.ts',
    ['export interface LegendColors {', '  stroke: string;', '  fill: string;', '}', ''].join('\n')
  );
  project.createSourceFile(
    '/hook.ts',
    [
      "import type { LegendColors } from './colors';",
      'declare function useMemo<T>(factory: () => T, deps: unknown[]): T;',
      'export function useLegendColors(): LegendColors {',
      '  // the stroke reads darker in the dark theme',
      '  const stroke = "a";',
      '  const fill = "b";',
      '  return useMemo(() => ({ stroke, fill }), []);',
      '}',
      '',
    ].join('\n')
  );
  project.createSourceFile(
    '/index.ts',
    [
      "import { useLegendColors } from './hook';",
      "import type { LegendColors } from './colors';",
      'declare const colors: LegendColors;',
      'useLegendColors();',
      'export const read = () => colors.fill;',
      '',
    ].join('\n')
  );
  return project;
}

describe('--fix-unsafe on a proven write-only member', () => {
  it('retires the member together with the write that proves it', () => {
    const project = legendProject();
    const findings = analyze(project);
    const member = memberOf(findings, 'stroke');
    expect(member?.verdict).toBe('write-only');
    expect(member?.evidence).toContain('a typed write at');

    const result = applyFixes(findings, { save: false, unsafe: true });
    const declaration = project.getSourceFileOrThrow('/colors.ts').getFullText();
    const producer = project.getSourceFileOrThrow('/hook.ts').getFullText();
    // The claim and its proof go together: no stranded write survives in a
    // literal no named type describes.
    expect(declaration).not.toContain('stroke');
    expect(producer).not.toContain('{ stroke, fill }');
    expect(producer).toContain('fill');
    expect(result.filePaths).toContain('/hook.ts');
  });

  it('leaves nothing the next run cannot see', () => {
    const project = legendProject();
    applyFixes(analyze(project), { save: false, unsafe: true });
    // Run the tool on its own output: the fixed slice is gone, not hidden in
    // an anonymous literal the default filters skip.
    const after = analyze(project);
    expect(memberOf(after, 'stroke')).toBeUndefined();
    expect(project.getSourceFileOrThrow('/hook.ts').getFullText()).not.toContain('const stroke');
  });

  it('retires two members that share one literal', () => {
    // Both writes live in the same object literal, and each removal
    // invalidates nodes the other fix holds. The pass must survive that.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/colors.ts',
      ['export interface LegendColors {', '  stroke: string;', '  fill: string;', '  frame: string;', '}', ''].join(
        '\n'
      )
    );
    project.createSourceFile(
      '/hook.ts',
      [
        "import type { LegendColors } from './colors';",
        'declare function useMemo<T>(factory: () => T, deps: unknown[]): T;',
        'export function useLegendColors(): LegendColors {',
        '  const stroke = "a";',
        '  const fill = "b";',
        '  return useMemo(() => ({ stroke, fill, frame: "c" }), []);',
        '}',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/index.ts',
      [
        "import { useLegendColors } from './hook';",
        "import type { LegendColors } from './colors';",
        'declare const colors: LegendColors;',
        'useLegendColors();',
        'export const read = () => colors.frame;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    expect(memberOf(findings, 'stroke')?.verdict).toBe('write-only');
    expect(memberOf(findings, 'fill')?.verdict).toBe('write-only');

    applyFixes(findings, { save: false, unsafe: true });
    const declaration = project.getSourceFileOrThrow('/colors.ts').getFullText();
    const producer = project.getSourceFileOrThrow('/hook.ts').getFullText();
    expect(declaration).toContain('frame: string;');
    expect(declaration).not.toContain('stroke');
    expect(declaration).not.toContain('fill');
    expect(producer).toContain('{ frame: "c" }');
    expect(producer).not.toContain('const stroke');
    expect(producer).not.toContain('const fill');
  });

  it('takes the stale dependency entry with the local it kept alive', () => {
    // The React shape the feature exists for: `useMemo(() => ({ stroke }), [stroke])`.
    // Leave the dependency entry and the local stays "used" for norefs and for
    // noUnusedLocals alike — the computation survives with no consumer and no
    // check that can ever see it again.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/colors.ts',
      ['export interface LegendColors {', '  stroke: string;', '  fill: string;', '}', ''].join('\n')
    );
    project.createSourceFile(
      '/hook.ts',
      [
        "import type { LegendColors } from './colors';",
        'declare function useMemo<T>(factory: () => T, deps: unknown[]): T;',
        'declare function theme(name: string): string;',
        'export function useLegendColors(): LegendColors {',
        '  const stroke = theme("stroke");',
        '  const fill = theme("fill");',
        '  return useMemo(() => ({ stroke, fill }), [stroke, fill]);',
        '}',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/index.ts',
      [
        "import { useLegendColors } from './hook';",
        "import type { LegendColors } from './colors';",
        'declare const colors: LegendColors;',
        'useLegendColors();',
        'export const read = () => colors.fill;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    expect(memberOf(findings, 'stroke')?.verdict).toBe('write-only');

    applyFixes(findings, { save: false, unsafe: true });
    const producer = project.getSourceFileOrThrow('/hook.ts').getFullText();
    expect(producer).not.toContain('const stroke');
    expect(producer).toContain('useMemo(() => ({ fill }), [fill])');
    // And the whole chain is gone for good: a second run finds nothing left
    // to see, because nothing dead is left.
    expect(memberOf(analyze(project), 'stroke')).toBeUndefined();
  });

  it('leaves the local alone while the factory still reads it', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/colors.ts',
      ['export interface LegendColors {', '  stroke: string;', '  fill: string;', '}', ''].join('\n')
    );
    project.createSourceFile(
      '/hook.ts',
      [
        "import type { LegendColors } from './colors';",
        'declare function useMemo<T>(factory: () => T, deps: unknown[]): T;',
        'declare function theme(name: string): string;',
        'export function useLegendColors(): LegendColors {',
        '  const stroke = theme("stroke");',
        '  return useMemo(() => ({ stroke, fill: stroke.toUpperCase() }), [stroke]);',
        '}',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/index.ts',
      [
        "import { useLegendColors } from './hook';",
        "import type { LegendColors } from './colors';",
        'declare const colors: LegendColors;',
        'useLegendColors();',
        'export const read = () => colors.fill;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    expect(memberOf(findings, 'stroke')?.verdict).toBe('write-only');

    applyFixes(findings, { save: false, unsafe: true });
    const producer = project.getSourceFileOrThrow('/hook.ts').getFullText();
    // The write goes; the local and its dependency stay, because the factory
    // still reads them. A dependency is only stale once nothing reads it.
    expect(producer).toContain('const stroke');
    expect(producer).toContain('({ fill: stroke.toUpperCase() }), [stroke])');
  });

  it('takes the comment beside each write with the write', () => {
    // The 0.4.0 review's exhibit: a six-member color chain whose writes carry
    // a comment each. ts-morph removes a property without the trivia behind
    // it, so the comments used to pile up where a property belonged — the
    // third removal threw, and the two that had gone through left their
    // comments glued to a line they never described.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/colors.ts',
      [
        'export interface ChartColors {',
        '  canvas: string;',
        '  grid: string;',
        '  curve: string;',
        '  axis: string;',
        '}',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/hook.ts',
      [
        "import type { ChartColors } from './colors';",
        'declare function useMemo<T>(factory: () => T, deps: unknown[]): T;',
        'declare function theme(name: string): string;',
        'export function useChartColors(): ChartColors {',
        '  const canvas = theme("canvas");',
        '  const grid = theme("grid");',
        '  const curve = theme("curve");',
        '  return useMemo(',
        '    () => ({',
        '      canvas, // light: #F9F9FA, dark: #242424',
        '      // Grid - more visible in dark',
        '      grid, // light: #E6E7E8, dark: #383838',
        '      curve, // light: #94969D, dark: #FF9999',
        '      axis: "a",',
        '    }),',
        '    [canvas, grid, curve]',
        '  );',
        '}',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/index.ts',
      [
        "import { useChartColors } from './hook';",
        "import type { ChartColors } from './colors';",
        'declare const colors: ChartColors;',
        'useChartColors();',
        'export const read = () => colors.axis;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    expect(findings.filter(f => f.verdict === 'write-only').map(f => f.name)).toEqual(['canvas', 'grid', 'curve']);

    // The run completes — that is half the claim.
    applyFixes(findings, { save: false, unsafe: true });
    const producer = project.getSourceFileOrThrow('/hook.ts').getFullText();
    expect(producer).toContain('() => ({\n      axis: "a",\n    }),');
    expect(producer).toContain('[]');
    expect(producer).not.toContain('#F9F9FA');
    expect(producer).not.toContain('#E6E7E8');
    expect(producer).not.toContain('#FF9999');
    expect(producer).not.toContain('Grid - more visible');
    expect(project.getSourceFileOrThrow('/colors.ts').getFullText()).toBe(
      ['export interface ChartColors {', '  axis: string;', '}', ''].join('\n')
    );
  });

  it('keeps a comment that introduces the code after it on the line', () => {
    // `/* fallback */ used: 1` describes what follows it, not what precedes
    // it. The rule is "beside the property, with the line break behind it".
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface Payload {',
        '  extra: number;',
        '  used: number;',
        '}',
        'declare function wrap<T>(factory: () => T): T;',
        'declare function send(p: Payload): void;',
        'declare const payload: Payload;',
        'const value = wrap(() => ({ extra: 1, /* fallback */ used: 2 }));',
        'export const run = () => send(value);',
        'const read = () => payload.used;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    expect(memberOf(findings, 'extra')?.verdict).toBe('write-only');
    applyFixes(findings, { save: false, unsafe: true });
    const text = project.getSourceFileOrThrow('/main.ts').getFullText();
    expect(text).toContain('/* fallback */ used: 2');
    expect(text).not.toContain('extra');
  });

  it('keeps the finding when a write cannot be removed on its own', () => {
    // A spread carries members beyond this one. Deleting it would take live
    // code with it, so the fix refuses and names the write.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface Payload {',
        '  extra: number;',
        '  used: number;',
        '}',
        'declare function wrap<T>(factory: () => T): T;',
        'declare function send(p: Payload): void;',
        'declare const payload: Payload;',
        'declare const base: { extra: number };',
        'const value = wrap(() => ({ ...base, used: 1 }));',
        'export const run = () => send(value);',
        'const read = () => payload.used;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const member = memberOf(findings, 'extra');
    expect(member?.verdict).toBe('write-only');
    expect(member?.evidence).toContain('a typed write at');
    expect(member && unremovableWrites(member)).toHaveLength(1);
    expect(member && isFixable(member, true)).toBe(false);

    applyFixes(findings, { save: false, unsafe: true });
    const text = project.getSourceFileOrThrow('/main.ts').getFullText();
    expect(text).toContain('extra: number;');
    expect(text).toContain('...base');
  });

  it('still deletes a write-only member no write site proves', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface Config {',
        '  retries: number;',
        '  timeout: number;',
        '}',
        'const read = (c: Config) => c.retries;',
        'declare function stash(payload: unknown): void;',
        'stash({ timeout: 250 });',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const member = memberOf(findings, 'timeout');
    expect(member?.evidence).toContain('unverified name match');
    expect(member && isFixable(member, true)).toBe(true);
    applyFixes(findings, { save: false, unsafe: true });
    const text = project.getSourceFileOrThrow('/main.ts').getFullText();
    expect(text).not.toContain('timeout: number;');
    // The unproven name match is left where it is: nothing ties it to the member.
    expect(text).toContain('stash({ timeout: 250 })');
  });
});
