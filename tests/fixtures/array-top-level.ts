/**
 * An array bound at the top level is read for its elements too. Nesting used
 * to reach an array only through the property holding it, so a binding like
 * this one answered for nothing.
 *
 * `title` is read through a `map` callback and `servings` by index, so both
 * live on every element. `deadNote` is read nowhere, on either.
 */
const cards = [
  { title: 'Focaccia', servings: 4, deadNote: 'draft' },
  { title: 'Congee', servings: 2, deadNote: 'draft' },
];

export function titles(): string[] {
  return cards.map(card => card.title);
}

export function firstServings(): number {
  return cards[0]?.servings ?? 0;
}
