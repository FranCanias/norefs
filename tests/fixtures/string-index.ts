export interface StringIndex {
  indexed: number;
  deadProp: number;
}

export function readIndex(v: StringIndex): number {
  return v['indexed'];
}
