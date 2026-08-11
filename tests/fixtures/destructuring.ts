export interface Destructured {
  fromParam: number;
  fromBody: number;
  deadProp: number;
}

export function readDestructured({ fromParam }: Destructured, v: Destructured): number {
  const { fromBody } = v;
  return fromParam + fromBody;
}
