/**
 * Two branches, one shape. TypeScript keeps a single set of declarations for
 * it, so every read of `mesh` lands on the first branch and the second holds
 * no references at all. Both are alive, and only the key neither branch reads
 * is reported — once, on the branch that writes it first. Removing that copy
 * leaves the second one to report itself on the next pass.
 */
function pickSieve(fine: boolean) {
  if (fine) {
    return { mesh: 'fine', rim: 'steel', deadGauge: 1 };
  }
  return { mesh: 'coarse', rim: 'brass', deadGauge: 2 };
}

export function describeSieve(): string {
  const sieve = pickSieve(true);
  return `${sieve.mesh} ${sieve.rim}`;
}
