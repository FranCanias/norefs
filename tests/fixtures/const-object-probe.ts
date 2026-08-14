/**
 * `'name' in shelf` reads one named key and says nothing about the rest. It is
 * the one dynamic use that leaves the declaration reportable: the probed key is
 * used, and every other member still has to answer for itself.
 */
export const shelfLabels = {
  jam: 'Jam',
  pickles: 'Pickles',
  chutney: 'Chutney',
} as const;

export function hasJam(): boolean {
  return 'jam' in shelfLabels;
}

export function picklesLabel(): string {
  return shelfLabels.pickles;
}
