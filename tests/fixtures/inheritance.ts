export interface BaseShape {
  fromBase: number;
  deadProp: number;
}

export interface DerivedShape extends BaseShape {
  own: number;
}

export function readDerived(v: DerivedShape): number {
  return v.fromBase + v.own;
}
