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

  it('types passed to Object.keys are skipped, no keyof cast needed', () => {
    expect(reportedIn('object-keys-plain.ts')).toEqual([]);
  });

  it('types enumerated by for...in are skipped', () => {
    expect(reportedIn('for-in.ts')).toEqual([]);
  });

  it('a literal "name" in v probe marks exactly that property used', () => {
    expect(reportedIn('in-operator-literal.ts')).toEqual(['deadProp']);
  });

  it('a dynamic key in v probe skips the whole type', () => {
    expect(reportedIn('in-operator-dynamic.ts')).toEqual([]);
  });

  it('types serialized wholesale (JSON.stringify) are skipped', () => {
    expect(reportedIn('serialized.ts')).toEqual([]);
  });

  it('whole-binding params forwarded into differently-declared types are skipped', () => {
    expect(reportedIn('forwarded-param.ts')).toEqual([]);
  });

  it('whole-binding variables that escape are skipped', () => {
    expect(reportedIn('forwarded-var.ts')).toEqual([]);
  });

  it('explicit return types on functions whose result escapes are skipped', () => {
    expect(reportedIn('explicit-return-escape.ts')).toEqual([]);
  });

  it('params of function types stay silent; implementations bind separately', () => {
    expect(reportedIn('callback-type-params.ts')).toEqual([]);
  });

  it('params with only local property reads still report', () => {
    expect(reportedIn('param-stays-local.ts')).toEqual(['deadProp']);
  });

  it('nested literals under a property forwarded wholesale are skipped', () => {
    expect(reportedIn('forwarded-property.ts')).toEqual([]);
  });

  it('nested literals under a property with only local reads still report', () => {
    expect(reportedIn('local-property.ts')).toEqual(['deadOption']);
  });

  it('suppression cascades into literals nested in a keyof-targeted alias', () => {
    expect(reportedIn('nested-command-map.ts')).toEqual([]);
  });

  it('suppression cascades into literals nested in a serialized interface', () => {
    expect(reportedIn('nested-serialized.ts')).toEqual([]);
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
