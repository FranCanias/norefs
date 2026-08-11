interface Api {
  call(): void;
}

class ApiImpl {
  call(): void {}
}

export function make(): Api {
  const impl = new ApiImpl();
  return impl;
}

make().call();
