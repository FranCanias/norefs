export interface KeyofTarget {
  viaGenericGet: number;
  deadProp: number;
}

function getProp<K extends keyof KeyofTarget>(o: KeyofTarget, k: K): KeyofTarget[K] {
  return o[k];
}

export function readViaKeyof(v: KeyofTarget): number {
  return getProp(v, 'viaGenericGet');
}
