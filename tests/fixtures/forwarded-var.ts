interface Holder {
  point: { x: number; y: number };
}

export function makeHolder(raw: string): Holder {
  const point: { x: number; y: number } = JSON.parse(raw);
  return { point };
}

export function readHolder(h: Holder): number {
  return h.point.x + h.point.y;
}
