export function makeThing() {
  return { consumed: 1, serializedOnly: 2, deadProp: 3 };
}

export function useThing(): string {
  const t = makeThing();
  sink(t.consumed);
  return JSON.stringify(t);
}

function sink(_n: number): void {}
