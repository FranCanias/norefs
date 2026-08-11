export enum Level {
  Low = 1,
  High = 2,
}

export type LevelName = keyof typeof Level;

export const names: LevelName[] = [];
