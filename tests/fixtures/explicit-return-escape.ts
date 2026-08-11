export function makeExplicit(): { a: number; b?: number } {
  return { a: 1 };
}

export function sendExplicit(): string {
  return JSON.stringify(makeExplicit());
}
