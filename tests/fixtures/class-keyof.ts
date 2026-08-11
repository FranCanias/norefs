export class Options {
  alpha = 1;
  beta = 2;
}

export type OptionKey = keyof Options;

export const k: OptionKey = 'alpha';
