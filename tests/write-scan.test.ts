import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import type { Finding } from '../src/types';

function memberOf(findings: Finding[], name: string): Finding | undefined {
  return findings.find(f => f.kind === 'member' && f.name === name);
}

describe('the write scan behind the dead verdict', () => {
  it('sees a shorthand write inside an inference-typed literal', () => {
    // The React-context shape: the literal is typed by inference (useMemo has
    // no type argument), so the connection to the interface happens at
    // assignability level and no reference ever lands on the member.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface PlannerContextType {',
        '  plannerRecipes: number[];',
        '  getRecipe: () => void;',
        '}',
        'declare function useMemo<T>(factory: () => T, deps: unknown[]): T;',
        'declare function provide(value: PlannerContextType): void;',
        'declare const context: PlannerContextType;',
        'const plannerRecipes: number[] = [];',
        'const getRecipe = () => {};',
        'const contextValue = useMemo(',
        '  () => ({',
        '    plannerRecipes,',
        '    getRecipe,',
        '  }),',
        '  [plannerRecipes, getRecipe]',
        ');',
        'export const run = () => provide(contextValue);',
        'export const read = () => context.getRecipe();',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const member = memberOf(findings, 'plannerRecipes');
    expect(member?.verdict).toBe('write-only');
    expect(member?.evidence).toContain('main.ts');
    // The value flows through the variable into `provide(value: PlannerContextType)`,
    // so the write is not a guess: it is proven to feed this member.
    expect(member?.evidence).toContain('typed write');
    expect(member?.evidence).toContain('never read');
  });

  it('sees a spread that carries the member into an inference-typed literal', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface Payload {',
        '  extra: number;',
        '  used: number;',
        '}',
        'declare function wrap<T>(factory: () => T): T;',
        'declare function send(p: Payload): void;',
        'declare const payload: Payload;',
        'declare const base: { extra: number };',
        'const value = wrap(() => ({ ...base, used: 1 }));',
        'export const run = () => send(value);',
        'export const read = () => payload.used;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    expect(memberOf(findings, 'extra')?.verdict).toBe('write-only');
    expect(memberOf(findings, 'extra')?.evidence).toContain('typed write');
  });

  it('sees a computed-key write with a literal name', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface Flags {',
        '  verbose: boolean;',
        '  quiet: boolean;',
        '}',
        'declare function wrap<T>(factory: () => T): T;',
        'declare function send(f: Flags): void;',
        'declare const flags: Flags;',
        "const value = wrap(() => ({ ['verbose']: true, quiet: false }));",
        'export const run = () => send(value as Flags);',
        'export const read = () => flags.quiet;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    expect(memberOf(findings, 'verbose')?.verdict).toBe('write-only');
  });

  it('names the write site in the evidence', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/types.ts',
      ['export interface Ramekin {', '  spice: string;', '  grams: number;', '}', ''].join('\n')
    );
    project.createSourceFile(
      '/main.ts',
      [
        "import type { Ramekin } from './types';",
        'declare function wrap<T>(factory: () => T): T;',
        'declare const ramekin: Ramekin;',
        "const config = wrap(() => ({ spice: 'cumin' }));",
        'export const run = () => [config, ramekin.grams];',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const member = memberOf(findings, 'spice');
    expect(member?.verdict).toBe('write-only');
    expect(member?.evidence).toMatch(/main\.ts:4/);
    // The value escapes into an untyped array; the match stays a labeled heuristic.
    expect(member?.evidence).toContain('unverified name match');
  });

  it('still calls a member dead when no write of the name exists anywhere', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface User {',
        '  name: string;',
        '  legacyId: number;',
        '}',
        'export const greet = (u: User) => u.name;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const member = memberOf(findings, 'legacyId');
    expect(member?.verdict).toBe('dead');
    expect(member?.evidence).toContain('no untracked write of the name');
  });
});

describe('the validation rule: a name match must survive the type its write feeds', () => {
  it('discards a write whose known contextual type does not declare the member', () => {
    // The imperative-handle shape: `deleteRecipe` sits as an excess property
    // in a literal whose contextual type is known and different. That write
    // feeds `Handle`, not the service — the match must not protect the member.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/app.ts',
      [
        'class RecipeBoxService {',
        '  deleteRecipe(): void {}',
        '  ping(): void {}',
        '}',
        'interface Handle { focus(): void; blur(): void }',
        'declare function attach(handle: Handle): void;',
        'const deleteRecipe = () => {};',
        'export const mount = () => attach({ focus() {}, blur() {}, deleteRecipe });',
        'export const keep = () => { new RecipeBoxService().ping(); };',
        '',
      ].join('\n')
    );
    project.createSourceFile('/index.ts', "import { mount, keep } from './app';\nmount();\nkeep();\n");
    const findings = analyze(project);
    const member = memberOf(findings, 'deleteRecipe');
    expect(member?.verdict).toBe('dead');
    expect(member?.evidence).toContain('every write of the name feeds another type');
    expect(member?.evidence).toMatch(/app\.ts:8/);
  });

  it('discards a write whose own literal member is read as itself', () => {
    // The popular-name shape: an unrelated hook returns { reset } and its
    // consumer reads it off the inferred type. That member is alive as its
    // own thing; sharing a name with the service method proves nothing.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/app.ts',
      [
        'class PantryService {',
        '  reset(): void {}',
        '  ping(): void {}',
        '}',
        'declare function wrap<T>(factory: () => T): T;',
        'const useForm = () => {',
        '  const reset = () => {};',
        '  return wrap(() => ({ reset }));',
        '};',
        'export const submit = () => useForm().reset();',
        'export const keep = () => new PantryService().ping();',
        '',
      ].join('\n')
    );
    project.createSourceFile('/index.ts', "import { submit, keep } from './app';\nsubmit();\nkeep();\n");
    const findings = analyze(project);
    expect(memberOf(findings, 'reset')?.verdict).toBe('dead');
    expect(memberOf(findings, 'reset')?.evidence).toContain('every write of the name feeds another type');
  });

  it('keeps a write that escapes where the analysis cannot follow, and says so', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface Config {',
        '  retries: number;',
        '  timeout: number;',
        '}',
        'export const read = (c: Config) => c.retries;',
        'declare function stash(payload: unknown): void;',
        'stash({ timeout: 250 });',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const member = memberOf(findings, 'timeout');
    expect(member?.verdict).toBe('write-only');
    expect(member?.evidence).toContain('unverified name match');
    expect(member?.evidence).toMatch(/main\.ts:7/);
  });

  it('keeps a spread that escapes into unknown as write-only, not accounted', () => {
    // The spread source's own declaration is not a read. A value carried
    // into an untyped sink can be read at runtime; the member must keep its
    // write-only protection.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface Payload {',
        '  extra: number;',
        '  used: number;',
        '}',
        'declare const base: { extra: number };',
        'declare function stash(p: unknown): void;',
        'stash({ ...base, used: 1 });',
        'export const read = (p: Payload) => p.used;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const member = memberOf(findings, 'extra');
    expect(member?.verdict).toBe('write-only');
    expect(member?.evidence).toContain('unverified name match');
  });

  it('follows a named factory to its call sites and proves the write', () => {
    // The same value flow as `wrap(() => ({ … }))`, spelled as a function
    // declaration and a variable. Equivalent shapes must converge.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface PlannerContextType {',
        '  plannerRecipes: number[];',
        '  getRecipe: () => void;',
        '}',
        'declare function provide(value: PlannerContextType): void;',
        'declare const context: PlannerContextType;',
        'const plannerRecipes: number[] = [];',
        'const getRecipe = () => {};',
        'function buildContext() {',
        '  return { plannerRecipes, getRecipe };',
        '}',
        'const contextValue = buildContext();',
        'export const run = () => provide(contextValue);',
        'export const read = () => context.getRecipe();',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const member = memberOf(findings, 'plannerRecipes');
    expect(member?.verdict).toBe('write-only');
    expect(member?.evidence).toContain('typed write');
  });

  it('follows a variable alias to the destination', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'interface Payload {',
        '  extra: number;',
        '  used: number;',
        '}',
        'declare function wrap<T>(factory: () => T): T;',
        'declare function send(p: Payload): void;',
        'declare const payload: Payload;',
        'const value = wrap(() => ({ extra: 1, used: 1 }));',
        'const forwarded = value;',
        'export const run = () => send(forwarded);',
        'export const read = () => payload.used;',
        '',
      ].join('\n')
    );
    const findings = analyze(project);
    const member = memberOf(findings, 'extra');
    expect(member?.verdict).toBe('write-only');
    expect(member?.evidence).toContain('typed write');
  });

  it('gives same-shaped siblings the same verdict despite a popular name', () => {
    // Three methods on one class, written the same way, all uncalled. A
    // verdict must not depend on how popular the identifier is elsewhere.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/app.ts',
      [
        'class RecipeBoxService {',
        '  loadRecipe(): void {}',
        '  listRecipesByCategory(): void {}',
        '  deleteRecipe(): void {}',
        '  ping(): void {}',
        '}',
        'declare function wrap<T>(factory: () => T): T;',
        'const usePlanner = () => {',
        '  const deleteRecipe = () => {};',
        '  return wrap(() => ({ deleteRecipe }));',
        '};',
        'export const erase = () => usePlanner().deleteRecipe();',
        'export const keep = () => new RecipeBoxService().ping();',
        '',
      ].join('\n')
    );
    project.createSourceFile('/index.ts', "import { erase, keep } from './app';\nerase();\nkeep();\n");
    const findings = analyze(project);
    expect(memberOf(findings, 'loadRecipe')?.verdict).toBe('dead');
    expect(memberOf(findings, 'listRecipesByCategory')?.verdict).toBe('dead');
    expect(memberOf(findings, 'deleteRecipe')?.verdict).toBe('dead');
  });
});
