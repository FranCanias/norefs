export interface Implemented {
  implementedNeverCalled(): void;
  mirroredField: number;
}

export class Impl implements Implemented {
  mirroredField = 0;
  implementedNeverCalled(): void {}
}
