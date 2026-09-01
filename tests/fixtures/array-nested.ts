/**
 * Nesting goes through an array of literals as well as through a single one.
 * Each element is a shape of its own, and the elements answer together: the
 * checker keeps one declaration per name across identical shapes, so a name
 * any element holds a read on is alive on all of them.
 *
 * `title` is read through a `map` callback and `servings` by index, so both
 * live on every element. `deadNote` is read nowhere, on either.
 */
export const recipeBox = {
  owner: 'ada',
  cards: [
    { title: 'Focaccia', servings: 4, deadNote: 'draft' },
    { title: 'Congee', servings: 2, deadNote: 'draft' },
  ],
};

export function owner(): string {
  return recipeBox.owner;
}

export function titles(): string[] {
  return recipeBox.cards.map(card => card.title);
}

export function firstServings(): number {
  return recipeBox.cards[0].servings;
}
