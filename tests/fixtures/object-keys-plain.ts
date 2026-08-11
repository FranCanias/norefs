export interface PlainKeys {
  alpha: number;
  beta: number;
}

export function readAllPlain(v: PlainKeys): number[] {
  return Object.keys(v).map(k => (v as Record<string, number>)[k]);
}
