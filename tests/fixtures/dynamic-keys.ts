export interface DynamicKeys {
  alpha: number;
  beta: number;
}

export function sumAll(v: DynamicKeys): number {
  let total = 0;
  for (const key of Object.keys(v) as (keyof DynamicKeys)[]) {
    total += v[key];
  }
  return total;
}
