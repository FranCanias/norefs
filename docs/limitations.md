# Limitations

## What counts as usage

The test suite verifies that the reference check resolves all of these — none of them produce false positives:

- dot access (`v.prop`) and string-literal element access (`v['prop']`)
- destructuring, in parameters and in bodies
- a dynamic import destructured on the spot: `const { plate } = await import('./recipes')`, and the same pattern in the callback `import('./recipes').then(({ plate }) => …)` hands the module to
- spreads, into both same-typed and fresh object types
- mapped types (`Partial<T>`, `Pick<T, 'k'>`) and interface inheritance
- usage from other files, quoted property names, implementing class members
- property writes, told apart from reads: a member every reference only fills in — an annotated literal, a JSX attribute, `shelf.count = 1`, `shelf.count++` on a line of its own — earns the `write-only` verdict instead of counting as used, unless a read reaches it through some other declaration
- a literal probe like `'name' in v` counts as usage of exactly that property
- class members reached through a declared `implements` or `extends` — TypeScript merges those reference groups
- reads through a spread copy of a class instance resolve back to the class members
- a read one level in — `cfg.outer.inner`, `cfg['outer'].inner`, or `const { outer } = cfg` followed by `outer.inner` — counts on the nested literal, not on the object around it
- a key written by more than one `return` of the same function counts on all of them: two branches of one shape collapse to a single set of declarations, and the branch the checker dropped is alive on the reads the other one holds

## When norefs stays silent

Some consumption is invisible to static reference search. Rather than guess, norefs suppresses those findings entirely:

- **`keyof`-targeted types**: when `keyof T` appears anywhere, code is enumerating or indexing T's keys dynamically. All of T's members are skipped.
- **Key-enumerating and serializing sinks**: a value passed to `Object.keys`/`values`/`entries`/`assign`, `JSON.stringify`, `structuredClone`, or `Reflect.ownKeys`, iterated with `for...in`, or probed with a dynamic `key in v` marks its whole type as dynamically consumed.
- **Keys the source computes**: `manifest[section]` names a member without writing it down, and the key's type says how many are in reach. A union of string literals — `'dependencies' | 'devDependencies'` — reaches exactly those members and marks them used, leaving the rest of the type answerable. A string the type cannot pin down reaches every member, and the whole type is skipped. An index that is a number names no member at all.
- **Sinks reached through a helper**: a function that hands a parameter to one of those sinks does the same to whatever its callers pass in, so `dump(recipe)` is as dynamic as `Object.keys(recipe)` when `dump` is the function that makes that call. The sink standing inside the helper sees only the type parameter — the concrete type is back at the call site, and that is where norefs looks. It follows the relaying parameter through as many hops as the forwarding goes, and skips the type at each call site it reaches. Only the parameter that carries the value relays; the ones beside it answer for their members as usual. A relay handed on as a value rather than called — `rows.forEach(dump)` — writes no argument down, so the position it lands in answers instead: whatever type that position expects at the relaying parameter is what will arrive.
- **Escaping values**: when an object leaves local view as a whole — a returned literal passed on as a bare argument, a whole-binding parameter or variable forwarded via shorthand into a differently-declared type, a property whose value flows onward wholesale, an `as`/`satisfies` cast whose value is spread into a combined array or passed bare — its properties may be consumed without any per-property reference. The affected type literal is skipped.
- **Assignability-required members**: a declared relation can make a member load-bearing with zero references. An `extends`/`implements` override (`interface Derived extends Base { items: DerivedItem[] }`) or a type predicate (`v is Derived`) forces one type to stay assignable to another, so the required members of the base shape are kept even when nothing reads them.
- **Type-level reads**: a name written in a type literal that the type system matches against another type is read on every compile, whatever the runtime does. Three positions count, and each credits the name to the literal *and* to the type it is matched against: a conditional type's `extends` clause, including through an alias like `Extract<Schedule, { type: 'DAILY' }>`; a predicate's asserted type (`r is Recipe & { id: string }`); and a written type argument against a literal constraint (`pickFirst<Row>(…)` where `T extends { id: string }`). A filter can also name a property one level in — `Extract<Event, { payload: { kind: 'RENAME' } }>` — and the nested name is read on whatever type the property holds, not on the type around it. An inferred type argument needs no rule — the value goes into the call whole, and the escape check already stops there.
- **Parameters of function types**: callback signatures declare parameter types, but implementations bind their own parameters; when callbacks are invoked with variables rather than literals, the signature's members can't be tracked.
- **Structural class implementations**: when an instance escapes into a type that is not the class or its declared heritage — `return new StoreImpl()` from a function typed as interface `Store`, with no `implements` clause — every call goes through the interface and the class members collect zero references while being used at runtime. The whole class is skipped, along with its base classes and any class whose instances only leave through methods of such a class. Declaring `implements` restores tracking.
- **Decorated classes**: a decorator hands the class to a framework that reads members through reflection or metadata. The whole class is skipped.
- **Dynamically consumed enums**: `keyof typeof E`, `Object.values(E)`, `for...in`, and reverse mapping or computed lookup (`E[x]`) all reach members without per-member references. The whole enum is skipped.
- **A function that returns something other than a literal**: several `return` statements are several shapes of one return value, and each literal answers for its own members. A `return` of a variable, a call, or nothing at all puts a shape here that this check cannot read, and a read of the value could land on that shape instead. The whole function is left alone.
- **A nested literal whose property lets its value out**: an object literal inside another is a shape of its own, and the check reaches it one property at a time. It reaches it only where every read of the holding property keeps the value local. `cfg.outer` passed bare, serialized, enumerated, or indexed with a computed key carries the whole inner shape with it, and a member of that shape can then be read with nothing to show for it. The descent stops at that property, and everything under it stays quiet. A property nothing reads stops it as well — that property is the finding, and the members below it would tell one death twice. A nested literal with a declared shape (`{ … } satisfies Portions`) hands off to the type collectors, exactly as a declared const object does.
- **Const objects that hand out every member at once**: an object is a value, so its properties can be reached without naming one. `Object.values(Timeouts)`, a spread, an index with a computed key, or the binding passed on whole all read every member in one go, and each silences that declaration. A `'name' in Timeouts` probe is the exception: it names one key, so it marks that key used and leaves the rest reportable. A const object with a declared type — an annotation or a `satisfies` — is skipped here as well, because the type that declares the shape is what the type collectors already report.

## Remaining blind spots

- A relay renamed through a binding that declares no type (`const relay = dump`) loses the position that would have said what it will be given, and so does one handed to a parameter typed only `Function`. Annotating the binding restores it.
- Nesting is followed through object literals alone, never into an array of them. `const cfg = { rows: [{ id: 1, deadFlag: false }] }` reports nothing about `deadFlag`: an element is reached by index or by a callback parameter, and neither says which literal a read landed on.
- A nested literal that loses every member leaves its brackets behind. `--fix` writes `outer: {}` rather than dropping `outer`, because the findings are one per member and none of them owns the property that holds them.
- Two more ways of touching a property still read as reads, so the member stays used: a destructuring assignment (`({ count: t.count } = src)`), and a `delete`. A write through a computed key credits the member the key names, the same as a read would.
- Anonymous default-export classes (`export default class { … }`) are skipped: without a name there are no class references to run the escape checks on.
- Declaration files (`.d.ts`) are not scanned.
- A workspace package that imports a sibling's *built* output rather than its source reads a second copy of every type. `drizzle-kit/node_modules/drizzle-orm` is a symlink to `drizzle-orm/dist`, so the reads land on declarations the run never holds, and the source members they belong to look unread. Point the run at the source — or expect those members to be reported.
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
