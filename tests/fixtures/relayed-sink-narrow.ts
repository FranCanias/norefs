/**
 * A relay silences the parameter that carries the value, and nothing beside
 * it. `recipe` rides into the sink and goes quiet. `tag` feeds the parameter
 * next to it and stays reportable, and `dish` goes through a helper that only
 * reads a property, which relays nothing at all.
 */
function label<T extends object>(tag: string, value: T): string {
  return tag + Object.keys(value).length;
}

function titleOf(dish: NarrowDish): string {
  return dish.title;
}

export interface NarrowRecipe {
  title: string;
  quietSubtitle: string;
}

export interface NarrowTag {
  text: string;
  deadColor: string;
}

export interface NarrowDish {
  title: string;
  deadPlating: string;
}

export function describe(recipe: NarrowRecipe, tag: NarrowTag, dish: NarrowDish): string {
  return label(tag.text, recipe) + titleOf(dish);
}
