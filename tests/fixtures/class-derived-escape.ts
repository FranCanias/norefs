interface Animal {
  speak(): void;
}

class Creature {
  speak(): void {}
}

class Dog extends Creature {}

export function adopt(): Animal {
  return new Dog();
}

adopt().speak();
