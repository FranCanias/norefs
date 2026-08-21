/**
 * The same descent, on the object a function hands back. `limits` is read as a
 * path, so its members answer for themselves.
 */
function makeRecipeBox() {
  return {
    title: 'Weeknights',
    limits: { maxServings: 4, deadMinServings: 1 },
  };
}

export function describeBox(): string {
  const box = makeRecipeBox();
  return `${box.title} (${box.limits.maxServings})`;
}
