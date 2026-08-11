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

  it('cast values spread into a combined array are skipped', () => {
    expect(reportedIn('array-spread-union.ts')).toEqual([]);
  });

  it('cast values with only local reads and boolean tests still report', () => {
    expect(reportedIn('cast-stays-local.ts')).toEqual(['deadFlag']);
  });
});

describe('assignability constraints (zero-reference members stay when required)', () => {
  it('an extends override keeps the substituted type assignable to the base member', () => {
    expect(reportedIn('heritage-override.ts')).toEqual(['deadExtra']);
  });

  it('a type predicate keeps the narrowed type assignable to its parameter', () => {
    expect(reportedIn('predicate-narrow.ts')).toEqual(['deadRadius']);
  });
});

describe('enum members', () => {
  it('reports members with no references', () => {
    expect(reportedIn('enum-basic.ts')).toEqual(['Dead']);
  });

  it('enums passed to Object.values are skipped', () => {
    expect(reportedIn('enum-object-values.ts')).toEqual([]);
  });

  it('enums targeted by keyof typeof are skipped', () => {
    expect(reportedIn('enum-keyof-typeof.ts')).toEqual([]);
  });

  it('enums element-accessed with a dynamic key (reverse mapping) are skipped', () => {
    expect(reportedIn('enum-reverse-map.ts')).toEqual([]);
  });
});

describe('class members', () => {
  it('reports properties, methods, and getters with no references', () => {
    expect(reportedIn('class-basic.ts')).toEqual(['deadGetter', 'deadMethod', 'deadProp']);
  });

  it('members reached through an interface or base type count as used', () => {
    expect(reportedIn('class-implemented.ts')).toEqual([]);
    expect(reportedIn('class-override.ts')).toEqual([]);
  });

  it('decorated classes are skipped entirely', () => {
    expect(reportedIn('class-decorated.ts')).toEqual([]);
  });

  it('serialized instances suppress the class and its base', () => {
    expect(reportedIn('class-serialized.ts')).toEqual([]);
    expect(reportedIn('class-serialized-inherited.ts')).toEqual([]);
  });

  it('static members are checked like instance members', () => {
    expect(reportedIn('class-static.ts')).toEqual(['deadStatic']);
  });

  it('parameter properties are checked', () => {
    expect(reportedIn('class-param-props.ts')).toEqual(['deadDep']);
  });

  it('reads through a spread copy resolve back to class members', () => {
    expect(reportedIn('class-spread.ts')).toEqual(['deadCoord']);
  });

  it('classes targeted by keyof are skipped', () => {
    expect(reportedIn('class-keyof.ts')).toEqual([]);
  });

  it('structural implementations (instances escape into an undeclared interface) are skipped', () => {
    expect(reportedIn('class-structural.ts')).toEqual([]);
    expect(reportedIn('class-structural-var.ts')).toEqual([]);
  });

  it('a declared implements clause keeps member tracking alive', () => {
    expect(reportedIn('class-declared-heritage.ts')).toEqual(['deadHelper']);
  });

  it('classes passed around as values are skipped', () => {
    expect(reportedIn('class-value-escape.ts')).toEqual([]);
  });

  it('a subclass escaping structurally silences its base class too', () => {
    expect(reportedIn('class-derived-escape.ts')).toEqual([]);
  });

  it('instances returned from a method of an escaping class are laundered too', () => {
    expect(reportedIn('class-returned-from-structural.ts')).toEqual([]);
  });

  it('instances returned from a method of a tracked class stay tracked', () => {
    expect(reportedIn('class-returned-from-tracked.ts')).toEqual(['deadBrake']);
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
