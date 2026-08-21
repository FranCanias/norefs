/**
 * One branch hands back something other than a literal. A read of the return
 * value could land on that shape instead, so the function is left alone and
 * `unproven` goes unreported.
 */
const wireColander = { rim: 'wire' } as const;

function pickColander(wide: boolean) {
  if (wide) {
    return { rim: 'oak', unproven: 1 };
  }
  return wireColander;
}

export function describeColander(): string {
  return pickColander(true).rim;
}
