class LazyPlugin {
  init(): void {}
}

export function register(ctor: new () => unknown): void {
  new ctor();
}

register(LazyPlugin);
