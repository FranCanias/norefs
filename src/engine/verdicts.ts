import path from 'node:path';
import type { InterfaceDeclaration, Node, Project, SourceFile, TypeAliasDeclaration, TypeNode } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import type { Finding, Verdict } from '../types';
import { referenceIndex } from './reference-index';
import { findReferencesAsNodes } from './references';

/**
 * Turn the single "unused" label into a verdict per finding.
 *
 * Export findings carry their verdict already (dead or over-exported, from the
 * reference classification). Member findings start as `dead` and soften when a
 * signal says the analysis is on thin ice:
 * - the owner type — or a twin of it — sits in the serialization-boundary
 *   closure → `contract`; a twin across the boundary merges into the same
 *   verdict instead of competing with it, because the duplication is the
 *   contract evidence
 * - a structural twin of the owner is read where this member is not → `shadowed`
 * - a write of this name survives validation against the type it feeds →
 *   `write-only`, as a proven typed write or a labeled unverified name match
 *
 * An empty-type finding takes the most cautious verdict of its members: it
 * only exists because every member was reported.
 */
export function assignVerdicts(project: Project, findings: Finding[], cwd: string): void {
  const memberFindings = findings.filter(f => f.kind === 'member' && f.node && !f.verdict);
  if (memberFindings.length === 0) {
    assignEmptyTypeVerdicts(findings);
    return;
  }

  const boundary = boundaryClosure(project);
  const twins = new TwinIndex(project);
  const index = referenceIndex(project);

  for (const finding of memberFindings) {
    const owner = namedTypeAncestor(finding.node as Node);
    const ownEvidence = owner ? boundary.get(owner) : undefined;
    // The twin candidates cost only map lookups — no reference queries — so
    // every one of them can be checked against the boundary. A read
    // structural twin must not mask a same-named twin across the boundary.
    const candidates = owner ? twins.twinDeclarations(owner) : [];
    const far = candidates.find(candidate => boundary.has(candidate.declaration));
    if (ownEvidence !== undefined || far) {
      finding.verdict = 'contract';
      const farEvidence = far && boundary.get(far.declaration);
      finding.evidence = contractEvidence(ownEvidence, far ?? candidates[0], farEvidence, cwd);
      continue;
    }
    // Only a member outside every boundary pays for the reference-checked
    // twin lookup the shadowed verdict needs.
    const shadow = owner ? twins.readTwinMember(owner, finding.name) : undefined;
    if (shadow) {
      finding.verdict = 'shadowed';
      const where = `\`${shadow.typeName}\` (${location(shadow.node, cwd)})`;
      finding.evidence = shadow.readsMember
        ? `a ${shadow.sameName ? 'same-named' : 'structural'} twin ${where} reads \`${finding.name}\``
        : `a same-named ${where} overlaps this shape`;
      continue;
    }
    const nameNode = (finding.node as Node & { getNameNode(): Node }).getNameNode();
    const sites = index.unattributedWriteSites(finding.name, nameNode);
    if (sites.typed.length > 0) {
      finding.verdict = 'write-only';
      const writes = sites.typed.length === 1 ? 'a typed write at' : 'typed writes at';
      finding.evidence = `${writes} ${siteList(sites.typed, cwd)} ${sites.typed.length === 1 ? 'feeds' : 'feed'} this member — proven, never read`;
      // The proof is the worklist: a fix that retires this member retires
      // these writes with it, or refuses and says which one stopped it.
      finding.writeSites = sites.typed;
      continue;
    }
    if (sites.unverified.length > 0) {
      finding.verdict = 'write-only';
      const one = sites.unverified.length === 1;
      finding.evidence = `\`${finding.name}\` is assigned at ${siteList(sites.unverified, cwd)} — ${one ? 'an unverified name match' : 'unverified name matches'} the analysis could not type either way`;
      continue;
    }
    finding.verdict = 'dead';
    const writes =
      sites.accounted.length === 0
        ? 'no untracked write of the name'
        : `every write of the name feeds another type (${siteList(sites.accounted, cwd)})`;
    finding.evidence = `no references anywhere, no twin type reads \`${finding.name}\`, no serialization boundary, ${writes}`;
  }

  assignEmptyTypeVerdicts(findings);
}

/**
 * One conceptual fact, one verdict: when the owner crosses a boundary, when
 * its twin does, or both, the finding is a contract and the evidence names
 * every link the analysis has.
 */
function contractEvidence(
  ownEvidence: string | undefined,
  twin: TwinCandidate | undefined,
  farEvidence: string | undefined,
  cwd: string
): string {
  const label =
    twin &&
    `${twin.sameName ? 'same-named' : 'structural'} twin \`${twin.typeName}\` (${location(twin.nameNode, cwd)})`;
  if (ownEvidence !== undefined) {
    if (!label) return ownEvidence;
    // A twin also inside the boundary closure is provably the far side; one
    // outside it is still the same duplicated shape, named so the reader can
    // connect the two declarations the analysis already linked.
    return farEvidence !== undefined
      ? `${ownEvidence}, and its ${label} declares the far side of the same contract`
      : `${ownEvidence}; a ${label} duplicates this shape`;
  }
  return `its ${label} is the far side of a serialization boundary (${farEvidence}) — this declaration is the near side of the same contract`;
}

/** Up to three site locations, spelled out; past that, an honest count. */
function siteList(nodes: Node[], cwd: string): string {
  const locations = nodes.map(node => location(node, cwd));
  if (locations.length === 1) return locations[0];
  if (locations.length <= 3) {
    return `${locations.slice(0, -1).join(', ')} and ${locations[locations.length - 1]}`;
  }
  const rest = locations.length - 3;
  return `${locations[0]}, ${locations[1]}, ${locations[2]} and ${rest} more ${rest === 1 ? 'site' : 'sites'}`;
}

/** The most cautious verdict among an emptied type's own reported members. */
function assignEmptyTypeVerdicts(findings: Finding[]): void {
  const caution: Verdict[] = ['dead', 'write-only', 'shadowed', 'contract'];
  for (const finding of findings) {
    if (finding.kind !== 'empty-type') continue;
    let worst = 0;
    for (const member of findings) {
      if (member.kind !== 'member' || member.filePath !== finding.filePath) continue;
      if (member.context.includes(`\`${finding.name}\``)) {
        worst = Math.max(worst, caution.indexOf(member.verdict ?? 'dead'));
        if (member.verdict && member.verdict !== 'dead' && !finding.evidence) finding.evidence = member.evidence;
      }
    }
    finding.verdict = caution[worst];
  }
}

// ------------------------------------------------------- serialization boundary

const PARSE_CALLS = new Set(['parse', 'structuredClone']);
const SEND_CALLS = new Set(['stringify', 'postMessage', 'structuredClone']);

/**
 * Named types whose values cross a serialization boundary, mapped to the
 * evidence sentence. Seeds come from three edges:
 * - `JSON.parse`/`structuredClone` results and `JSON.stringify`/`postMessage`
 *   arguments — the classic serialization calls;
 * - calls on values a project declaration file declares (an IPC bridge, a
 *   preload global): the implementation is outside this program, so both the
 *   arguments and the asserted result cross a boundary;
 * - any call whose result the types do not trace (`any`/`unknown`, or a
 *   promise of them) landing on a named type by assertion or annotation —
 *   `res.json() as Config` is the same pattern as `JSON.parse`.
 * The closure adds every named type referenced inside a boundary type's
 * declaration: a member of a wire format is wire format too.
 */
function boundaryClosure(project: Project): Map<Node, string> {
  const boundary = new Map<Node, string>();
  const queue: Node[] = [];
  const add = (decl: Node, evidence: string): void => {
    if (boundary.has(decl)) return;
    boundary.set(decl, evidence);
    queue.push(decl);
  };

  for (const sourceFile of project.getSourceFiles()) {
    if (sourceFile.isDeclarationFile()) continue;
    collectBoundarySeeds(sourceFile, add);
  }

  // Propagate into the declarations' bodies.
  for (let decl = queue.pop(); decl; decl = queue.pop()) {
    const evidence = boundary.get(decl) as string;
    const name = declName(decl);
    for (const target of referencedTypeDeclarations(decl)) {
      add(target, `\`${declName(target)}\` is part of \`${name}\`, which ${evidence}`);
    }
  }
  return boundary;
}

function collectBoundarySeeds(sourceFile: SourceFile, add: (decl: Node, evidence: string) => void): void {
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    const name = callee.isKind(SyntaxKind.PropertyAccessExpression)
      ? callee.getName()
      : callee.isKind(SyntaxKind.Identifier)
        ? callee.getText()
        : undefined;
    if (name === undefined) continue;
    const label = callee.getText().length <= 30 ? callee.getText() : name;

    // Parse side: the type the result is asserted or annotated to.
    if (PARSE_CALLS.has(name)) {
      const typeNode = resultTypeNode(call);
      if (typeNode) {
        for (const decl of typeDeclarationsIn(typeNode)) {
          add(decl, `its values come out of \`${label}(…)\``);
        }
      }
    }

    // Send side: the declared type of what goes in.
    if (SEND_CALLS.has(name)) {
      for (const argument of call.getArguments()) {
        for (const decl of declarationsOfExpressionType(argument)) {
          add(decl, `its values go into \`${label}(…)\``);
        }
      }
    }

    // A callee a project .d.ts declares runs outside this program: an IPC
    // bridge, a preload global. What goes in and what is asserted out both
    // cross that edge.
    if (hasAmbientCallee(call)) {
      for (const argument of call.getArguments()) {
        for (const decl of declarationsOfExpressionType(argument)) {
          add(decl, `its values go into \`${label}(…)\`, which runs outside this program`);
        }
      }
      const typeNode = resultTypeNode(call);
      if (typeNode) {
        for (const decl of typeDeclarationsIn(typeNode)) {
          add(decl, `its values come out of \`${label}(…)\`, which runs outside this program`);
        }
      }
      continue;
    }

    // A result the types do not trace, pinned to a named type by hand, is
    // the JSON.parse pattern whatever the callee is called.
    const typeNode = resultTypeNode(call);
    if (typeNode && returnsUntracedValue(call)) {
      for (const decl of typeDeclarationsIn(typeNode)) {
        add(decl, `its values come out of \`${label}(…)\`, which the types do not trace`);
      }
    }
  }
}

/** True when the callee resolves to a declaration file inside the project. */
export function hasAmbientCallee(call: Node & { getExpression(): Node }): boolean {
  const symbol = call.getExpression().getSymbol();
  return (symbol?.getDeclarations() ?? []).some(decl => {
    const sourceFile = decl.getSourceFile();
    return sourceFile.isDeclarationFile() && !sourceFile.isInNodeModules();
  });
}

/** True when the call's result type is any/unknown, or a promise of them. */
function returnsUntracedValue(call: Node): boolean {
  const type = call.getType();
  if (type.isAny() || type.isUnknown()) return true;
  return type.getSymbol()?.getName() === 'Promise' && type.getTypeArguments().some(t => t.isAny() || t.isUnknown());
}

/** The type node a call result lands on: `call() as T`, `const x: T = call()`. */
function resultTypeNode(call: Node): TypeNode | undefined {
  let node: Node = call;
  for (;;) {
    const parent = node.getParent();
    if (!parent) return undefined;
    if (parent.isKind(SyntaxKind.ParenthesizedExpression) || parent.isKind(SyntaxKind.AwaitExpression)) {
      node = parent;
      continue;
    }
    if (parent.isKind(SyntaxKind.AsExpression)) {
      const typeNode = parent.getTypeNode();
      // `as unknown as T` keeps climbing through the unknown step.
      if (
        typeNode &&
        (typeNode.getKind() === SyntaxKind.UnknownKeyword || typeNode.getKind() === SyntaxKind.AnyKeyword)
      ) {
        node = parent;
        continue;
      }
      return typeNode;
    }
    if (parent.isKind(SyntaxKind.VariableDeclaration)) return parent.getTypeNode();
    return undefined;
  }
}

/** Project-defined interface, type alias, and enum declarations a type node references. */
function typeDeclarationsIn(typeNode: TypeNode): Node[] {
  const out: Node[] = [];
  const nodes = typeNode.isKind(SyntaxKind.TypeReference)
    ? [typeNode, ...typeNode.getDescendantsOfKind(SyntaxKind.TypeReference)]
    : typeNode.getDescendantsOfKind(SyntaxKind.TypeReference);
  for (const reference of new Set(nodes)) {
    const symbol = reference.getTypeName().getSymbol();
    for (const decl of symbol?.getAliasedSymbol()?.getDeclarations() ?? symbol?.getDeclarations() ?? []) {
      if (isNamedTypeDeclaration(decl) && !decl.getSourceFile().isDeclarationFile()) out.push(decl);
    }
  }
  return out;
}

/** The named project types behind an expression's declared type. */
function declarationsOfExpressionType(expression: Node): Node[] {
  const type = expression.getType();
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  return (symbol?.getDeclarations() ?? []).filter(
    decl => isNamedTypeDeclaration(decl) && !decl.getSourceFile().isDeclarationFile()
  );
}

/** Named types referenced anywhere inside this declaration's body. */
function referencedTypeDeclarations(decl: Node): Node[] {
  const out: Node[] = [];
  for (const reference of decl.getDescendantsOfKind(SyntaxKind.TypeReference)) {
    const symbol = reference.getTypeName().getSymbol();
    for (const target of symbol?.getAliasedSymbol()?.getDeclarations() ?? symbol?.getDeclarations() ?? []) {
      if (target !== decl && isNamedTypeDeclaration(target) && !target.getSourceFile().isDeclarationFile()) {
        out.push(target);
      }
    }
  }
  return out;
}

function isNamedTypeDeclaration(node: Node): boolean {
  return (
    node.isKind(SyntaxKind.InterfaceDeclaration) ||
    node.isKind(SyntaxKind.TypeAliasDeclaration) ||
    node.isKind(SyntaxKind.EnumDeclaration)
  );
}

function declName(decl: Node): string {
  return (decl as InterfaceDeclaration).getName() ?? '?';
}

// ----------------------------------------------------------------------- twins

interface TwinMatch {
  typeName: string;
  /** Where the evidence points: the twin's member, or the twin itself. */
  node: Node;
  /** The twin declares the flagged name and something reads it there. */
  readsMember: boolean;
  sameName: boolean;
}

/** A twin found by shape alone — no reference lookups — for the contract merge. */
interface TwinCandidate {
  declaration: Node;
  typeName: string;
  nameNode: Node;
  sameName: boolean;
}

/**
 * Duplicated types, found two ways. Structural twins share their whole
 * member-name signature: when the twin's member of the flagged name is read,
 * the flagged member is probably read too — through the duplicate. Name twins
 * share their declared name and enough of their shape: two `IOWithSoundZones`
 * in one codebase is a stronger duplication signal than congruence, even
 * where the shapes have drifted apart. Either way the real finding is the
 * duplication.
 */
class TwinIndex {
  private readonly bySignature = new Map<string, Array<InterfaceDeclaration | TypeAliasDeclaration>>();
  private readonly byName = new Map<string, Array<InterfaceDeclaration | TypeAliasDeclaration>>();

  constructor(project: Project) {
    for (const sourceFile of project.getSourceFiles()) {
      if (sourceFile.isDeclarationFile()) continue;
      for (const decl of [...sourceFile.getInterfaces(), ...sourceFile.getTypeAliases()]) {
        const names = memberNames(decl);
        const title = decl.getName();
        // The overlap rule needs two shared members, so smaller shapes can't match.
        if (title && names.length >= 2) {
          const list = this.byName.get(title) ?? [];
          list.push(decl);
          this.byName.set(title, list);
        }
        // One or two members twin by accident; demand a shape with substance.
        if (names.length < 3) continue;
        const signature = names.join('\x00');
        const list = this.bySignature.get(signature) ?? [];
        list.push(decl);
        this.bySignature.set(signature, list);
      }
    }
  }

  /**
   * Every twin declaration of this owner — structural matches and same-named
   * drifted copies — found by shape alone, so the contract merge can scan
   * all of them at map-lookup cost, with no reference queries.
   */
  twinDeclarations(owner: Node): TwinCandidate[] {
    if (!owner.isKind(SyntaxKind.InterfaceDeclaration) && !owner.isKind(SyntaxKind.TypeAliasDeclaration)) {
      return [];
    }
    const ownNames = memberNames(owner);
    const candidates: TwinCandidate[] = [];
    const add = (twin: InterfaceDeclaration | TypeAliasDeclaration): void => {
      if (twin === owner || candidates.some(c => c.declaration === twin)) return;
      candidates.push({
        declaration: twin,
        typeName: twin.getName() ?? '?',
        nameNode: twin.getNameNode(),
        sameName: twin.getName() === owner.getName(),
      });
    };
    for (const twin of this.bySignature.get(ownNames.join('\x00')) ?? []) add(twin);
    for (const twin of this.byName.get(owner.getName() ?? '') ?? []) {
      const twinNames = memberNames(twin);
      const shared = twinNames.filter(n => n !== '' && ownNames.includes(n));
      // Same name and at least half the smaller shape in common: a drifted copy.
      if (shared.length < 2 || shared.length * 2 < Math.min(ownNames.length, twinNames.length)) continue;
      add(twin);
    }
    return candidates;
  }

  /** The twin that shadows this member, structural matches first. */
  readTwinMember(owner: Node, name: string): TwinMatch | undefined {
    if (!owner.isKind(SyntaxKind.InterfaceDeclaration) && !owner.isKind(SyntaxKind.TypeAliasDeclaration)) {
      return undefined;
    }
    const ownNames = memberNames(owner);
    const signature = ownNames.join('\x00');
    for (const twin of this.bySignature.get(signature) ?? []) {
      if (twin === owner) continue;
      const match = this.readMember(twin, name, false);
      if (match) return match;
    }

    for (const twin of this.byName.get(owner.getName() ?? '') ?? []) {
      if (twin === owner) continue;
      const twinNames = memberNames(twin);
      const shared = twinNames.filter(n => n !== '' && ownNames.includes(n));
      // Same name and at least half the smaller shape in common: a drifted copy.
      if (shared.length < 2 || shared.length * 2 < Math.min(ownNames.length, twinNames.length)) continue;
      const match = this.readMember(twin, name, true);
      if (match) return match;
      // The twin never declared (or never reads) the member; the duplication
      // still owns the finding as long as the twin itself is alive.
      const twinName = twin.getNameNode();
      if (findReferencesAsNodes(twinName).some(ref => ref !== twinName)) {
        return { typeName: twin.getName() ?? '?', node: twinName, readsMember: false, sameName: true };
      }
    }
    return undefined;
  }

  /** The twin's member of this name, when something reads it there. */
  private readMember(
    twin: InterfaceDeclaration | TypeAliasDeclaration,
    name: string,
    sameName: boolean
  ): TwinMatch | undefined {
    const member = typeMembers(twin).find(m => memberName(m) === name);
    if (!member) return undefined;
    const nameNode = (member as Node & { getNameNode(): Node }).getNameNode();
    if (findReferencesAsNodes(nameNode).length === 0) return undefined;
    return { typeName: twin.getName() ?? '?', node: member, readsMember: true, sameName };
  }
}

function memberNames(decl: InterfaceDeclaration | TypeAliasDeclaration): string[] {
  return typeMembers(decl).map(memberName).sort();
}

function typeMembers(decl: InterfaceDeclaration | TypeAliasDeclaration): Node[] {
  if (decl.isKind(SyntaxKind.InterfaceDeclaration)) return decl.getMembers();
  const typeNode = decl.getTypeNode();
  return typeNode?.isKind(SyntaxKind.TypeLiteral) ? typeNode.getMembers() : [];
}

function memberName(member: Node): string {
  return (member as Node & { getName?: () => string }).getName?.() ?? '';
}

// ----------------------------------------------------------------------- shared

/** The nearest interface, type alias, enum, or class the member sits in. */
function namedTypeAncestor(member: Node): Node | undefined {
  return member
    .getAncestors()
    .find(
      ancestor =>
        ancestor.isKind(SyntaxKind.InterfaceDeclaration) ||
        ancestor.isKind(SyntaxKind.TypeAliasDeclaration) ||
        ancestor.isKind(SyntaxKind.EnumDeclaration) ||
        ancestor.isKind(SyntaxKind.ClassDeclaration)
    );
}

/** One canonical `relative/path:line` coordinate, shared by every reporter. */
export function formatLocation(filePath: string, line: number, cwd: string): string {
  return `${path.relative(cwd, filePath)}:${line}`;
}

export function location(node: Node, cwd: string): string {
  const sourceFile = node.getSourceFile();
  const { line } = sourceFile.getLineAndColumnAtPos(node.getStart());
  return formatLocation(sourceFile.getFilePath(), line, cwd);
}
