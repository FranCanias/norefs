/**
 * `satisfies` and `as const` leave the literal holding its own type, so
 * `trivetCount` is read on the property written in the literal rather than on
 * the member it was checked against. Neither one is unread, and neither can go.
 *
 * `neverWritten` is the control: nothing writes it and nothing reads it, which
 * is plain dead rather than write-only.
 */
interface TrivetLimits {
  trivetCount: number;
  neverWritten?: number;
}

const trivets = { trivetCount: 4 } satisfies TrivetLimits;

export function count(): number {
  return trivets.trivetCount;
}
