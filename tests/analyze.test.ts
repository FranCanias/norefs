import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import { loadProject } from '../src/engine/project';

const project = loadProject(path.resolve('tests/fixtures/tsconfig.json'));
const findings = analyze(project);

function reportedIn(fixture: string): string[] {
  return findings
    .filter(f => f.filePath.endsWith(`/${fixture}`))
    .map(f => f.propertyName)
    .sort();
}

describe('usage patterns the reference check resolves (no false positives)', () => {
  it('dot access', () => {
    expect(reportedIn('dot-access.ts')).toEqual(['deadProp']);
  });

  it('string-literal element access', () => {
    expect(reportedIn('string-index.ts')).toEqual(['deadProp']);
  });

  it('destructuring in params and bodies', () => {
    expect(reportedIn('destructuring.ts')).toEqual(['deadProp']);
  });

  it('spreads into same-typed and fresh object types', () => {
    expect(reportedIn('spread.ts')).toEqual(['deadProp']);
  });

  it('mapped types (Partial, Pick)', () => {
    expect(reportedIn('mapped-types.ts')).toEqual(['deadProp']);
  });

  it('interface inheritance', () => {
    expect(reportedIn('inheritance.ts')).toEqual(['deadProp']);
  });

  it('usage from another file', () => {
    expect(reportedIn('cross-file-def.ts')).toEqual(['deadProp']);
    expect(reportedIn('cross-file-use.ts')).toEqual([]);
  });

  it('quoted property names', () => {
    expect(reportedIn('quoted-names.ts')).toEqual(["'evt:dead'"]);
  });

  it('returned object with only local property reads', () => {
    expect(reportedIn('returned-object-clean.ts')).toEqual(['deadProp']);
  });
});

describe('dynamic-consumption guards (stay silent rather than guess)', () => {
  it('types targeted by keyof are skipped entirely', () => {
    expect(reportedIn('keyof-generic.ts')).toEqual([]);
    expect(reportedIn('dynamic-keys.ts')).toEqual([]);
  });

  it('returned objects that escape wholesale (JSON.stringify) are skipped', () => {
    expect(reportedIn('returned-object.ts')).toEqual([]);
  });
});

describe('documented blind spots', () => {
  it('interface members mirrored by an implementing class are never reported', () => {
    // The class declaration counts as a reference; class members are out of scope here.
    expect(reportedIn('implemented.ts')).toEqual([]);
  });

  it('write-only properties count as used', () => {
    // writeOnlyRet is assigned in the return literal but never read; the write
    // is a reference, so it is not reported.
    expect(reportedIn('type-literal-alias.ts')).toEqual(['deadProp']);
  });
});
