/**
 * A shape somebody declared is somebody else's to report. `const x: Limits = …`
 * writes members the interface owns, and `satisfies Limits` writes members that
 * interface demands — either way a named type decides what has to be there, so
 * the finding belongs to the collector that reads that type, and this one stays
 * out rather than saying the same thing in a second voice.
 *
 * Both dead members here are optional, and deliberately so: no literal fills
 * them in, so the finding is a plain dead member. A member a literal does fill
 * in and nothing reads is the `write-only` verdict's story, told in
 * write-only-member.ts.
 */
interface PantryLimits {
  jarCount: number;
  spareJars?: number;
}

interface ShelfLimits {
  shelfCount: number;
  spareShelves?: number;
}

export const pantryLimits: PantryLimits = { jarCount: 12 };

export const shelfLimits = { shelfCount: 4 } satisfies ShelfLimits;

export function counts(): number {
  return pantryLimits.jarCount + shelfLimits.shelfCount;
}
