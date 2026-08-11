export namespace Config {
  export const used = 1;
  export const dead = 2;

  export interface DeadOptions {
    flag: boolean;
  }

  export type DeadName = string;

  export function internalUser(): number {
    return helper();
  }

  export function helper(): number {
    return used;
  }
}
