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
