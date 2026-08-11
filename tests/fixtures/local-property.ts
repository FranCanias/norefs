export interface Config {
  options: { retries: number; deadOption: number };
}

export function readConfig(c: Config): number {
  return c.options.retries;
}
