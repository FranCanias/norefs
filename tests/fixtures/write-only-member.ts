/**
 * A write is a reference, and a reference check that stops at "found one"
 * calls this member alive. Two literals fill `spareCrates` in against the type
 * that declares it, and nothing ever asks for the value.
 *
 * The verdict comes with the writes it found, because the fix is one edit or
 * three: retire the member and retire what feeds it, or leave all of them
 * standing.
 */
interface LarderStock {
  crateCount: number;
  spareCrates: number;
}

const smallLarder: LarderStock = { crateCount: 12, spareCrates: 0 };
const largeLarder: LarderStock = { crateCount: 48, spareCrates: 4 };

export function totalCrates(): number {
  return smallLarder.crateCount + largeLarder.crateCount;
}
