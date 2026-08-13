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
