/** Takes a whole module of recipes and reads its keys at run time. */
export function box(recipes: object): number {
  return Object.keys(recipes).length;
}
