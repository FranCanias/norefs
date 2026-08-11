export interface ForInKeys {
  first: number;
  second: number;
}

export function countForIn(v: ForInKeys): number {
  let n = 0;
  for (const key in v) {
    if (key) n += 1;
  }
  return n;
}
