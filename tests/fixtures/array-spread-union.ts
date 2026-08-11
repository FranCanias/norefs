// Two identical inline types, separately declared. Spreading both arrays into
// one collapses the union to a single declaration, so reads resolve to only
// one of the casts — the other would look unused. Both must be skipped.
export function collectTags(data: { regular?: unknown; custom?: unknown }): string[] {
  const regular = (data.regular || []) as Array<{ tags?: string[] }>;
  const custom = (data.custom || []) as Array<{ tags?: string[] }>;
  const all = [...regular, ...custom];
  return all.flatMap(item => item.tags ?? []);
}
