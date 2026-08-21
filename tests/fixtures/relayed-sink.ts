/**
 * A sink reached through a helper is a sink. `dump` reads the keys of whatever
 * it is handed, but the `Object.keys` call standing inside it sees only `T` —
 * the concrete type never gets there. `dump(recipe)` is where `RelayedRecipe`
 * becomes untrackable, so that is where the index looks, and every member of
 * it stays quiet.
 *
 * `plate` reaches the same helper through two more hops, one of them a method,
 * and has to go just as quiet. `jar` reaches a relay that calls itself, which
 * the walk has to survive: it follows each parameter once, and that is what
 * ends it.
 */
function dump<T extends object>(value: T): string[] {
  return Object.keys(value);
}

function dumpDeep<T extends object>(value: T): string[] {
  const keys = Object.keys(value);
  return keys.length > 1 ? dumpDeep(value) : keys;
}

const forward = <T extends object>(value: T): number => dump(value).length;

const kitchen = {
  weigh<T extends object>(value: T): number {
    return forward(value);
  },
};

export interface RelayedRecipe {
  title: string;
  unreadLabel: string;
}

export interface RelayedPlate {
  garnish: string;
  unreadRim: string;
}

export interface RelayedJar {
  contents: string;
  unreadSeal: string;
}

export function describeRecipe(recipe: RelayedRecipe): number {
  return dump(recipe).length;
}

export function describePlate(plate: RelayedPlate): number {
  return kitchen.weigh(plate);
}

export function describeJar(jar: RelayedJar): number {
  return dumpDeep(jar).length;
}
