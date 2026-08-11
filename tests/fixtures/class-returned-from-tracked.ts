class Wheel {
  spin(): void {}
  deadBrake(): void {}
}

export class Car {
  wheel(): Wheel {
    return new Wheel();
  }
}

new Car().wheel().spin();
