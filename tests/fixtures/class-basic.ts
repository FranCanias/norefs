export class Greeter {
  greeting = 'hi';
  deadProp = 0;

  greet(): string {
    return this.greeting;
  }

  deadMethod(): void {}

  get deadGetter(): number {
    return 1;
  }
}

export const g = new Greeter();
g.greet();
