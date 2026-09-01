import { describe, expect, it } from 'vitest';
import { analyzeSource } from './helpers';

/**
 * A property can hold several shapes at once. `{ cards: [{ … }, { … }] }` is
 * one shape per element, and the elements answer together — but only where
 * every element stays local, because an element is the shape in question and
 * a card passed on is read by whatever receives it.
 */
function reported(lines: string[]): string[] {
  return analyzeSource(lines.join('\n'))
    .filter(f => f.kind === 'member' || f.kind === 'empty-type')
    .map(f => `${f.kind}:${f.name}`);
}

/** The array under test, read by whatever the case does with `cards`. */
function box(...readers: string[]): string[] {
  return [
    'const recipeBox = {',
    '  cards: [',
    "    { title: 'Focaccia', deadNote: 'draft' },",
    "    { title: 'Congee', deadNote: 'draft' },",
    '  ],',
    '};',
    ...readers,
    '',
  ];
}

describe('reads that reach an array element', () => {
  it('a map callback', () => {
    expect(
      reported(box('export function titles(): string[] {', '  return recipeBox.cards.map(c => c.title);', '}'))
    ).toEqual(['member:deadNote', 'member:deadNote']);
  });

  it('an index', () => {
    expect(reported(box('export function first(): string {', '  return recipeBox.cards[0].title;', '}'))).toEqual([
      'member:deadNote',
      'member:deadNote',
    ]);
  });

  it('a for…of binding', () => {
    expect(
      reported(
        box(
          'export function all(): string {',
          '  let out = "";',
          '  for (const c of recipeBox.cards) out += c.title;',
          '  return out;',
          '}'
        )
      )
    ).toEqual(['member:deadNote', 'member:deadNote']);
  });

  it('a destructured callback parameter', () => {
    expect(
      reported(box('export function titles(): string[] {', '  return recipeBox.cards.map(({ title }) => title);', '}'))
    ).toEqual(['member:deadNote', 'member:deadNote']);
  });

  it('a filter whose result is read one property at a time', () => {
    expect(
      reported(
        box(
          'export function titles(): string[] {',
          "  return recipeBox.cards.filter(c => c.title !== '').map(c => c.title);",
          '}'
        )
      )
    ).toEqual(['member:deadNote', 'member:deadNote']);
  });

  it('a read on one element keeps the name alive on every element', () => {
    // `title` is read through the one declaration the checker kept. The
    // sibling holds zero references and is alive all the same.
    const findings = reported(box('export function first(): string {', '  return recipeBox.cards[0].title;', '}'));
    expect(findings).not.toContain('member:title');
  });
});

describe('reads that let an array element out', () => {
  const silent = (...readers: string[]): void => {
    expect(reported(box(...readers))).toEqual([]);
  };

  it('a callback written elsewhere', () => {
    silent(
      'declare function file(c: unknown): void;',
      'export function go(): void {',
      '  recipeBox.cards.forEach(file);',
      '}'
    );
  });

  it('an element passed on from inside the callback', () => {
    silent(
      'declare function file(c: unknown): void;',
      'export function go(): void {',
      '  recipeBox.cards.forEach(c => file(c));',
      '}'
    );
  });

  it('an element passed on from a for…of', () => {
    silent(
      'declare function file(c: unknown): void;',
      'export function go(): void {',
      '  for (const c of recipeBox.cards) file(c);',
      '}'
    );
  });

  it('an element passed on from an index', () => {
    silent(
      'declare function file(c: unknown): void;',
      'export function go(): void {',
      '  file(recipeBox.cards[0]);',
      '}'
    );
  });

  it('the array handed over whole', () => {
    silent('declare function save(c: unknown): void;', 'export function go(): void {', '  save(recipeBox.cards);', '}');
  });

  it('the array spread into another', () => {
    silent('export function go(): unknown[] {', '  return [...recipeBox.cards];', '}');
  });

  it('the array serialized', () => {
    silent('export function go(): string {', '  return JSON.stringify(recipeBox.cards);', '}');
  });

  it('a method this check does not follow', () => {
    silent(
      'export function go(): string {',
      '  return recipeBox.cards.sort((a, b) => a.title.localeCompare(b.title))[0].title;',
      '}'
    );
  });

  it('a filter result handed over whole', () => {
    silent(
      'declare function save(c: unknown): void;',
      'export function go(): void {',
      "  save(recipeBox.cards.filter(c => c.title !== ''));",
      '}'
    );
  });

  it('an array holding anything but literals', () => {
    expect(
      reported([
        "const spare = { title: 'Congee', deadNote: 'draft' };",
        'const recipeBox = {',
        "  cards: [{ title: 'Focaccia', deadNote: 'draft' }, spare],",
        '};',
        'export function titles(): string[] {',
        '  return recipeBox.cards.map(c => c.title);',
        '}',
        '',
      ])
    ).toEqual([]);
  });
});

describe('sibling elements are not evidence against each other', () => {
  it('keeps the verdict dead rather than softening it to a name match', () => {
    // Each element writes `deadNote`. A sibling writing the same key is this
    // member written twice, not a name that happens to match it — reading it
    // as a write would hedge a verdict the analysis has proven.
    const findings = analyzeSource(
      box('export function titles(): string[] {', '  return recipeBox.cards.map(c => c.title);', '}').join('\n')
    ).filter(f => f.kind === 'member');
    expect(findings.map(f => [f.name, f.verdict])).toEqual([
      ['deadNote', 'dead'],
      ['deadNote', 'dead'],
    ]);
  });
});

describe('an array whose elements all empty', () => {
  it('folds onto the property, counting what the shape offers', () => {
    const findings = analyzeSource(
      [
        'const recipeBox = {',
        "  owner: 'ada',",
        '  cards: [',
        "    { deadNote: 'draft' },",
        "    { deadNote: 'draft' },",
        '  ],',
        '};',
        'export function owner(): string {',
        '  return recipeBox.owner;',
        '}',
        'export function count(): number {',
        '  return recipeBox.cards.length;',
        '}',
        '',
      ].join('\n')
    );
    expect(findings.map(f => [f.kind, f.name])).toEqual([['empty-type', 'cards']]);
    const emptied = findings.find(f => f.kind === 'empty-type');
    expect(emptied?.context).toBe('property');
    // Two elements writing one key offer one member between them.
    expect(emptied?.swallowed).toBe(1);
  });
});
