interface Store {
  get(): number;
}

class MemStore implements Store {
  get(): number {
    return 1;
  }
  deadHelper(): void {}
}

export function open(): Store {
  return new MemStore();
}

open().get();
