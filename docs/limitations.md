# Limitations

## What counts as usage

The test suite verifies that the reference check resolves all of these — none of them produce false positives:

- dot access (`v.prop`) and string-literal element access (`v['prop']`)
- destructuring, in parameters and in bodies
- a dynamic import destructured on the spot: `const { plate } = await import('./recipes')`, and the same pattern in the callback `import('./recipes').then(({ plate }) => …)` hands the module to
- spreads, into both same-typed and fresh object types
- mapped types (`Partial<T>`, `Pick<T, 'k'>`) and interface inheritance
- usage from other files, quoted property names, implementing class members
- property writes (a write-only property counts as used)
- a literal probe like `'name' in v` counts as usage of exactly that property
- class members reached through a declared `implements` or `extends` — TypeScript merges those reference groups
- reads through a spread copy of a class instance resolve back to the class members

## When norefs stays silent

Some consumption is invisible to static reference search. Rather than guess, norefs suppresses those findings entirely:

- **`keyof`-targeted types**: when `keyof T` appears anywhere, code is enumerating or indexing T's keys dynamically. All of T's members are skipped.
- **Key-enumerating and serializing sinks**: a value passed to `Object.keys`/`values`/`entries`/`assign`, `JSON.stringify`, `structuredClone`, or `Reflect.ownKeys`, iterated with `for...in`, or probed with a dynamic `key in v` marks its whole type as dynamically consumed.
- **Escaping values**: when an object leaves local view as a whole — a returned literal passed on as a bare argument, a whole-binding parameter or variable forwarded via shorthand into a differently-declared type, a property whose value flows onward wholesale, an `as`/`satisfies` cast whose value is spread into a combined array or passed bare — its properties may be consumed without any per-property reference. The affected type literal is skipped.
- **Assignability-required members**: a declared relation can make a member load-bearing with zero references. An `extends`/`implements` override (`interface Derived extends Base { items: DerivedItem[] }`) or a type predicate (`v is Derived`) forces one type to stay assignable to another, so the required members of the base shape are kept even when nothing reads them.
- **Type-level reads**: a name written in a type literal that the type system matches against another type is read on every compile, whatever the runtime does. Three positions count, and each credits the name to the literal *and* to the type it is matched against: a conditional type's `extends` clause, including through an alias like `Extract<Schedule, { type: 'DAILY' }>`; a predicate's asserted type (`r is Recipe & { id: string }`); and a written type argument against a literal constraint (`pickFirst<Row>(…)` where `T extends { id: string }`). A filter can also name a property one level in — `Extract<Event, { payload: { kind: 'RENAME' } }>` — and the nested name is read on whatever type the property holds, not on the type around it. An inferred type argument needs no rule — the value goes into the call whole, and the escape check already stops there.
- **Parameters of function types**: callback signatures declare parameter types, but implementations bind their own parameters; when callbacks are invoked with variables rather than literals, the signature's members can't be tracked.
- **Structural class implementations**: when an instance escapes into a type that is not the class or its declared heritage — `return new StoreImpl()` from a function typed as interface `Store`, with no `implements` clause — every call goes through the interface and the class members collect zero references while being used at runtime. The whole class is skipped, along with its base classes and any class whose instances only leave through methods of such a class. Declaring `implements` restores tracking.
- **Decorated classes**: a decorator hands the class to a framework that reads members through reflection or metadata. The whole class is skipped.
- **Dynamically consumed enums**: `keyof typeof E`, `Object.values(E)`, `for...in`, and reverse mapping or computed lookup (`E[x]`) all reach members without per-member references. The whole enum is skipped.
- **Const objects that hand out every member at once**: an object is a value, so its properties can be reached without naming one. `Object.values(Timeouts)`, a spread, an index with a computed key, or the binding passed on whole all read every member in one go, and each silences that declaration. A `'name' in Timeouts` probe is the exception: it names one key, so it marks that key used and leaves the rest reportable. A const object with a declared type — an annotation or a `satisfies` — is skipped here as well, because the type that declares the shape is what the type collectors already report.

## Remaining blind spots

- Dynamic access laundered through a generic helper (`function dump<T>(o: T) { return Object.keys(o) }`) hides the concrete type from the sink detection.
- An exported function with several `return` statements returning different object literals is skipped entirely, rather than guessed at.
- Only the top level of an object literal is read, in both the const-object and returned-object checks. `const cfg = { outer: { inner: 1, deadInner: 2 } }` reports nothing about `deadInner`: reaching it safely means proving that every read of `cfg.outer` keeps the value local, and that check is not written yet.
- A member the code writes but never reads is a reference like any other, so an annotated literal that fills in `spareJars` keeps that member off the report. The `write-only` verdict covers the case the reference check cannot see — a literal typed by inference — and not this one, where the reference is right there.
- Anonymous default-export classes (`export default class { … }`) are skipped: without a name there are no class references to run the escape checks on.
- Declaration files (`.d.ts`) are not scanned.
- Anonymous default exports (`export default { … }`) have no name to search references for, so the export check skips them.
- A file consumed only through a bare `import './x'` for its side effects counts as used when its importer is reachable, even if nothing else touches it. That is the safe reading.
- An entry point nothing declares in writing — a file loaded by a name the code computes at runtime — is a false positive until you pass it with `--entry`. Run `norefs entries` to see what was found before reaching for the flag.
- A dependency consumed without an import, without a script, without a config naming it, and without a host that lists it as a peer — a binary called from a Makefile, say — shows up as unused until you add it to `ignoreDependencies`. A binary named in a `package.json` script is read; anywhere else is not.
- A devDependency is never called unused when the package is not installed, because its binaries live in its own manifest and there is nothing there to read.

## Anonymous findings

Some findings point at inline types with no name to anchor them — a `{x, y}` parameter type on an anonymous callback, for instance. These are the most false-positive-prone: TypeScript's reference search loses track of a value forwarded via shorthand into a *differently-declared* structural type, because the read then resolves to the other declaration. By default norefs reports only findings tied to a named interface, type alias, or function; pass `--anon` to include the anonymous ones too:

```sh
norefs --anon
```

---

[← All docs](README.md)
