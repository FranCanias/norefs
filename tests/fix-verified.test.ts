/** biome-ignore-all lint/suspicious/noEmptyBlockStatements: Test file */
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import { applyVerifiedFixes } from '../src/engine/fix-verified';

/**
 * Three dead exports in lib.ts. The probe plays the part of a build that
 * secretly depends on `keepMe`: it fails whenever that function is gone.
 */
function setup() {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile('/main.ts', "import { used } from './lib';\nused();\n");
  const lib = project.createSourceFile(
    '/lib.ts',
    [
      'export function used(): void {}',
      'export function keepMe(): number {',
      '  return 1;',
      '}',
      'export function other(): number {',
      '  return 2;',
      '}',
      'export function third(): number {',
      '  return 3;',
      '}',
      '',
    ].join('\n')
  );
  return { project, lib };
}

describe('applyVerifiedFixes', () => {
  it('fixes everything when the probe stays green', () => {
    const { project, lib } = setup();
    const result = applyVerifiedFixes({
      project,
      findings: analyze(project),
      reanalyze: () => analyze(project),
      unsafe: false,
      verify: false,
      check: () => [],
      cwd: '/',
      log: () => {},
    });
    expect(result.fixed).toBe(3);
    expect(result.heldBack).toEqual([]);
    expect(lib.getFullText()).not.toContain('keepMe');
    // Nothing saved: disk is the caller's call.
    expect(() => project.getFileSystem().readFileSync('/lib.ts')).toThrow();
  });

  it('bisects to the fix that breaks the probe and holds only it back', () => {
    const { project, lib } = setup();
    const result = applyVerifiedFixes({
      project,
      findings: analyze(project),
      reanalyze: () => analyze(project),
      unsafe: false,
      verify: false,
      check: p => (p.getSourceFile('/lib.ts')?.getFullText().includes('function keepMe') ? [] : ['keepMe is gone']),
      cwd: '/',
      log: () => {},
    });
    expect(result.aborted).toBeUndefined();
    expect(result.heldBack.map(h => h.finding.name)).toEqual(['keepMe']);
    expect(result.heldBack[0].errors).toEqual(['keepMe is gone']);
    const text = lib.getFullText();
    expect(text).toContain('function keepMe');
    expect(text).not.toContain('other');
    expect(text).not.toContain('third');
    expect(result.fixed).toBe(2);
  });

  it('aborts pristine when the probe fails even with nothing fixed', () => {
    const { project, lib } = setup();
    const before = lib.getFullText();
    const result = applyVerifiedFixes({
      project,
      findings: analyze(project),
      reanalyze: () => analyze(project),
      unsafe: false,
      verify: false,
      check: () => ['the build was already broken'],
      cwd: '/',
      log: () => {},
    });
    expect(result.aborted).toBeDefined();
    expect(result.fixed).toBe(0);
    expect(lib.getFullText()).toBe(before);
  });
});
