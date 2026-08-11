export enum Status {
  Active = 'active',
  Dead = 'dead-value',
}

export function isActive(s: Status): boolean {
  return s === Status.Active;
}
