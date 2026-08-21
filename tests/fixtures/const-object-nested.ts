/**
 * A nested literal is a shape of its own, and its members die on their own
 * terms — as long as every read of the property holding it keeps the value
 * local. `oven` is read as a path, `timings` through a destructuring, and both
 * let the check reach the members underneath. It goes as deep as the reads do:
 * `oven.grill` is read one more level in.
 */
export const kitchenDefaults = {
  oven: {
    tray: 'steel',
    deadRack: 'wire',
    grill: { heat: 3, deadSetting: 'auto' },
  },
  spices: {
    jar: 'glass',
    deadTin: 'steel',
  },
  timings: {
    proof: 45,
    deadRest: 10,
  },
};

export function tray(): string {
  return kitchenDefaults.oven.tray;
}

export function heat(): number {
  return kitchenDefaults.oven.grill.heat;
}

export function jar(): string {
  return kitchenDefaults['spices'].jar;
}

export function proof(): number {
  const { timings } = kitchenDefaults;
  return timings.proof;
}
