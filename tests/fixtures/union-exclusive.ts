/**
 * An exclusive union writes each arm with the other arm's member set to
 * `undefined`, so a value is one shape or the other and never a mixture.
 * Nothing reads those placeholders: a guard narrows to one arm, and the read
 * lands on that arm's declaration alone. Deleting one changes what the type
 * accepts and what the guard can tell apart, which is the same standing an
 * `extends` clause gives a member no reference reaches.
 *
 * `deadCrumbs` is the control: one arm declares it and no arm beside it does.
 */
export type Baked = { loaf: string; problem?: undefined };
export type Burnt = { problem: string; loaf?: undefined; deadCrumbs: number };
export type Tasted = Baked | Burnt;

export function describeBake(result: Tasted): string {
  if (result.problem !== undefined) return result.problem;
  return result.loaf;
}
