interface Store {
  ping(): void;
}

class StoreImpl {
  ping(): void {}
  reachedStructurally(): void {}
}

export function create(): Store {
  return new StoreImpl();
}

create().ping();
