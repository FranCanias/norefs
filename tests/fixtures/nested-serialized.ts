export interface WirePacket {
  header: { seq: number; flag: number };
}

export function pack(p: WirePacket): string {
  return JSON.stringify(p);
}
