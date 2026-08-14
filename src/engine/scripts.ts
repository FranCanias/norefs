/**
 * The arguments of a package.json script command.
 *
 * Two readers want these tokens for different reasons — one looks for paths
 * (`tsx src/server.ts`), the other for the binaries a package declares
 * (`tsc -p tsconfig.json`) — and both drop every token they cannot place. That
 * is what makes splitting this loosely safe: a token that names neither a
 * project file nor a declared binary costs nothing.
 */
export function commandTokens(command: string): string[] {
  return command
    .split(/[\s;|&]+/)
    .map(token => token.replace(/^--?[\w-]+=/, '').replace(/^['"]|['"]$/g, ''))
    .filter(token => token.length > 0 && !token.startsWith('-'));
}

/** Every `scripts` entry of a parsed manifest, in the order it was written. */
export function scriptsOf(manifest: unknown): Array<{ name: string; command: string }> {
  if (typeof manifest !== 'object' || manifest === null) return [];
  const scripts = (manifest as { scripts?: unknown }).scripts;
  if (typeof scripts !== 'object' || scripts === null) return [];
  return Object.entries(scripts)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([name, command]) => ({ name, command }));
}
