export type AliasShape = {
  aliasUsed: number;
  deadProp: number;
};

export function readAlias(v: AliasShape): number {
  return v.aliasUsed;
}

export function makeInline(): { retUsed: number; writeOnlyRet: number } {
  return { retUsed: 1, writeOnlyRet: 2 };
}

export function readInline(): number {
  return makeInline().retUsed;
}
