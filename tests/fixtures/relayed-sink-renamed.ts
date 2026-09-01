/**
 * A relay answers to every name it is given. `scan` is `dump` under another
 * one, and `pantry.dump` and `pantry.sift` are the same function again, held
 * on a property. Every call behind those names hands in a concrete type, and
 * the call site is the only place that type is ever written down — so it is
 * the only place the index can see what the sink will read.
 *
 * Whether the second name declares a type of its own changes nothing: a relay
 * takes whatever it is handed, so its declared parameter is wide by
 * construction. `sifted` says so out loud.
 *
 * `RenamedKettle` is the control. `stir` renames nothing and reaches no sink,
 * so a type that only goes there answers for its members as usual.
 */
function dump<T extends object>(value: T): string[] {
  return Object.keys(value);
}

const scan = dump;

const sifted: (value: object) => string[] = dump;

const pantry = { dump, sift: sifted };

function stir<T extends object>(value: T): T {
  return value;
}

export interface RenamedTin {
  label: string;
  unreadLid: string;
}

export interface RenamedCrate {
  stamp: string;
  unreadSlat: string;
}

export interface RenamedSack {
  weave: string;
  unreadKnot: string;
}

export interface RenamedKettle {
  spout: string;
  deadSpout: string;
}

export function describeTin(tin: RenamedTin): number {
  return scan(tin).length;
}

export function describeCrate(crate: RenamedCrate): number {
  return pantry.dump(crate).length;
}

export function describeSack(sack: RenamedSack): number {
  return pantry.sift(sack).length;
}

export function describeKettle(kettle: RenamedKettle): string {
  return stir(kettle).spout;
}
