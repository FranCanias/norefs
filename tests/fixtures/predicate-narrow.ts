export interface Shape {
  kind: string;
}

// Circle must stay assignable to Shape for the predicate to be legal, so
// `kind` is load-bearing even though every read goes through Shape.
export interface Circle {
  kind: string;
  deadRadius?: number;
}

export function isCircle(shape: Shape): shape is Circle {
  return shape.kind === 'circle';
}
