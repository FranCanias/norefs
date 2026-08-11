interface TargetShape {
  position: { x: number; y: number };
}

export function makeTarget(position: { x: number; y: number }): TargetShape {
  return { position };
}

export function readTarget(t: TargetShape): number {
  return t.position.x + t.position.y;
}
