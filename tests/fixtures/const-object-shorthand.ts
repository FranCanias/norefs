/**
 * A property written the short way is still a property. `{ spareTin }` names
 * `spareTin` on the object, and whether the variable behind it is read
 * elsewhere says nothing about whether the object's member is.
 */
const spareTin = 2;
const spareJar = 3;

export const cupboard = { spareTin, spareJar, shelves: 4 };

export function tins(): number {
  return cupboard.spareTin + cupboard.shelves;
}

/** The variable is read here. `cupboard.spareJar` is read nowhere. */
export function loose(): number {
  return spareJar;
}
