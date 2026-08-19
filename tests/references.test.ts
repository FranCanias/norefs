import type { Node } from 'ts-morph';
import { Project, SyntaxKind } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { findReferencesAsNodes } from '../src/lookup/references';

function projectOf(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, text] of Object.entries(files)) project.createSourceFile(filePath, text);
  return project;
}

/** Where each reference sits, as "file:line", so expectations stay readable. */
function locations(nodes: Node[]): string[] {
  return nodes.map(node => {
    const sourceFile = node.getSourceFile();
    return `${sourceFile.getBaseName()}:${sourceFile.getLineAndColumnAtPos(node.getStart()).line}`;
  });
}

describe('findReferencesAsNodes', () => {
  it('finds uses across files and leaves out the declaration itself', () => {
    const project = projectOf({
      '/lib.ts': 'export function greet(): string {\n  return "hi";\n}\n',
      '/main.ts': 'import { greet } from "./lib";\ngreet();\n',
    });
    const greet = project.getSourceFileOrThrow('/lib.ts').getFunctionOrThrow('greet').getNameNodeOrThrow();

    expect(locations(findReferencesAsNodes(greet))).toEqual(['main.ts:1', 'main.ts:2']);
  });

  it('returns nothing for a declaration nobody uses', () => {
    const project = projectOf({ '/lib.ts': 'export function unused(): void {}\n' });
    const unused = project.getSourceFileOrThrow('/lib.ts').getFunctionOrThrow('unused').getNameNodeOrThrow();

    expect(findReferencesAsNodes(unused)).toEqual([]);
  });

  it('finds a use that comes before the declaration', () => {
    const project = projectOf({ '/main.ts': 'hoisted();\nfunction hoisted(): void {}\n' });
    const hoisted = project.getSourceFileOrThrow('/main.ts').getFunctionOrThrow('hoisted').getNameNodeOrThrow();

    expect(locations(findReferencesAsNodes(hoisted))).toEqual(['main.ts:1']);
  });

  it('reaches the declaration and its uses from an import binding, which only forwards the name', () => {
    const project = projectOf({
      '/lib.ts': 'export const value = 1;\n',
      '/main.ts': 'import { value } from "./lib";\nconsole.log(value);\n',
    });
    const binding = project
      .getSourceFileOrThrow('/main.ts')
      .getImportDeclarations()[0]!
      .getNamedImports()[0]!
      .getNameNode();

    expect(locations(findReferencesAsNodes(binding))).toEqual(['lib.ts:1', 'main.ts:2']);
  });

  it('finds a reference written inside a string literal', () => {
    const project = projectOf({
      '/main.ts': 'interface Shape {\n  kind: string;\n}\nconst shape: Shape = { kind: "x" };\nshape["kind"];\n',
    });
    const kind = project.getSourceFileOrThrow('/main.ts').getInterfaceOrThrow('Shape').getPropertyOrThrow('kind');

    const refs = findReferencesAsNodes(kind.getNameNode());
    expect(locations(refs)).toEqual(['main.ts:4', 'main.ts:5']);
    expect(refs[1]?.getKind()).toBe(SyntaxKind.StringLiteral);
  });

  it('searches a type whose name a deeply generic alias would be costly to render', () => {
    // The language service must never be asked to describe such a type; it only
    // has to say where the name occurs.
    const project = projectOf({
      '/main.ts': [
        'export type Deep<T> = { [K in keyof T]: T[K] extends object ? Deep<T[K]> : T[K] };',
        'export type Used = Deep<{ a: { b: { c: number } } }>;',
        '',
      ].join('\n'),
    });
    const deep = project.getSourceFileOrThrow('/main.ts').getTypeAliasOrThrow('Deep').getNameNode();

    expect(locations(findReferencesAsNodes(deep))).toEqual(['main.ts:1', 'main.ts:2']);
  });
});

describe('a dynamic import destructured on the spot', () => {
  // The binding a pattern creates is a symbol of its own, so the occurrence
  // says nothing about the export it names. The module the pattern reads is
  // the link, and it sits in the expression — a syntax question first, so a
  // run that asks for no member findings pays nothing for the answer.
  const kitchen = 'export const plate = 1;\nexport const bowl = 2;\n';

  it('is a reference to the export, awaited', () => {
    const project = projectOf({
      '/kitchen.ts': kitchen,
      '/menu.ts':
        'export async function serve(): Promise<number> {\n  const { plate } = await import("./kitchen");\n  return plate;\n}\n',
    });
    const plate = project.getSourceFileOrThrow('/kitchen.ts').getVariableDeclarationOrThrow('plate');

    // The pattern, and only the pattern. `plate` on line 3 is the local
    // binding, which is a symbol of its own — and one reference is all the
    // export check asks for.
    expect(locations(findReferencesAsNodes(plate.getNameNode()))).toEqual(['menu.ts:2']);
  });

  it('is a reference to the export through the name it is renamed to', () => {
    const project = projectOf({
      '/kitchen.ts': kitchen,
      '/menu.ts':
        'export async function serve(): Promise<number> {\n  const { plate: dish } = await import("./kitchen");\n  return dish;\n}\n',
    });
    const plate = project.getSourceFileOrThrow('/kitchen.ts').getVariableDeclarationOrThrow('plate');

    // The local name is the binding's own; only `plate` names the export.
    expect(locations(findReferencesAsNodes(plate.getNameNode()))).toEqual(['menu.ts:2']);
  });

  it('is a reference to the export in the callback `then` hands the namespace to', () => {
    const project = projectOf({
      '/kitchen.ts': kitchen,
      '/menu.ts':
        'export function serve(): Promise<number> {\n  return import("./kitchen").then(({ bowl }) => bowl);\n}\n',
    });
    const bowl = project.getSourceFileOrThrow('/kitchen.ts').getVariableDeclarationOrThrow('bowl');

    expect(locations(findReferencesAsNodes(bowl.getNameNode()))).toEqual(['menu.ts:2']);
  });

  it('leaves an ordinary destructuring alone', () => {
    // Same syntax, no module behind it: `plate` here is a property of a local
    // object, and crediting the export would be a reference that never happened.
    const project = projectOf({
      '/kitchen.ts': kitchen,
      '/menu.ts':
        'const tray = { plate: 9 };\nexport const serve = (): number => {\n  const { plate } = tray;\n  return plate;\n};\n',
    });
    const plate = project.getSourceFileOrThrow('/kitchen.ts').getVariableDeclarationOrThrow('plate');

    expect(locations(findReferencesAsNodes(plate.getNameNode()))).toEqual([]);
  });
});
