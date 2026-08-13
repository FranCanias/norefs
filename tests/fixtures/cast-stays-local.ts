// A cast whose value only feeds local property reads and boolean tests keeps
// its members trackable, so the dead one still reports.
export function readIds(raw: unknown): string[] {
  const items = raw as Array<{ id: string; deadFlag?: boolean }> | undefined;
  if (items) {
    return items.map(io => io.id);
  }
  return [];
}
// Referenced in-file, so the export is not dead and its members stay reported.
void readIds;
