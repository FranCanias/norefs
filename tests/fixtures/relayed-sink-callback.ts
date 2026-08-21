/**
 * A relay handed on as a value never writes an argument down, so there is
 * nothing at the site to read. The position it lands in does the talking: an
 * array method wants `(value: Row) => …`, a declared option wants
 * `(recipe: Recipe) => …`, and either way the type says what the relay will be
 * given.
 *
 * `taste` is the control: a callback with no sink in it relays nothing, and
 * `CallbackTasting` answers for its members as usual.
 */
function dump<T extends object>(value: T): string[] {
  return Object.keys(value);
}

function taste(tasting: CallbackTasting): number {
  return tasting.score;
}

interface Sitting {
  seats: number;
  unreadCloth: string;
}

interface CallbackRecipe {
  title: string;
  unreadYield: string;
}

interface CallbackTasting {
  score: number;
  deadAroma: string;
}

interface Menu {
  onRecipe: (recipe: CallbackRecipe) => unknown;
}

function serveMenu(menu: Menu, recipe: CallbackRecipe): void {
  menu.onRecipe(recipe);
}

export function seatAll(sittings: Sitting[]): number {
  sittings.forEach(dump);
  return sittings.length;
}

export function planMenu(recipe: CallbackRecipe): void {
  serveMenu({ onRecipe: dump }, recipe);
}

export function scoreAll(tastings: CallbackTasting[]): number[] {
  return tastings.map(taste);
}
