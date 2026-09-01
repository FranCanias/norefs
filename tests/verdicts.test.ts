import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import { isFixable } from '../src/engine/fix';
import type { EmptyTypeFinding, Finding } from '../src/types';

function verdictOf(findings: Finding[], name: string): Finding | undefined {
  return findings.find(f => f.kind === 'member' && f.name === name);
}

describe('verdicts', () => {
  it('reports a member the code only ever writes in place', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface Tally {',
        '  hits: number;',
        '  misses: number;',
        '}',
        'function count(t: Tally): number {',
        '  t.misses = 0;',
        '  t.misses += 1;',
        '  return t.hits;',
        '}',
        '',
      ].join('\n')
    );
    const findings = analyze(project);

    const member = verdictOf(findings, 'misses');
    expect(member?.verdict).toBe('write-only');
    expect(member?.evidence).toContain('name this member, and nothing reads it');
    // No single edit retires an assignment — the right-hand side may do work —
    // so the finding is reported and left for a human.
    expect(isFixable(member as Finding, true)).toBe(false);
  });

  it('keeps a member whose in-place write is read back', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface Tally {',
        '  hits: number;',
        '  misses: number;',
        '}',
        'function count(t: Tally): number {',
        '  t.misses = 0;',
        '  const seen = t.misses++;',
        '  return t.hits + seen;',
        '}',
        '',
      ].join('\n')
    );
    expect(verdictOf(analyze(project), 'misses')).toBeUndefined();
  });

  it('will not discard a name match on the strength of another in-place write', () => {
    // `balance` has no references. The only write of the name sits in an
    // unrelated literal whose own `balance` is written and never read — which
    // says nothing about whether this member is written through the gap. The
    // analysis says so instead of claiming the write feeds another type.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface Ledger {',
        '  entries: number;',
        '  balance: number;',
        '}',
        'function total(l: Ledger): number {',
        '  return l.entries;',
        '}',
        'function tally(): unknown {',
        '  const running = { balance: 0 };',
        '  running.balance = 5;',
        '  return running;',
        '}',
        '',
      ].join('\n')
    );
    const member = verdictOf(analyze(project), 'balance');
    expect(member?.verdict).toBe('write-only');
    expect(member?.evidence).toContain('unverified name match');
  });

  it('marks members of a JSON-parsed type as contract, transitively', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface RecipeIO {',
        '  id: string;',
        '  count: number;',
        '}',
        'interface LibraryFile {',
        '  recipes: RecipeIO[];',
        '  version: number;',
        '}',
        'declare const text: string;',
        'const load = (): LibraryFile => JSON.parse(text) as LibraryFile;',
        'const version = (f: LibraryFile) => f.version;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);

    expect(verdictOf(findings, 'recipes')?.verdict).toBe('contract');
    expect(verdictOf(findings, 'recipes')?.evidence).toContain('JSON.parse');

    // RecipeIO loses every member, so the cascade folds into one finding.
    const emptied = findings.find((f): f is EmptyTypeFinding => f.kind === 'empty-type' && f.name === 'RecipeIO');
    expect(emptied?.verdict).toBe('contract');
    expect(emptied?.swallowed).toBe(2);
    expect(verdictOf(findings, 'id')).toBeUndefined();
    expect(verdictOf(findings, 'count')).toBeUndefined();
  });

  it('marks types crossing a project-declared bridge as contract, both directions', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/bridge.d.ts',
      [
        'interface Bridge {',
        '  invoke(channel: string, payload?: unknown): Promise<unknown>;',
        '}',
        'declare const api: Bridge;',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/main.ts',
      [
        'interface BoxRecipe {',
        '  cuisine: string;',
        '  label: string;',
        '}',
        'interface SavePayload {',
        '  recipe: BoxRecipe;',
        '  revision: number;',
        '}',
        'async function load(): Promise<BoxRecipe[]> {',
        "  return (await api.invoke('recipeBox:list')) as BoxRecipe[];",
        '}',
        'function save(payload: SavePayload): Promise<unknown> {',
        "  return api.invoke('recipeBox:save', payload);",
        '}',
        'const show = (d: BoxRecipe) => d.label;',
        'const recipe = (p: SavePayload) => p.recipe;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);

    // `cuisine` is unread in this process, but the type crosses the bridge.
    expect(verdictOf(findings, 'cuisine')?.verdict).toBe('contract');
    expect(verdictOf(findings, 'cuisine')?.evidence).toContain('api.invoke');
    // `revision` rides the send side of the same edge.
    expect(verdictOf(findings, 'revision')?.verdict).toBe('contract');
  });

  it('marks the asserted result of an untraced call as contract', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface Config {',
        '  retries: number;',
        '  timeout: number;',
        '}',
        'declare const response: { json(): Promise<any> };',
        'async function load(): Promise<Config> {',
        '  return (await response.json()) as Config;',
        '}',
        'const use = (c: Config) => c.timeout;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    expect(verdictOf(findings, 'retries')?.verdict).toBe('contract');
    expect(verdictOf(findings, 'retries')?.evidence).toContain('json');
  });

  it('marks a member as shadowed when a structural twin reads it', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/shared.ts',
      [
        'export interface EdgeData {',
        '  label: string;',
        '  color: string;',
        '  zone: string;',
        '}',
        'export const tag = (e: EdgeData) => e.label;',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/main.ts',
      [
        "import { tag } from './shared';",
        'interface LocalEdgeData {',
        '  label: string;',
        '  color: string;',
        '  zone: string;',
        '}',
        'declare const data: unknown;',
        'const local = data as LocalEdgeData;',
        'export const run = () => tag(local) + local.color + local.zone;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);

    const color = findings.find(f => f.kind === 'member' && f.name === 'color' && f.context.includes('EdgeData'));
    expect(color?.verdict).toBe('shadowed');
    expect(color?.evidence).toContain('LocalEdgeData');
    expect(color?.evidence).toContain('`color`');
  });

  it('marks a member as shadowed when a same-named type overlaps the shape', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/a.ts',
      [
        'export interface IOWithTags {',
        '  id?: string;',
        '  name?: string;',
        '  tags?: string[];',
        '  alias?: string;',
        '}',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/b.ts',
      [
        'export interface IOWithTags {',
        '  id: string;',
        '  tags?: string[];',
        '}',
        'export const pick = (v: IOWithTags) => v.id + (v.tags ?? []).length;',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/main.ts',
      [
        "import type { IOWithTags } from './a';",
        "import { pick } from './b';",
        'declare const io: IOWithTags;',
        "export const run = () => pick({ id: io.id ?? '', tags: io.tags }) + (io.alias ?? '');",
        '',
      ].join('\n')
    );
    const findings = analyze(project);

    const name = findings.find(f => f.kind === 'member' && f.name === 'name');
    expect(name?.verdict).toBe('shadowed');
    expect(name?.evidence).toContain('IOWithTags');
    expect(name?.evidence).toContain('b.ts');
  });

  it('merges contract and shadowed when the twin sits across the boundary', () => {
    // One wire format, declared once per process. The far side crosses a
    // project-declared bridge; the near side is its same-named drifted copy.
    // That is one conceptual fact, and both findings must tell it as one
    // contract instead of competing by precedence.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/bridge.d.ts',
      [
        'interface Bridge {',
        '  invoke(channel: string, payload?: unknown): Promise<unknown>;',
        '}',
        'declare const api: Bridge;',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/electron.ts',
      [
        'interface RecipeIO {',
        '  cuisine: string;',
        '  author: string;',
        '  servings: string;',
        '}',
        'declare const io: RecipeIO;',
        "export const persist = () => api.invoke('recipeBox:save', io);",
        'export const servings = () => io.servings;',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/renderer.ts',
      [
        'interface RecipeIO {',
        '  cuisine: string;',
        '  author: string;',
        '  label: string;',
        '}',
        'declare const local: RecipeIO;',
        'export const render = () => local.label;',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/index.ts',
      "import { persist, servings } from './electron';\nimport { render } from './renderer';\npersist();\nrender();\nservings();\n"
    );
    const findings = analyze(project);

    const nearSide = findings.find(f => f.kind === 'member' && f.name === 'cuisine' && f.filePath === '/renderer.ts');
    expect(nearSide?.verdict).toBe('contract');
    expect(nearSide?.evidence).toContain('far side');
    expect(nearSide?.evidence).toContain('electron.ts');

    const farSide = findings.find(f => f.kind === 'member' && f.name === 'cuisine' && f.filePath === '/electron.ts');
    expect(farSide?.verdict).toBe('contract');
    expect(farSide?.evidence).toContain('api.invoke');
    // The far side names its twin too: one fact, told from both ends.
    expect(farSide?.evidence).toContain('renderer.ts');
  });

  it('does not let a read structural twin mask a boundary twin', () => {
    // shared.ts holds a structurally identical, read copy; main.ts holds a
    // same-named drifted copy across the bridge. The cross-boundary link
    // must win, not whichever twin an iterator yields first.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/bridge.d.ts',
      [
        'interface Bridge {',
        '  invoke(channel: string, payload?: unknown): Promise<unknown>;',
        '}',
        'declare const api: Bridge;',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/renderer.ts',
      [
        'interface Options {',
        '  alpha: string;',
        '  beta: string;',
        '  gamma: string;',
        '}',
        'declare const options: Options;',
        'export const render = () => options.gamma;',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/shared.ts',
      [
        'interface Options {',
        '  alpha: string;',
        '  beta: string;',
        '  gamma: string;',
        '}',
        'declare const shared: Options;',
        'export const use = () => [shared.alpha, shared.beta, shared.gamma];',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/main.ts',
      [
        'interface Options {',
        '  alpha: string;',
        '  beta: string;',
        '  wire: string;',
        '}',
        'declare const wireOptions: Options;',
        "export const persist = () => api.invoke('options:save', wireOptions);",
        'export const wire = () => wireOptions.wire;',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/index.ts',
      [
        "import { render } from './renderer';",
        "import { use } from './shared';",
        "import { persist, wire } from './main';",
        'render();',
        'use();',
        'persist();',
        'wire();',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const nearSide = findings.find(f => f.kind === 'member' && f.name === 'alpha' && f.filePath === '/renderer.ts');
    expect(nearSide?.verdict).toBe('contract');
    expect(nearSide?.evidence).toContain('main.ts');
  });

  it('reads a property access as the value being read at its own type', () => {
    // Two dialects of the same builder, each returning its own card. A read of
    // one card's `label` can never see the other's write, so neither `shelf`
    // needs hedging: the name match is accounted for.
    const project = new Project({ useInMemoryFileSystem: true });
    const card = [
      'export const cardFor = (title: string) => {',
      '  const label = title;',
      '  const shelf = 1;',
      '  return { label, shelf };',
      '};',
      '',
    ].join('\n');
    project.createSourceFile('/pantry.ts', card);
    project.createSourceFile('/larder.ts', card);
    project.createSourceFile(
      '/main.ts',
      [
        "import { cardFor as pantryCard } from './pantry';",
        "import { cardFor as larderCard } from './larder';",
        'function print(): string {',
        '  const a = pantryCard("soup");',
        '  const b = larderCard("stew");',
        '  return a.label + b.label;',
        '}',
        '',
      ].join('\n')
    );

    const member = verdictOf(analyze(project), 'shelf');
    expect(member?.verdict).toBe('dead');
    expect(member?.evidence).toContain('every write of the name feeds another type');
  });

  it('follows a value that becomes a property of an inferred literal', () => {
    // `return { schema, card }` hands the card on, and the checker takes the
    // outer property's type from the card itself. Reading it back yields the
    // same type, so the walk keeps its footing instead of giving up.
    const project = new Project({ useInMemoryFileSystem: true });
    const card = [
      'export const cardFor = (title: string) => {',
      '  const label = title;',
      '  const shelf = 1;',
      '  return { label, shelf };',
      '};',
      '',
    ].join('\n');
    project.createSourceFile('/pantry.ts', card);
    project.createSourceFile('/larder.ts', card);
    project.createSourceFile(
      '/main.ts',
      [
        "import { cardFor as pantryCard } from './pantry';",
        "import { cardFor as larderCard } from './larder';",
        'function open(title: string) {',
        '  const card = larderCard(title);',
        '  return { title, card };',
        '}',
        'function print(): string {',
        '  return pantryCard("soup").label + open("stew").card.label;',
        '}',
        '',
      ].join('\n')
    );

    expect(verdictOf(analyze(project), 'shelf')?.verdict).toBe('dead');
  });

  it('gives up on a literal something else types', () => {
    // The outer literal is declared as `Wrapped`, so its `card` property is
    // whatever `Wrapped` says — not this value's own shape. The walk cannot
    // say where the write ends up, and the verdict hedges.
    const project = new Project({ useInMemoryFileSystem: true });
    const card = [
      'export const cardFor = (title: string) => {',
      '  const label = title;',
      '  const shelf = 1;',
      '  return { label, shelf };',
      '};',
      '',
    ].join('\n');
    project.createSourceFile('/pantry.ts', card);
    project.createSourceFile('/larder.ts', card);
    project.createSourceFile(
      '/main.ts',
      [
        "import { cardFor as pantryCard } from './pantry';",
        "import { cardFor as larderCard } from './larder';",
        'interface Wrapped {',
        '  card: { label: string; shelf: number };',
        '}',
        'function open(title: string): Wrapped {',
        '  const card = larderCard(title);',
        '  return { card };',
        '}',
        'function print(): string {',
        '  return pantryCard("soup").label + open("stew").card.label;',
        '}',
        '',
      ].join('\n')
    );

    const member = verdictOf(analyze(project), 'shelf');
    expect(member?.verdict).toBe('write-only');
    expect(member?.evidence).toContain('unverified name match');
  });

  it('spells out three write sites and counts the rest honestly', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface Config {',
        '  retries: number;',
        '  timeout: number;',
        '}',
        'const read = (c: Config) => c.retries;',
        'declare function stash(payload: unknown): void;',
        'stash({ timeout: 1 });',
        'stash({ timeout: 2 });',
        'stash({ timeout: 3 });',
        'stash({ timeout: 4 });',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const member = findings.find(f => f.kind === 'member' && f.name === 'timeout');
    expect(member?.verdict).toBe('write-only');
    expect(member?.evidence).toMatch(/main\.ts:7, .*main\.ts:8, .*main\.ts:9 and 1 more site\b/);
  });

  it('stops calling a common name evidence, and says how common it is', () => {
    // `name` written at two thousand sites across a repo told the reader
    // nothing about this member, and the report could only ever show three of
    // them. Past a handful the count is the finding, and the verdict falls
    // back to what the references showed.
    const writes = Array.from({ length: 12 }, (_, i) => `stash({ label: ${i} });`);
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface Recipe {',
        '  title: string;',
        '  label: string;',
        '}',
        'const read = (r: Recipe) => r.title;',
        'declare function stash(payload: unknown): void;',
        ...writes,
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const member = findings.find(f => f.kind === 'member' && f.name === 'label');
    expect(member?.verdict).toBe('dead');
    expect(member?.evidence).toContain('written at 12 sites');
    expect(member?.evidence).toContain('too common a name');
  });

  it('will not let two copies that only write a member shadow each other', () => {
    // Both shapes fill `zone` in and neither reads it. Each copy named the
    // other as the reader, so the pair shadowed each other and the report
    // never said the true thing: nobody reads it.
    const shape = (name: string, fn: string): string =>
      [
        `interface ${name} {`,
        '  label: string;',
        '  color: string;',
        '  zone: string;',
        '}',
        `declare const d: ${name};`,
        `export const ${fn} = (): string => {`,
        "  d.zone = 'cold';",
        '  return d.label + d.color;',
        '};',
        '',
      ].join('\n');
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('/pantry.ts', shape('ShelfData', 'stockShelf'));
    project.createSourceFile('/larder.ts', shape('LarderData', 'stockLarder'));
    project.createSourceFile(
      '/main.ts',
      ["export { stockShelf } from './pantry';", "export { stockLarder } from './larder';", ''].join('\n')
    );

    const zones = analyze(project).filter(f => f.kind === 'member' && f.name === 'zone');
    expect(zones).toHaveLength(2);
    expect(zones.map(f => f.verdict)).toEqual(['write-only', 'write-only']);
  });

  it('leaves a member with no signals dead', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface User {',
        '  name: string;',
        '  legacyId: number;',
        '}',
        'const greet = (u: User) => u.name;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    expect(verdictOf(findings, 'legacyId')?.verdict).toBe('dead');
  });

  it('gives export findings their verdict at the source', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('/main.ts', "import { used } from './lib';\nused();\n");
    project.createSourceFile(
      '/lib.ts',
      [
        'export function used(): number {',
        '  return local();',
        '}',
        'export function local(): number {',
        '  return 1;',
        '}',
        'export function gone(): void {}',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    expect(findings.find(f => f.name === 'local')?.verdict).toBe('over-exported');
    expect(findings.find(f => f.name === 'gone')?.verdict).toBe('dead');
  });
});

describe('a name read through a cast off an untyped value', () => {
  it('shadows the declaration the cast did not name', () => {
    // The cast tells the compiler what a value is where the compiler knows
    // nothing. The read lands on the shape the cast names, and the
    // declaration the value really came from collects nothing — so calling
    // that one dead, and deleting it, is the cast's word against the code's.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/jar.ts',
      [
        'export type Sealed = {',
        '  sealedAt: number;',
        '  deadStamp: string;',
        '  lid: string;',
        '};',
        'export function seal(jar: unknown): Sealed {',
        '  return jar as Sealed;',
        '}',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/main.ts',
      [
        "import { seal } from './jar';",
        'type WithSeal = { sealedAt: number };',
        'function isSealed(jar: unknown): boolean {',
        '  return Boolean((jar as WithSeal).sealedAt);',
        '}',
        'export const lid = seal({}).lid;',
        '',
      ].join('\n')
    );
    const findings = analyze(project, { entries: ['/main.ts'] });

    const shadowed = verdictOf(findings, 'sealedAt');
    expect(shadowed?.verdict).toBe('shadowed');
    expect(shadowed?.evidence).toContain('through a cast off a value the types do not follow');
    expect(isFixable(shadowed as Finding, false)).toBe(false);
    // A name no cast names is untouched: the rule needs both halves, an
    // untyped value and a cast to a type that declares the member.
    expect(verdictOf(findings, 'deadStamp')?.verdict).toBe('dead');
  });

  it('keeps its distance from a cast that names no declaration', () => {
    // `(res as any).sealedAt` says nothing about any shape, so it shadows none.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'type Sealed = { sealedAt: number; lid: string };',
        'function seal(jar: Sealed): string {',
        '  return jar.lid;',
        '}',
        'function stamp(res: unknown): unknown {',
        '  return (res as any).sealedAt;',
        '}',
        '',
      ].join('\n')
    );
    expect(verdictOf(analyze(project), 'sealedAt')?.verdict).toBe('dead');
  });
});

describe('a member the code only deletes', () => {
  /** A recipe card whose `draft` flag is never read — only stripped off. */
  function box(...lines: string[]): Finding[] {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      ['interface Card {', '  title: string;', '  draft?: boolean;', '}', ...lines, ''].join('\n')
    );
    return analyze(project);
  }

  it('reports it, and calls the `delete` what it is', () => {
    const findings = box('function publish(card: Card): string {', '  delete card.draft;', '  return card.title;', '}');

    const member = verdictOf(findings, 'draft');
    expect(member?.verdict).toBe('write-only');
    // A `delete` fills nothing in, so calling it a write would be wrong twice.
    expect(member?.evidence).toContain('the `delete` at');
    expect(member?.evidence).toContain('is all that reaches this member');
    // Removing the member alone would leave the `delete` naming nothing, and
    // no single edit retires a statement — so this waits for a human.
    expect(isFixable(member as Finding, true)).toBe(false);
  });

  it('reads an index the same way', () => {
    const findings = box(
      'function publish(card: Card): string {',
      "  delete card['draft'];",
      '  return card.title;',
      '}'
    );
    expect(verdictOf(findings, 'draft')?.evidence).toContain('the `delete` at');
  });

  it('keeps a member that is read before it is deleted', () => {
    const findings = box(
      'function publish(card: Card): boolean | undefined {',
      '  const was = card.draft;',
      '  delete card.draft;',
      '  return was;',
      '}'
    );
    expect(verdictOf(findings, 'draft')).toBeUndefined();
  });

  it('falls back to the write wording when a real write sits beside the delete', () => {
    const findings = box(
      'function publish(card: Card): string {',
      '  card.draft = true;',
      '  delete card.draft;',
      '  return card.title;',
      '}'
    );
    const member = verdictOf(findings, 'draft');
    expect(member?.verdict).toBe('write-only');
    expect(member?.evidence).toContain('name this member, and nothing reads it');
  });

  it('counts a delete in a test file as test-only, not as a write', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('/main.ts', "import { title } from './card';\nvoid title;\n");
    project.createSourceFile(
      '/card.ts',
      [
        'export interface Card {',
        '  title: string;',
        '  draft?: boolean;',
        '}',
        'export const title = (c: Card): string => c.title;',
        '',
      ].join('\n')
    );
    project.createSourceFile(
      '/card.test.ts',
      ["import type { Card } from './card';", 'function strip(c: Card): void {', '  delete c.draft;', '}', ''].join(
        '\n'
      )
    );
    // The harness touching a member says who reaches it, not that it is
    // written — and deleting it means deleting that test too.
    expect(verdictOf(analyze(project), 'draft')?.verdict).toBe('test-only');
  });
});

describe('a destructuring assignment', () => {
  /** A recipe card and the pattern that pulls a flag off it. */
  function box(...lines: string[]): Finding[] {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      ['interface Card {', '  title: string;', '  starred: boolean;', '}', ...lines, ''].join('\n')
    );
    return analyze(project);
  }

  it('reads the member its key names', () => {
    const findings = box(
      'function pin(card: Card): boolean {',
      '  let pinned = false;',
      '  ({ starred: pinned } = card);',
      '  return pinned && card.title.length > 0;',
      '}'
    );
    // The key is the only thing that names the member, and it reads it.
    expect(verdictOf(findings, 'starred')).toBeUndefined();
  });

  it('reads it through a shorthand key too', () => {
    const findings = box(
      'function pin(card: Card): boolean {',
      '  let starred = false;',
      '  ({ starred } = card);',
      '  return starred && card.title.length > 0;',
      '}'
    );
    expect(verdictOf(findings, 'starred')).toBeUndefined();
  });

  it('reads it through an array pattern', () => {
    const findings = box(
      'function pin(cards: Card[]): boolean {',
      '  let pinned = false;',
      '  [{ starred: pinned }] = cards;',
      '  return pinned && cards.length > 0;',
      '}'
    );
    expect(verdictOf(findings, 'starred')).toBeUndefined();
  });

  it('reads it through the pattern a `for…of` binds', () => {
    const findings = box(
      'function pin(cards: Card[]): boolean {',
      '  let pinned = false;',
      '  for ({ starred: pinned } of cards) {}',
      '  return pinned && cards.length > 0;',
      '}'
    );
    expect(verdictOf(findings, 'starred')).toBeUndefined();
  });

  it('reads a nested key on the shape that holds it', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface Card {',
        '  title: string;',
        '  badge: { starred: boolean };',
        '}',
        'function pin(card: Card): boolean {',
        '  let pinned = false;',
        '  ({ badge: { starred: pinned } } = card);',
        '  return pinned && card.title.length > 0;',
        '}',
        '',
      ].join('\n')
    );
    const findings = analyze(project);

    expect(verdictOf(findings, 'badge')).toBeUndefined();
    expect(verdictOf(findings, 'starred')).toBeUndefined();
  });

  it('keeps a member the key reads and the target writes', () => {
    const findings = box(
      'function copy(a: Card, b: Card): string {',
      '  ({ starred: a.starred } = b);',
      '  return a.title + b.title;',
      '}'
    );
    // Both halves name the same declaration. Counting the target as a write
    // must not swallow the read the key holds beside it.
    expect(verdictOf(findings, 'starred')).toBeUndefined();
  });

  it('writes the member on the far side of the pattern, and does not read it', () => {
    const findings = box(
      'function pin(card: Card, wanted: { starred: boolean }): string {',
      '  ({ starred: card.starred } = wanted);',
      '  return card.title;',
      '}'
    );

    const member = verdictOf(findings, 'starred');
    expect(member?.verdict).toBe('write-only');
    expect(member?.evidence).toContain('names this member, and nothing reads it');
    // The target sits inside a pattern; no single edit takes it out.
    expect(isFixable(member as Finding, true)).toBe(false);
  });
});

describe('a member a computed key only writes', () => {
  /** A shelf whose slots are filled by name, and read only one of them back. */
  function shelf(...lines: string[]): Finding[] {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface Shelf {',
        '  jars: number;',
        '  tins?: number;',
        '}',
        "type Slot = 'jars' | 'tins';",
        ...lines,
        '',
      ].join('\n')
    );
    return analyze(project);
  }

  it('reports it, and names the write', () => {
    const findings = shelf('function fill(s: Shelf, slot: Slot, n: number): void {', '  s[slot] = n;', '}');

    for (const name of ['jars', 'tins']) {
      const member = verdictOf(findings, name);
      expect(member?.verdict, name).toBe('write-only');
      expect(member?.evidence, name).toContain('names this member, and nothing reads it');
      // The key can stand for either member, so no single edit retires it.
      expect(isFixable(member as Finding, true), name).toBe(false);
    }
  });

  it('leaves the member a read reaches through some other name', () => {
    const findings = shelf('function fill(s: Shelf, slot: Slot): number {', '  s[slot] = 1;', '  return s.jars;', '}');
    expect(verdictOf(findings, 'jars')).toBeUndefined();
    expect(verdictOf(findings, 'tins')?.verdict).toBe('write-only');
  });

  it('says nothing at all when the key reads', () => {
    const findings = shelf('function count(s: Shelf, slot: Slot): number {', '  return s[slot] ?? 0;', '}');
    expect(findings).toEqual([]);
  });

  it('counts an update whose value goes nowhere as a write', () => {
    const findings = shelf('function bump(s: Shelf, slot: Slot): void {', '  s[slot] = (s[slot] ?? 0) + 1;', '}');
    // The right-hand side reads the member back, so this one is used.
    expect(findings).toEqual([]);
  });

  it('calls a `delete` through a computed key what it is', () => {
    const findings = shelf(
      "function strip(s: Shelf, slot: 'tins'): number {",
      '  delete s[slot];',
      '  return s.jars;',
      '}'
    );
    expect(verdictOf(findings, 'tins')?.evidence).toContain('the `delete` at');
  });
});
