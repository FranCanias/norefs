/**
 * A member declared `never` is how a type is made nominal: no value can be
 * given to a `never`, so no plain object passes as one of these. Nothing reads
 * it — a read yields `never` — and deleting it leaves `{}`, which every object
 * matches, so the check the brand exists for stops checking anything.
 *
 * `deadCrust` is the control: an ordinary member of the same shape.
 */
interface Scorched {
  __scorched: never;
  deadCrust: string;
}

export function burn(): Scorched {
  throw new Error('the loaf is beyond saving');
}
