export interface UsedShape {
  width: number;
}

export interface DeadShape {
  height: number;
}

export type DeadAlias = string;

export enum DeadEnum {
  A = 1,
}

export function usedFn(): number {
  return 1;
}

export function deadFn(): void {}

export const deadValue = 42;
