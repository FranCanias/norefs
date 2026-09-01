import type { Node } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';

/**
 * The shapes a set of declarations names, and the shapes those name in turn.
 *
 * A declaration is a door, and what a consumer reaches through it is not only
 * the name written on it. `export { match }` publishes a function whose return
 * type is an interface declared three files away, and every method on that
 * interface is API the package exists to provide — reached by calling `match`,
 * with nothing importing the interface by name and no reference to show for
 * it. An exported union is the same story one step shorter: the alias is
 * public, its arms are local interfaces, and a consumer holds one of the arms.
 *
 * So a set of doors is closed over the types written behind them. A type a
 * reachable signature names is reachable, transitively, until nothing new
 * turns up. Only the surface counts: a statement inside a function body names
 * types the caller can never hold, so a body is where the walk stops.
 */

/** Code, rather than surface: what a body names, a consumer cannot reach. */
const BODY_KINDS = new Set([SyntaxKind.Block, SyntaxKind.ModuleBlock, SyntaxKind.ClassStaticBlockDeclaration]);

export function shapesNamedBy(roots: Iterable<Node>): Set<Node> {
  const found = new Set<Node>();
  const queue: Node[] = [];
  for (const root of roots) {
    if (found.has(root)) continue;
    found.add(root);
    queue.push(root);
  }
  for (let head = 0; head < queue.length; head++) {
    // The queue is walked by index, so every entry is a node that was pushed.
    for (const named of typesNamedBy(queue[head] as Node)) {
      if (found.has(named)) continue;
      found.add(named);
      queue.push(named);
    }
  }
  return found;
}

/** Every project declaration a type written on this declaration's surface names. */
function typesNamedBy(declaration: Node): Node[] {
  const found: Node[] = [];
  const visit = (node: Node): void => {
    if (BODY_KINDS.has(node.getKind())) return;
    const written = typeNameOf(node);
    if (written) found.push(...declarationsOf(written));
    if (node.isKind(SyntaxKind.ArrowFunction)) {
      // A concise body is a body: `() => value as Flags` writes a statement
      // without the braces that would say so.
      const body = node.getBody();
      node.forEachChild(child => {
        if (child !== body) visit(child);
      });
      return;
    }
    node.forEachChild(visit);
  };
  declaration.forEachChild(visit);
  return found;
}

/** The name node of a written type: `Portions<T>` names `Portions`, `extends Base` names `Base`. */
function typeNameOf(node: Node): Node | undefined {
  if (node.isKind(SyntaxKind.TypeReference)) return node.getTypeName();
  if (node.isKind(SyntaxKind.ExpressionWithTypeArguments)) return node.getExpression();
  return undefined;
}

/**
 * What a written name declares, an import alias followed to the other side.
 * Packages are left out: nothing in this project declares them, so nothing
 * here reports them either.
 */
function declarationsOf(written: Node): Node[] {
  const symbol = written.getSymbol();
  if (!symbol) return [];
  return (symbol.getAliasedSymbol() ?? symbol)
    .getDeclarations()
    .filter(declaration => !declaration.getSourceFile().isInNodeModules());
}
