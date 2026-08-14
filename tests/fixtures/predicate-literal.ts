// `id` is never read through a Peer value — the guard's asserted type is the
// only place the name appears. That is still a read: the narrowing is what the
// property is for, and deleting it leaves the guard asserting a field its own
// parameter type no longer declares.
export interface Peer {
  id?: string;
  label: string;
  deadWeight?: number;
}

export function isIdentified(peer: Peer): peer is Peer & { id: string } {
  return peer.label !== '';
}

export function labelOf(peer: Peer): string {
  return peer.label;
}
