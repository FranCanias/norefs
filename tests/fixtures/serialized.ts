export interface Serialized {
  wireField: number;
  otherWireField: number;
}

export function toJson(v: Serialized): string {
  return JSON.stringify(v);
}
