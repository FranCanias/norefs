export interface ProbedLiteral {
  checkedProp?: number;
  deadProp?: number;
}

export function hasChecked(v: ProbedLiteral): boolean {
  return 'checkedProp' in v;
}
