/**
 * Several `return` statements are several shapes of one return value. Each
 * shape answers for its own members, so a key only one branch writes is dead
 * on that branch's terms.
 */
function pickWhisk(wide: boolean) {
  if (wide) {
    return { handle: 'oak', deadWide: 0 };
  }
  return { handle: 'steel', deadNarrow: 0 };
}

export function describeWhisk(): string {
  return pickWhisk(true).handle;
}
