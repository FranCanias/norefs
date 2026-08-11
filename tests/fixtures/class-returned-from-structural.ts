interface Meta {
  all(): number[];
}

interface Gadget {
  meta(): Meta;
}

class MetaImpl {
  all(): number[] {
    return [];
  }
}

class GadgetImpl {
  meta(): MetaImpl {
    return new MetaImpl();
  }
}

export function getGadget(): Gadget {
  return new GadgetImpl();
}

getGadget().meta().all();
