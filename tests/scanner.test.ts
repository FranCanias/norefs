import { describe, expect, it } from 'vitest';
import { scanText } from '../src/engine/scan';

function specifiers(text: string): string[] {
  return scanText(text).specifiers.map(s => s.text);
}

describe('the scanner reads every form of import', () => {
  it('named, default, namespace, and side-effect imports', () => {
    expect(specifiers("import { a } from 'named';")).toEqual(['named']);
    expect(specifiers("import a from 'default';")).toEqual(['default']);
    expect(specifiers("import * as ns from 'star';")).toEqual(['star']);
    expect(specifiers("import 'side-effect';")).toEqual(['side-effect']);
    expect(specifiers("import a, { b, c as d } from 'mixed';")).toEqual(['mixed']);
  });

  it('type-only imports and exports', () => {
    expect(specifiers("import type { A } from 'types';")).toEqual(['types']);
    expect(specifiers("import { type A, b } from 'inline';")).toEqual(['inline']);
    expect(specifiers("export type { A } from 'reexport';")).toEqual(['reexport']);
  });

  it('re-exports', () => {
    expect(specifiers("export * from 'all';")).toEqual(['all']);
    expect(specifiers("export * as ns from 'star';")).toEqual(['star']);
    expect(specifiers("export { a, b as c } from 'named';")).toEqual(['named']);
  });

  it('dynamic imports and require calls', () => {
    expect(specifiers("const m = await import('dynamic');")).toEqual(['dynamic']);
    expect(specifiers("const m = require('cjs');")).toEqual(['cjs']);
    expect(specifiers("import m = require('equals');")).toEqual(['equals']);
  });

  it('a clause with no specifier never runs into the statement after it', () => {
    expect(specifiers("export { a };\nimport { b } from 'next';")).toEqual(['next']);
    expect(specifiers("export default foo;\nimport 'after';")).toEqual(['after']);
    expect(specifiers('export const x = 1;\nexport function f() {}\n')).toEqual([]);
    expect(specifiers('export interface X { from: string }\n')).toEqual([]);
  });

  it('several imports in one file, in source order', () => {
    expect(specifiers("import 'a';\nimport { b } from 'b';\nexport * from 'c';\n")).toEqual(['a', 'b', 'c']);
  });
});

describe('the scanner is not fooled by text that only looks like code', () => {
  it('comments', () => {
    expect(specifiers("// import { a } from 'commented';\nimport { b } from 'real';")).toEqual(['real']);
    expect(specifiers("/* import 'block';\n   still a comment */\nimport 'real';")).toEqual(['real']);
  });

  it('strings and template literals', () => {
    expect(specifiers("const s = \"import { a } from 'quoted'\";\nimport 'real';")).toEqual(['real']);
    expect(specifiers("const t = `import 'templated'`;\nimport 'real';")).toEqual(['real']);
  });

  it('a template substitution, whose code is real code', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is the source under test
    expect(specifiers("const t = `${await import('inside')}`;")).toEqual(['inside']);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is the source under test
    expect(specifiers("const t = `a${`b${1}c`}d`;\nimport 'real';")).toEqual(['real']);
  });

  it('regular expressions holding quotes and comment openers', () => {
    expect(specifiers("const r = /['\"]/;\nimport 'real';")).toEqual(['real']);
    expect(specifiers("const r = /a\\/\\/b/;\nimport 'real';")).toEqual(['real']);
    // A slash that divides, not a regular expression: the line must survive.
    expect(specifiers("const x = a / b / c;\nimport 'real';")).toEqual(['real']);
  });
});

describe('the scanner reports positions TypeScript agrees with', () => {
  it('the offset of the literal, quotes included', () => {
    const scan = scanText("import { a } from 'lib';");
    expect(scan.specifiers[0]).toMatchObject({ text: 'lib', start: 18, end: 23 });
  });

  it('offsets in UTF-16 code units, not bytes', () => {
    const text = "const emoji = '🎉';\nimport 'lib';";
    const scan = scanText(text);
    expect(text.slice(scan.specifiers[0].start, scan.specifiers[0].end)).toBe("'lib'");
  });

  it('a line table matching a split on newlines', () => {
    const text = 'a\nbb\n\nccc';
    const scan = scanText(text);
    expect([...scan.lineStarts]).toEqual([0, 2, 5, 6]);
    expect(scan.lineStarts.length).toBe(text.split('\n').length);
  });
});

describe('the scanner finds the suppression marks', () => {
  it('a line mark, and not the -file form', () => {
    expect([...scanText('const a = 1; // norefs-ignore\n').suppressedLines]).toEqual([1]);
    expect([...scanText('// norefs-ignore-file\nconst a = 1;\n').suppressedLines]).toEqual([]);
    expect([...scanText('const a = 1; // norefs-ignore because reasons\n').suppressedLines]).toEqual([1]);
  });

  it('which lines open with a comment, so a trailing mark stays on its own line', () => {
    const scan = scanText('  // norefs-ignore\nconst a = 1;\nconst b = 2; // norefs-ignore\n');
    expect([...scan.suppressedLines]).toEqual([1, 3]);
    expect([...scan.commentLines]).toEqual([1]);
  });

  it('a file mark, only in the leading comments', () => {
    expect(scanText('// norefs-ignore-file\nconst a = 1;\n').fileSuppressed).toBe(true);
    expect(scanText('/* norefs-ignore-file */\nconst a = 1;\n').fileSuppressed).toBe(true);
    expect(scanText('const a = 1;\n// norefs-ignore-file\n').fileSuppressed).toBe(false);
    expect(scanText('// norefs-ignore-files\n').fileSuppressed).toBe(false);
  });
});
