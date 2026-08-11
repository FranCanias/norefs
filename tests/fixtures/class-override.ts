export abstract class Shape {
  abstract area(): number;
}

export class Circle extends Shape {
  area(): number {
    return 3;
  }
}

export function total(shapes: Shape[]): number {
  return shapes.reduce((sum, s) => sum + s.area(), 0);
}

total([new Circle()]);
