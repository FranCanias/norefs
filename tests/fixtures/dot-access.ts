export interface DotAccess {
  used: number;
  deadProp: number;
}

export function readDot(v: DotAccess): number {
  return v.used;
}
