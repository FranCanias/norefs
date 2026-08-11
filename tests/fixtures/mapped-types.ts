export interface Mapped {
  viaPartial: number;
  viaPick: number;
  deadProp: number;
}

export function readPartial(v: Partial<Mapped>): number {
  return v.viaPartial ?? 0;
}

export type PickedOnly = Pick<Mapped, 'viaPick'>;

export function readPicked(v: PickedOnly): number {
  return v.viaPick;
}
