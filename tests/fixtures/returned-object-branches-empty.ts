/**
 * Every branch loses every property, so the call is the finding rather than
 * the keys one by one.
 */
function tallyLadles(deep: boolean) {
  if (deep) {
    return { deepCount: 1, deepDepth: 9 };
  }
  return { shallowCount: 2 };
}

export function countLadles(): void {
  tallyLadles(true);
}
