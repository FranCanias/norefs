interface Device {
  ping(): void;
}

class DeviceImpl {
  ping(): void {}
  reachedStructurally(): void {}
}

export function create(): Device {
  return new DeviceImpl();
}

create().ping();
