/**
 * A write proves nothing when the value it fills in leaves. `garnish` and
 * `grams` are each written once and read nowhere here, and neither is
 * write-only: the value is handed on as an argument, and whoever takes it
 * reads what it holds.
 *
 * `garnish` goes through a binding — the literal names a shape, a const holds
 * it, and the const is passed on as a property of somebody else's argument.
 * `grams` goes straight in, nested one literal deep inside that argument.
 *
 * `spareTrays` is the control: same kind of write, and its value stays in a
 * local binding this run can account for. It is write-only, and reported.
 */
interface Plating {
  garnish: string;
}

interface Portion {
  grams: number;
}

interface TrayStock {
  trayCount: number;
  spareTrays: number;
}

declare function serve(options: { plating: Plating; portion: Portion }): void;

const plating: Plating = { garnish: 'parsley' };

const trays: TrayStock = { trayCount: 6, spareTrays: 0 };

export function plate(): number {
  serve({ plating, portion: { grams: 250 } });
  return trays.trayCount;
}
