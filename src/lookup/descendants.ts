import type { KindToNodeMappings, Node, SourceFile, SyntaxKind, ts } from 'ts-morph';

/**
 * Descendant walks over raw compiler nodes, wrapping only the matches.
 *
 * ts-morph's own descendant iterators build a wrapper object for every node
 * they visit, and a whole-project walk visits millions to keep thousands.
 * Walking `compilerNode.forEachChild` instead is about 10× cheaper and
 * allocates nothing; only a node the caller actually receives is wrapped,
 * through the same private ts-morph member the reference index leans on
 * (and `checkWrappingApi` there guards before any analysis starts).
 */
export function descendantsOfKind<K extends SyntaxKind>(sourceFile: SourceFile, kind: K): KindToNodeMappings[K][] {
  const found: KindToNodeMappings[K][] = [];
  const wrapper = sourceFile as unknown as WrappingSourceFile;
  const visit = (node: ts.Node): void => {
    if (node.kind === (kind as number)) found.push(wrapper._getNodeFromCompilerNode(node) as KindToNodeMappings[K]);
    node.forEachChild(visit);
  };
  sourceFile.compilerNode.forEachChild(visit);
  return found;
}

/** One walk for several kinds at once; the caller dispatches with `isKind`. */
export function forEachDescendantOfKinds(
  sourceFile: SourceFile,
  kinds: ReadonlySet<SyntaxKind>,
  callback: (node: Node) => void
): void {
  const wrapper = sourceFile as unknown as WrappingSourceFile;
  const visit = (node: ts.Node): void => {
    if (kinds.has(node.kind as SyntaxKind)) callback(wrapper._getNodeFromCompilerNode(node));
    node.forEachChild(visit);
  };
  sourceFile.compilerNode.forEachChild(visit);
}

interface WrappingSourceFile {
  _getNodeFromCompilerNode(compilerNode: ts.Node): Node;
}
