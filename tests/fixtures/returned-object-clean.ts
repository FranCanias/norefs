export function makeClean() {
  return { read: 1, deadProp: 2 };
}

export function useClean(): number {
  const c = makeClean();
  return c.read + makeClean().read;
}
