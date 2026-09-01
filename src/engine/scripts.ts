/**
 * The arguments of a package.json script command.
 *
 * Two readers want these tokens for different reasons — one looks for paths
 * (`tsx src/server.ts`), the other for the binaries a package declares
 * (`tsc -p tsconfig.json`) — and both drop every token they cannot place. That
 * is what makes splitting this loosely safe: a token that names neither a
 * project file nor a declared binary costs nothing.
 *
 * A token can carry its value behind a name. A flag writes `--schema=path`,
 * and a command can be prefixed with an environment variable the same way:
 * got runs `NODE_OPTIONS='--import=tsx/esm' ava`, which is how a project says
 * it loads tsx. Both are peeled off, quotes and all, until what is left is
 * the value itself.
 */
export function commandTokens(command: string): string[] {
  return command
    .split(/[\s;|&]+/)
    .map(token => unwrap(token))
    .filter(token => token.length > 0 && !token.startsWith('-'));
}

/** A token stripped of the quotes around it and the name in front of its value. */
function unwrap(token: string): string {
  let value = token;
  for (let peeled = true; peeled; ) {
    const before = value;
    value = value.replace(/^['"]|['"]$/g, '').replace(/^(?:--?[\w-]+|[A-Za-z_][\w]*)=/, '');
    peeled = value !== before;
  }
  return value;
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
