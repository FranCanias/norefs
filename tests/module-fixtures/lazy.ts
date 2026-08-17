// Everything here is reached only by a dynamic import that destructures the
// module on the spot — the shape that leaves no reference on the binding.
export const plated = 1;

export const poured = 2;

export enum Course {
  Main = 'MAIN',
}

export const lazyDead = 3;
