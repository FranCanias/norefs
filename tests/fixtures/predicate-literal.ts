// `id` is never read through a Crock value — the guard's asserted type is the
// only place the name appears. That is still a read: the narrowing is what the
// property is for, and deleting it leaves the guard asserting a field its own
// parameter type no longer declares.
export interface Crock {
  id?: string;
  label: string;
  deadWeight?: number;
}

export function isIdentified(crock: Crock): crock is Crock & { id: string } {
  return crock.label !== '';
}

export function labelOf(crock: Crock): string {
  return crock.label;
}
