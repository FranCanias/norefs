/**
 * Character predicates and string helpers the scanners share. A leaf module:
 * it imports nothing from the project, so anything may import it.
 */

/** Takes the character straight off an indexed read: past the end reads as not-space. */
export function isSpace(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\v' || c === '\f' || c === '\r' || c === '\n';
}

/** Takes the character straight off an indexed read: past the end reads as not-word. */
export function isWordPart(c: string | undefined): boolean {
  if (c === undefined) return false;
  return (
    (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '$' || c > '\x7f'
  );
}

/**
 * Bundler-only query suffixes like Vite's `?react`, `?raw`, `?worker` are not
 * part of the module name and break resolution when left on.
 */
export function stripQuerySuffix(specifier: string): string {
  const query = specifier.indexOf('?');
  return query === -1 ? specifier : specifier.slice(0, query);
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The JavaScript a hand-written declaration file describes.
 * `import './grammar'` beside a `grammar.d.ts` resolves to the declaration and
 * the type graph stops there, but the runtime loads `grammar.js`. Without this
 * pairing the implementation looks like a file nothing imports, and deleting
 * it breaks the build.
 */
export function runtimeSibling(declarationPath: string): string | undefined {
  const match = /\.d\.([cm]?)ts$/.exec(declarationPath);
  if (!match) return undefined;
  return `${declarationPath.slice(0, match.index)}.${match[1]}js`;
}
