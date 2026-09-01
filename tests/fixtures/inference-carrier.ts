/**
 * A conditional type matches on the names written in its `extends` clause, and
 * a library keeps those names one alias in. `raw` and `cooked` are read on
 * every compile — they are how the match finds `Cooked` — and deleting either
 * one stops the inference while `tsc` stays quiet about it.
 *
 * `deadZest` is the control: a member of a shape no pattern names.
 */
type Portions<Raw, Cooked> = { raw: Raw; cooked: Cooked; label: string };
type CookedOf<Box> = Box extends { portions: Portions<unknown, infer Cooked> } ? Cooked : never;

declare const bakedBox: { portions: Portions<string, number> };

export function servingOf(): number {
  // `label` keeps the shape from emptying, so `raw` and `cooked` answer for
  // themselves rather than folding into one finding about `Portions`.
  return bakedBox.portions.label.length + (0 as CookedOf<typeof bakedBox>);
}

type Crumbs = { zest: string; deadZest: string };

export function zestOf(crumbs: Crumbs): string {
  return crumbs.zest;
}
