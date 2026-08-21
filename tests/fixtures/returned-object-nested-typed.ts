/**
 * A nested literal with a declared shape is somebody else's to report, exactly
 * as a declared const object is: `satisfies Portions` hands the shape to a
 * named type, and the collector that reads types answers for `deadHalf`.
 */
interface Portions {
  full: number;
  deadHalf?: number;
}

function makeServing() {
  return {
    label: 'dinner',
    portions: { full: 2 } satisfies Portions,
  };
}

export function servingSize(): string {
  const serving = makeServing();
  return `${serving.label}: ${serving.portions.full}`;
}
