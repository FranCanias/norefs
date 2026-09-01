# Speed

Unused files and every dependency check are decided by the import graph, and the
import graph is in the source text. Ask for only those and norefs never builds a
type checker: a single-pass scanner reads every file, the compiler resolves the
specifiers it found, and the answer arrives in well under a second.

```sh
norefs --only files,dependencies,unlisted,misplaced
```

The member checks are the other half. To know that `{ id: 1 }` writes the `id`
an interface declares, norefs has to ask the compiler what type that object
literal is read as — and answering that resolves the types of the surrounding
call or component. It is most of what a full run costs, and nothing but a
member finding rests on it, so a run that asks for no member findings does not
pay for it either:

```sh
norefs --only files,exports,types,ns-exports,ns-types,dependencies,unlisted
```

On a 541-file library:

| run | time | memory |
| --- | --- | --- |
| everything | 8.1 s | 1.4 GB |
| everything but members | 3.7 s | 1.0 GB |
| files and dependencies only | 0.33 s | 192 MB |

Re-run it yourself. The repository is Apollo Client at commit `54084bc`, and
the numbers are the best of three runs on an Apple M3 with 8 GB, Node 23.4.0,
last measured 2026-08-21:

```sh
git clone --depth 1 https://github.com/apollographql/apollo-client
cd apollo-client && npm install --ignore-scripts
/usr/bin/time -l norefs -p tsconfig.json
```

Absolute times belong to that machine. The ratio is the point, and it is what
holds across repositories: the member pass is most of a full run.

When a project is too big for Node's heap, the run dies in a V8 crash norefs
cannot catch. So norefs estimates the cost from the source size first, and
warns before the work starts when the estimate does not fit — with the two
ways out: give Node more with `NODE_OPTIONS=--max-old-space-size=8192`, or
ask for less with `--only`.

The findings are the same either way — the kinds you ask for change the work
done, not the answers. That is a claim with a probe behind it: on the run
above, the full report and the member-less one name the same 88 module-level
findings, and `tests/kinds.test.ts` asks the same question of every fixture.

For the checks that do need references, norefs indexes the whole project once —
one pass that collects every identifier by its text — instead of asking the
language service per declaration, which would rebuild an import tracker every
time. Nothing resolves during that pass. A name resolves to its symbols when
the first query targets it — a rename like `import { a as b }` links the two
names, so the query still finds every alias — and a name no query ever
targets, most occurrences of a big project, never resolves at all.

The index skips what no finding can rest on. And where the checker's
contextual-type answer would type-check a whole call, the index reads the
argument's declared type off every signature of the callee instead — filing a
reference under each candidate rather than the one overload the checker would
pick. Filing wider costs nothing but a missed finding. Generic signatures work
the same way — which members `TableProps<T>` declares does not depend on what
`T` becomes — and each component or callee is read once, however many sites
use it. Only the cases where instantiation can reshape a type's members — a
naked type parameter, a conditional type, a mapped type, a spread, a class
component — still pay the checker's price.

The one walk that fans out — the constraint index, which keeps an overridden
member load-bearing by matching two types property by property, four levels
down, across every arm of their unions — visits each pair of types once. The
same pair turns up on many paths in a library whose properties are typed by
unions of the same few types, and before the walk remembered, cheerio's
thirty-six files cost twelve CPU minutes; they cost 1.2 seconds now.

## Synthetic shapes

Some claims are about a shape, not a repository: what a relay costs, what
reading every branch of a `return` costs, what a computed key costs. A real
repository has too little of any one of them to measure, so
`bench/synthetic.mjs` builds a project that is nothing else:

```sh
node bench/synthetic.mjs relay /tmp/bench-relay 300
norefs -p /tmp/bench-relay/tsconfig.json
```

Four shapes: `single-return` and `multi-return` declare the same keys and the
same reads either side of one `return` or three, so the pair prices reading the
shape rather than the work it makes; `computed-key` is nothing but `rows[i]`
indexing; `relay` sends every type to `Object.keys` through a helper. The
[changelog](../CHANGELOG.md) cites them by name, and each one is a command.

They are a stopwatch, not a corpus. What a shape costs when a project is made
of nothing else is the ceiling, and [corpus validation](corpus.md) is where
real repositories answer.

## Watch mode

While you clean up a codebase, run norefs in a terminal on the side:

```sh
norefs --watch
```

Loading the project is the expensive part of a run, so watch mode does it once. On every save it refreshes only the changed files in memory, re-analyzes, and reports again — created and deleted files included. Changes to `tsconfig.json` or `norefs.config.json` need a restart; `--watch` does not combine with `--fix` or `--baseline`.

---

[← All docs](README.md)
