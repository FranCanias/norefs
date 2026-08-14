/** No `as const`, and the same question: a member nobody reads. */
export const cupboardDefaults = {
  shelfCount: 4,
  unusedLabel: 'spare',
};

export function shelves(): number {
  return cupboardDefaults.shelfCount;
}
