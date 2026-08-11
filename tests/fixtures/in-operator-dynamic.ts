export interface ProbedDynamic {
  one: number;
  two: number;
}

export function hasKey(v: ProbedDynamic, k: string): boolean {
  return k in v;
}
