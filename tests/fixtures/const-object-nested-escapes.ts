/**
 * The descent stops at the first property that lets its value out. Each of
 * these reads `pantry` in a way that hands the whole inner shape onward, so a
 * member of it may be consumed with no reference to show for it — and nothing
 * under that property is reported.
 */

declare function serve(value: unknown): void;

export const forwarded = { pantry: { jars: 2, spareJars: 0 } };
serve(forwarded.pantry);

export const serialized = { pantry: { jars: 2, spareJars: 0 } };
export function wire(): string {
  return JSON.stringify(serialized.pantry);
}

export const enumerated = { pantry: { jars: 2, spareJars: 0 } };
export function keys(): string[] {
  return Object.keys(enumerated.pantry);
}

export const indexed = { pantry: { jars: 2, spareJars: 0 } };
export function pick(key: keyof typeof indexed.pantry): number {
  return indexed.pantry[key];
}
