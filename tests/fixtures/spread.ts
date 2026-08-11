export interface SpreadSource {
  keptSameType: number;
  carriedCrossType: number;
  deadProp: number;
}

export function readSpread(v: SpreadSource): number {
  const sameType: SpreadSource = { ...v };
  const crossType = { ...v, extra: 1 };
  return sameType.keptSameType + crossType.carriedCrossType;
}
