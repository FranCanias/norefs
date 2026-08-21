/**
 * Nothing reaches inside a property nobody reads. `pantry` is the finding, and
 * the members under it stay quiet: one death, reported once, and one edit for
 * `--fix` to make.
 */
export const larder = {
  shelves: 3,
  pantry: {
    jars: 2,
    spareJars: 0,
  },
};

export function shelves(): number {
  return larder.shelves;
}
