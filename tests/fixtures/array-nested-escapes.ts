/**
 * An array hands out its elements, and an element is the shape in question. A
 * card passed on as a whole is read by whatever receives it, and a member of
 * that shape can then be consumed with no reference to show for it. The
 * elements stay quiet — `deadNote` is not reported here.
 */
export const shelf = {
  cards: [{ title: 'Focaccia', deadNote: 'draft' }],
};

export function publish(): void {
  for (const card of shelf.cards) file(card);
}

function file(card: { title: string }): void {
  void card.title;
}
