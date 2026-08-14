// A discriminant one level in. The filter names `kind` inside `payload`, so the
// type it reads `kind` on is whatever `payload` holds — not the event around it.
// Drop `kind` from either payload and the filter stops matching.
export interface RenamePayload {
  kind: 'RENAME';
  title: string;
  deadNote?: string;
}

export interface ArchivePayload {
  kind: 'ARCHIVE';
  deadReason: string;
}

export interface RenameEvent {
  payload: RenamePayload;
}

export interface ArchiveEvent {
  payload: ArchivePayload;
}

export type RecipeEvent = RenameEvent | ArchiveEvent;

export type Rename = Extract<RecipeEvent, { payload: { kind: 'RENAME' } }>;

export function renameTitle(event: Rename): string {
  return event.payload.title;
}
