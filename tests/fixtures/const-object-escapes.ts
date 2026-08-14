/**
 * Four ways an object hands out every member at once. Each one silences its
 * own declaration: a reference count that missed a read is the wrong answer,
 * not a softer one.
 */

declare function serve(value: unknown): void;

export const enumerated = { first: 1, second: 2 } as const;
serve(Object.values(enumerated));

export const spread = { first: 1, second: 2 } as const;
serve({ ...spread });

export const indexed = { first: 1, second: 2 } as const;
export function pick(key: 'first' | 'second'): number {
  return indexed[key];
}

export const passedWhole = { first: 1, second: 2 } as const;
serve(passedWhole);
