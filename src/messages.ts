/**
 * The first line of whatever was thrown.
 *
 * Two reasons for the trim: a ts-morph error carries a whole dump after its
 * first line, and a throw is not always an Error — reading `.message` off a
 * thrown string prints `undefined`, which tells the user nothing.
 */
export function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0].trim();
}
