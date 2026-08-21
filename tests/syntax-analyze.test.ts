import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import { loadPackages, loadProject, optionsForDir } from '../src/engine/project';
import { analyzeSyntax, isSyntaxOnly, SYNTAX_KINDS } from '../src/engine/syntax-analyze';
import type { Finding } from '../src/types';

/** A finding as a comparable line, without the ts-morph node hanging off it. */
function lines(findings: Finding[]): string[] {
  return findings
    .filter(f => SYNTAX_KINDS.includes(f.kind))
    .map(f => `${f.kind} ${f.filePath}:${f.line}:${f.column} ${f.name}`)
    .sort();
}

describe('the syntax-only pipeline', () => {
  it('answers files and dependencies without a type checker', () => {
    const tsConfigPath = path.resolve('tsconfig.json');
    const rootDir = path.dirname(tsConfigPath);
    const packages = loadPackages([tsConfigPath]);
    const options = { rootDirs: [rootDir], packages };

    const full = analyze(loadProject([tsConfigPath]), options);
    const syntax = analyzeSyntax([tsConfigPath], optionsForDir(packages, rootDir) ?? {}, options);

    expect(lines(syntax)).toEqual(lines(full));
  });

  it('agrees on a fixture that exercises every rule the two pipelines duplicate', () => {
    // Type-only import detection and suppression-mark parsing each exist twice
    // — once over a ts-morph AST, once over a token stream — and 0.6.0's
    // changelog records a real bug from the two drifting apart. The fixture
    // holds every clause shape and every mark, including the near misses.
    const tsConfigPath = path.resolve(__dirname, 'agreement-fixtures', 'tsconfig.json');
    const rootDir = path.dirname(tsConfigPath);
    const packages = loadPackages([tsConfigPath]);
    const options = { rootDirs: [rootDir], packages };

    const full = analyze(loadProject([tsConfigPath]), options);
    const syntax = analyzeSyntax([tsConfigPath], optionsForDir(packages, rootDir) ?? {}, options);

    expect(lines(syntax)).toEqual(lines(full));
    // And the fixture is not agreeing by being empty: the dead files it holds
    // are reported, the suppressed ones are not.
    const names = lines(full).map(line => line.slice(line.lastIndexOf(' ') + 1));
    expect(names).toContain('dead.ts');
    expect(names).toContain('near-miss.ts');
    expect(names).not.toContain('ignored.ts');
    expect(names).toContain('unused-dep');
    expect(names).toContain('unlisted-dep');
    expect(names).not.toContain('ignored-unlisted-dep');
    // The `.js` behind `grammar.d.ts` is loaded at run time, so neither
    // pipeline may call it a file nothing imports.
    expect(names).not.toContain('grammar.js');
    // And `require.resolve('resolved-dep')` counts as needing the package, in
    // both pipelines — while `unused-dep` beside it in the manifest does not.
    expect(names).not.toContain('resolved-dep');
    // So does a `/// <reference types>` directive, which lives in a comment
    // one pipeline reads off the AST and the other off the raw text.
    expect(names).not.toContain('directive-dep');
  });

  it('recognises which requests it can serve', () => {
    expect(isSyntaxOnly(['file'])).toBe(true);
    expect(isSyntaxOnly(['file', 'dependency', 'unlisted', 'misplaced'])).toBe(true);
    expect(isSyntaxOnly(['file', 'member'])).toBe(false);
    expect(isSyntaxOnly(['export'])).toBe(false);
    // No restriction means every kind, and most kinds need the checker.
    expect(isSyntaxOnly(undefined)).toBe(false);
    expect(isSyntaxOnly([])).toBe(false);
  });
});
