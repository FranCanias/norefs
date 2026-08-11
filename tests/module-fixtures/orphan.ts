export interface OrphanShape {
  a: number;
}

export function orphanFn(v: OrphanShape): number {
  return v.a;
}
