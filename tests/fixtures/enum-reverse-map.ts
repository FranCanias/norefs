export enum Code {
  Ok = 200,
  NotFound = 404,
}

export function nameOf(n: number): string {
  return Code[n];
}
