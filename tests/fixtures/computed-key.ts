/**
 * A key the source computes still names a member, and the type says how many.
 * `'jams' | 'pickles'` reaches exactly two, so those two are used and the rest
 * of the shelf still answers for itself — the same bargain a `'name' in v`
 * probe strikes.
 *
 * A key the type cannot pin down reaches every member, so `OpenShelf` goes
 * quiet as a whole.
 *
 * A key that fills the member in is a write, not a read. `'lids' | 'straps'`
 * names two members and nothing reads either back, so the write is the whole
 * story and both are reported — while `crates`, which somebody does read,
 * stays where it is.
 */
export interface ShelfIndex {
  jams: string[];
  pickles: string[];
  deadChutneys: string[];
}

export function forSection(index: ShelfIndex, section: 'jams' | 'pickles'): string[] {
  return index[section];
}

interface OpenShelf {
  [slot: string]: number;
  jars: number;
  crates: number;
}

export function slot(shelf: OpenShelf, name: string): number {
  return shelf[name] ?? 0;
}

export interface ShelfCounts {
  lids: number;
  straps: number;
  crates: number;
}

export function stock(counts: ShelfCounts, slot: 'lids' | 'straps'): number {
  counts[slot] = 1;
  return counts.crates;
}
