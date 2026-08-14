// No import, no export: a script, the way a route table or a polyfill is
// written. Only the side-effect import in index.ts reaches it.
declare const registry: { add(name: string): void };
registry.add('registered');
