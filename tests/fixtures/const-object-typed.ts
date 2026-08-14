/**
 * A shape somebody declared is somebody else's to report. `const x: Limits = …`
 * writes members the interface owns, and `satisfies Limits` writes members that
 * interface demands — either way a named type decides what has to be there, so
 * the finding belongs to the collector that reads that type, and this one stays
 * out rather than saying the same thing in a second voice.
 *
 * Both dead members here are optional, and deliberately so: a member the
 * literal writes has a reference to show for it, which is the reference check
 * working as designed rather than the hand-off failing. The blind-spot list in
 * docs/limitations.md names that limit.
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
