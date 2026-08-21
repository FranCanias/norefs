import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import { loadProject } from '../src/engine/project';
import type { Finding } from '../src/types';
import { fixture } from './helpers';

const fixturesDir = fixture('fixtures');
const project = loadProject([fixture('fixtures', 'tsconfig.json')]);
// main.ts imports every fixture for its side effects, so the files are
// reachable without becoming entry points themselves. An entry's exports are
// public API — members included — and would hide the member findings these
// tests assert on.
const findings = analyze(project, { rootDirs: [fixturesDir] });

function reportedIn(fixture: string): string[] {
  return findings
    .filter(f => f.kind === 'member' && f.filePath.endsWith(`/${fixture}`))
    .map(f => f.name)
    .sort();
}

function findingFor(fixture: string, name: string): Finding | undefined {
  return findings.find(f => f.kind === 'member' && f.filePath.endsWith(`/${fixture}`) && f.name === name);
}

function verdictIn(fixture: string, name: string): string | undefined {
  return findingFor(fixture, name)?.verdict;
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

  it('a literal nested in a returned object, reached through a read path', () => {
    expect(reportedIn('returned-object-nested.ts')).toEqual(['deadMinServings']);
  });

  it('a nested literal with a declared shape is reported on that type', () => {
    expect(reportedIn('returned-object-nested-typed.ts')).toEqual(['deadHalf']);
  });

  it("a returned object keeps the rest reportable when `'name' in box` probes one key", () => {
    expect(reportedIn('returned-object-probe.ts')).toEqual(['deadLining']);
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

describe('type-level reads (the type system reads it, the runtime never does)', () => {
  it('a conditional-type filter reads the names it matches on, both sides', () => {
    // `kind` and `channel` are named by a filter literal, so they stay on the
    // filter and on the types it matches. The members beside them still go.
    expect(reportedIn('conditional-filter.ts')).toEqual(['deadDay', 'deadTimestamp']);
  });

  it('a filter reads a name it nests, on the type that holds it', () => {
    // `kind` sits inside `payload`, so it is read on the payload types — and on
    // both of them, because either branch is what the filter has to tell apart.
    expect(reportedIn('nested-filter.ts')).toEqual(['deadNote', 'deadReason']);
  });

  it('a filter and the property it names shed their array together', () => {
    // `{ steps: { done: true }[] }` against `Step[]` reads `done` on `Step`.
    // Written without the array it matches nothing, so it reads nothing —
    // shedding one side alone credited `ready` from a filter that can never
    // select, and `Batch` kept a member nobody reads.
    expect(reportedIn('array-filter.ts')).toEqual(['deadCount', 'deadNote', 'ready']);
  });

  it("a predicate's asserted literal reads the name it narrows", () => {
    expect(reportedIn('predicate-literal.ts')).toEqual(['deadWeight']);
  });

  it('a written type argument reads the names its constraint requires', () => {
    expect(reportedIn('constraint-argument.ts')).toEqual(['deadRank']);
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

describe('sinks reached through a helper', () => {
  it('silences the types a relaying parameter carries in', () => {
    // The `Object.keys` inside `dump` sees only `T`. The concrete type is at
    // the call site, through one hop, two hops, a method, or a relay that
    // calls itself — and so is the decision to stay quiet about it.
    expect(reportedIn('relayed-sink.ts')).toEqual([]);
  });

  it('silences what a relay handed on as a value will be given', () => {
    // `sittings.forEach(dump)` writes no argument down. The position says what
    // arrives — the array's element type, the declared option's parameter —
    // and both go quiet. A callback with no sink in it relays nothing.
    expect(reportedIn('relayed-sink-callback.ts')).toEqual(['deadAroma']);
  });

  it('silences the relaying parameter and nothing beside it', () => {
    // `quietSubtitle` rode in on the relay. `deadColor` fed the parameter next
    // to it, and `deadPlating` went through a helper with no sink in it —
    // neither of those buys a type its silence.
    expect(reportedIn('relayed-sink-narrow.ts')).toEqual(['deadColor', 'deadPlating']);
  });
});

describe('const object members', () => {
  it('reports a member of an `as const` object that nothing reads', () => {
    // The enum modern TypeScript writes, and the same question asked of it.
    expect(reportedIn('const-object-basic.ts')).toEqual(['CHART_UPDATE_DELAY']);
  });

  it('asks it of a plain const object too', () => {
    expect(reportedIn('const-object-plain.ts')).toEqual(['unusedLabel']);
  });

  it('asks it of a property written the short way too', () => {
    // `{ spareJar }` names a member. That the variable behind it is read
    // elsewhere is a fact about the variable, not about the object's member.
    expect(reportedIn('const-object-shorthand.ts')).toEqual(['spareJar']);
  });

  it('says nothing about an object that hands out every member at once', () => {
    // Object.values, a spread, a computed index, the binding passed on whole.
    expect(reportedIn('const-object-escapes.ts')).toEqual([]);
  });

  it("keeps the rest reportable when `'name' in obj` probes one key", () => {
    // The one dynamic use that names a key instead of reaching them all: `jam`
    // is used because the probe reads it, `pickles` because something reads it,
    // and `chutney` is left with nothing.
    expect(reportedIn('const-object-probe.ts')).toEqual(['chutney']);
  });

  it('says nothing about an object targeted by keyof typeof', () => {
    expect(reportedIn('const-object-keyof.ts')).toEqual([]);
  });

  it('asks the same question of the literals nested inside', () => {
    // `oven`, `oven.grill`, `spices` and `timings` are each read in a way that
    // keeps the value local — a path, a deeper path, a string index, a
    // destructuring — so the members under them answer for themselves.
    expect(reportedIn('const-object-nested.ts')).toEqual(['deadRack', 'deadRest', 'deadSetting', 'deadTin']);
  });

  it('stops at the property that lets its value out', () => {
    // Forwarded, serialized, enumerated, indexed with a computed key: each one
    // hands the whole inner shape onward, and nothing under it is reportable.
    expect(reportedIn('const-object-nested-escapes.ts')).toEqual([]);
  });

  it('reports the unread property itself, not the members under it', () => {
    // Nothing reaches inside a property nobody reads. One death, one finding,
    // one edit — never the same death told twice.
    expect(reportedIn('const-object-nested-unread.ts')).toEqual(['pantry']);
  });

  it('leaves a declared shape to the collector that reads declared shapes', () => {
    // An annotation or a `satisfies` hands the shape to a named type, and the
    // hand-off has to land: each dead member is reported once, on the type that
    // declares it, and never a second time by this collector.
    expect(reportedIn('const-object-typed.ts')).toEqual(['spareJars', 'spareShelves']);
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
});

describe('objects returned from several branches', () => {
  it('reads every shape the function hands back', () => {
    // Two branches, two shapes, one return value. `handle` is read on both;
    // the key each branch writes alone dies on that branch's terms.
    expect(reportedIn('returned-object-branches.ts')).toEqual(['deadWide', 'deadNarrow'].sort());
  });

  it('credits a key one branch reads to every branch that writes it', () => {
    // Two branches of one shape collapse to a single set of declarations, so
    // every read of `mesh` lands on the first branch and the second holds no
    // references at all. Reporting it would be a false positive.
    expect(reportedIn('returned-object-branches-alike.ts')).toEqual(['deadGauge', 'deadGauge']);
  });

  it('calls the sibling write the member, not a name that matches it', () => {
    // The other branch writing `deadGauge` is this property written twice.
    // Reading it as an unverified name match would soften the verdict on the
    // strength of the member itself.
    const finding = findingFor('returned-object-branches-alike.ts', 'deadGauge');
    expect(finding?.verdict).toBe('dead');
  });

  it('folds only when every branch loses everything', () => {
    const fold = findings.find(
      f => f.kind === 'empty-type' && f.filePath.endsWith('/returned-object-branches-empty.ts')
    );
    expect(fold?.name).toBe('tallyLadles');
    // Three keys between the two branches, counted as the return value offers
    // them rather than as lines that write them.
    expect(fold?.kind === 'empty-type' ? fold.swallowed : 0).toBe(3);
    expect(reportedIn('returned-object-branches-empty.ts')).toEqual([]);
  });

  it('leaves the function alone when a branch returns something else', () => {
    // A read of the return value could land on that other shape, so the
    // literal's own keys prove nothing.
    expect(reportedIn('returned-object-branches-mixed.ts')).toEqual([]);
  });
});

describe('members reached by a key the source computes', () => {
  it('credits the keys the type pins down, and no more', () => {
    // `'jams' | 'pickles'` reaches exactly two members. They are used; the rest
    // of the shelf still answers for itself.
    expect(reportedIn('computed-key.ts')).toEqual(['deadChutneys']);
    // And the type does not fold: two of its three members are alive.
    expect(findings.some(f => f.kind === 'empty-type' && f.name === 'ShelfIndex')).toBe(false);
  });
});

describe('members the code writes and never reads', () => {
  it('reports the member an annotated literal fills in and nothing reads', () => {
    // `writeOnlyRet` is written into the returned literal against the declared
    // return type, and read nowhere. The write is a reference like any other —
    // seeing past it is the whole point of the verdict.
    expect(reportedIn('type-literal-alias.ts')).toEqual(['deadProp', 'writeOnlyRet']);
    expect(verdictIn('type-literal-alias.ts', 'writeOnlyRet')).toBe('write-only');
  });

  it('names the writes it found, and keeps them for the fix', () => {
    const finding = findingFor('write-only-member.ts', 'spareCrates');
    expect(finding?.verdict).toBe('write-only');
    expect(finding?.evidence).toMatch(/the writes at .* name this member, and nothing reads it/);
    expect(finding?.kind === 'member' ? finding.writeSites?.length : 0).toBe(2);
  });

  it('leaves a member alone when a read reaches it through any declaration', () => {
    // `satisfies` and `as const` leave the literal holding its own type, so a
    // read lands on the property written there. The member is not unread — the
    // reads resolve to the other declaration, and both have to stay.
    expect(reportedIn('write-only-shadowed.ts')).toEqual(['neverWritten']);
  });
});
