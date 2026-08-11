export class Point {
  x = 1;
  y = 2;
  deadCoord = 3;
}

const copy = { ...new Point() };
export const sum = copy.x + copy.y;
