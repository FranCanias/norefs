import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import { applyFixes, isFixable, unremovableWrites } from '../src/engine/fix';
import type { Finding } from '../src/types';

function memberOf(findings: Finding[], name: string): Finding | undefined {
  return findings.find(f => f.kind === 'member' && f.name === name);
}

/** A hook that computes two colors into a value only its interface describes. */
function limiterProject(): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(
    '/colors.ts',
    ['export interface LimiterColors {', '  track: string;', '  thumb: string;', '}', ''].join('\n')
  );
  project.createSourceFile(
    '/hook.ts',
    [
      "import type { LimiterColors } from './colors';",
      'declare function useMemo<T>(factory: () => T, deps: unknown[]): T;',
      'export function useLimiterColors(): LimiterColors {',
      '  // the track reads darker in the dark theme',
      '  const track = "a";',
      '  const thumb = "b";',
      '  return useMemo(() => ({ track, thumb }), []);',
      '}',
      '',
    ].join('\n')
  );
  project.createSourceFile(
    '/index.ts',
    [
      "import { useLimiterColors } from './hook';",
      "import type { LimiterColors } from './colors';",
      'declare const colors: LimiterColors;',
      'useLimiterColors();',
      'export const read = () => colors.thumb;',
      '',
    ].join('\n')
  );
  return project;
}

describe('--fix-unsafe on a proven write-only member', () => {
  it('retires the member together with the write that proves it', () => {
    const project = limiterProject();
    const findings = analyze(project);
    const member = memberOf(findings, 'track');
    expect(member?.verdict).toBe('write-only');
    expect(member?.evidence).toContain('a typed write at');

    const result = applyFixes(findings, { save: false, unsafe: true });
    const declaration = project.getSourceFileOrThrow('/colors.ts').getFullText();
    const producer = project.getSourceFileOrThrow('/hook.ts').getFullText();
    // The claim and its proof go together: no stranded write survives in a
    // literal no named type describes.
    expect(declaration).not.toContain('track');
    expect(producer).not.toContain('{ track, thumb }');
    expect(producer).toContain('thumb');
    expect(result.filePaths).toContain('/hook.ts');
  });

  it('leaves nothing the next run cannot see', () => {
    const project = limiterProject();
    applyFixes(analyze(project), { save: false, unsafe: true });
    // Run the tool on its own output: the fixed slice is gone, not hidden in
    // an anonymous literal the default filters skip.
    const after = analyze(project);
    expect(memberOf(after, 'track')).toBeUndefined();
    expect(project.getSourceFileOrThrow('/hook.ts').getFullText()).not.toContain('const track');
  });

  it('retires two members that share one literal', () => {
    // Both writes live in the same object literal, and each removal
    // invalidates nodes the other fix holds. The pass must survive that.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/colors.ts',
      ['export interface LimiterColors {', '  track: string;', '  thumb: string;', '  border: string;', '}', ''].join(
        '\n'
      )
    );
    project.createSourceFile(
      '/hook.ts',
      [
        "import type { LimiterColors } from './colors';",
        'declare function useMemo<T>(factory: () => T, deps: unknown[]): T;',
        'export function useLimiterColors(): LimiterColors {',
        '  const track = "a";',
        '  const thumb = "b";',
        '  return useMemo(() => ({ track, thumb, border: "c" }), []);',
        '}',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/index.ts',
      [
        "import { useLimiterColors } from './hook';",
        "import type { LimiterColors } from './colors';",
        'declare const colors: LimiterColors;',
        'useLimiterColors();',
        'export const read = () => colors.border;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    expect(memberOf(findings, 'track')?.verdict).toBe('write-only');
    expect(memberOf(findings, 'thumb')?.verdict).toBe('write-only');

    applyFixes(findings, { save: false, unsafe: true });
    const declaration = project.getSourceFileOrThrow('/colors.ts').getFullText();
    const producer = project.getSourceFileOrThrow('/hook.ts').getFullText();
    expect(declaration).toContain('border: string;');
    expect(declaration).not.toContain('track');
    expect(declaration).not.toContain('thumb');
    expect(producer).toContain('{ border: "c" }');
    expect(producer).not.toContain('const track');
    expect(producer).not.toContain('const thumb');
  });

  it('takes the stale dependency entry with the local it kept alive', () => {
    // The React shape the feature exists for: `useMemo(() => ({ track }), [track])`.
    // Leave the dependency entry and the local stays "used" for norefs and for
    // noUnusedLocals alike — the computation survives with no consumer and no
    // check that can ever see it again.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/colors.ts',
      ['export interface LimiterColors {', '  track: string;', '  thumb: string;', '}', ''].join('\n')
    );
    project.createSourceFile(
      '/hook.ts',
      [
        "import type { LimiterColors } from './colors';",
        'declare function useMemo<T>(factory: () => T, deps: unknown[]): T;',
        'declare function theme(name: string): string;',
        'export function useLimiterColors(): LimiterColors {',
        '  const track = theme("track");',
        '  const thumb = theme("thumb");',
        '  return useMemo(() => ({ track, thumb }), [track, thumb]);',
        '}',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/index.ts',
      [
        "import { useLimiterColors } from './hook';",
        "import type { LimiterColors } from './colors';",
        'declare const colors: LimiterColors;',
        'useLimiterColors();',
        'export const read = () => colors.thumb;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    expect(memberOf(findings, 'track')?.verdict).toBe('write-only');

    applyFixes(findings, { save: false, unsafe: true });
    const producer = project.getSourceFileOrThrow('/hook.ts').getFullText();
    expect(producer).not.toContain('const track');
    expect(producer).toContain('useMemo(() => ({ thumb }), [thumb])');
    // And the whole chain is gone for good: a second run finds nothing left
    // to see, because nothing dead is left.
    expect(memberOf(analyze(project), 'track')).toBeUndefined();
  });

  it('leaves the local alone while the factory still reads it', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/colors.ts',
      ['export interface LimiterColors {', '  track: string;', '  thumb: string;', '}', ''].join('\n')
    );
    project.createSourceFile(
      '/hook.ts',
      [
        "import type { LimiterColors } from './colors';",
        'declare function useMemo<T>(factory: () => T, deps: unknown[]): T;',
        'declare function theme(name: string): string;',
        'export function useLimiterColors(): LimiterColors {',
        '  const track = theme("track");',
        '  return useMemo(() => ({ track, thumb: track.toUpperCase() }), [track]);',
        '}',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/index.ts',
      [
        "import { useLimiterColors } from './hook';",
        "import type { LimiterColors } from './colors';",
        'declare const colors: LimiterColors;',
        'useLimiterColors();',
        'export const read = () => colors.thumb;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    expect(memberOf(findings, 'track')?.verdict).toBe('write-only');

    applyFixes(findings, { save: false, unsafe: true });
    const producer = project.getSourceFileOrThrow('/hook.ts').getFullText();
    // The write goes; the local and its dependency stay, because the factory
    // still reads them. A dependency is only stale once nothing reads it.
    expect(producer).toContain('const track');
    expect(producer).toContain('({ thumb: track.toUpperCase() }), [track])');
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
        'export const read = () => payload.used;',
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
        'export const read = () => payload.used;',
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
        'export const read = (c: Config) => c.retries;',
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
