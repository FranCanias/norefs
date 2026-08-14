import type { Node, Project, ts } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import type { Finding } from '../types';
import { isInside } from './reference-index';
import { formatLocation, hasAmbientCallee, location } from './verdicts';

/**
 * A reported bridge wrapper has a far side. When a reported declaration calls
 * a bridge the project's own .d.ts declares — an IPC invoke, a preload global
 * — the first string it passes is a channel name, and the handler registered
 * under the same string lives in another file, usually an entry file no
 * reference-based analysis will ever flag: the registration call keeps it
 * "used". Deleting the wrapper strands that handler, unreachable in practice
 * and invisible in principle. The channel string is the only correlation
 * there is, so the finding carries it — and the far side gets a finding of
 * its own, at its own coordinates, so the handler is visible *before* the
 * deletion that hides it forever.
 *
 * The claim stays honest by shape: a channel is only the *first* argument of
 * a bridge call, never a payload; a far side must look like a registration —
 * the same string first in a call that also takes a handler — and must not
 * itself be a bridge call, because a bridge call is another near side. And
 * nothing strands while a sender survives: every near side of the channel
 * must sit inside a declaration this report deletes, or deleting this one
 * leaves the handler with work to do.
 */
export function annotateStrandedChannels(
  project: Project,
  findings: Finding[],
  cwd: string,
  /**
   * True when this far side deserves a finding of its own. The caller owns
   * that policy — a dead file or a suppressed one already tells the story.
   */
  reportFarSide: (node: Node) => boolean = () => true
): Finding[] {
  const candidates = findings.filter(f => f.node && (f.kind === 'member' || f.kind === 'export'));
  const channels = new Map<Finding, string[]>();
  for (const finding of candidates) {
    const names = channelStrings(finding.node as Node);
    if (names.length > 0) channels.set(finding, names);
  }
  if (channels.size === 0) return [];

  // One pass over the project: every wanted string in registration position
  // (a far side) and in bridge-call position (another sender).
  const wanted = new Set([...channels.values()].flat());
  const farSides = new Map<string, Node[]>();
  const senders = new Map<string, Node[]>();
  for (const sourceFile of project.getSourceFiles()) {
    if (sourceFile.isDeclarationFile()) continue;
    for (const literal of stringLiterals(sourceFile)) {
      const text = literal.getLiteralText();
      if (!wanted.has(text)) continue;
      const call = literal.getParent();
      if (!call?.isKind(SyntaxKind.CallExpression)) continue;
      if (call.getArguments()[0] !== literal) continue;
      // A bridge call is a near side: another sender of the same channel.
      if (hasAmbientCallee(call)) {
        push(senders, text, literal);
        continue;
      }
      // A registration passes the channel first and a handler with it.
      if (call.getArguments().length < 2) continue;
      push(farSides, text, literal);
    }
  }

  /**
   * The declarations this report deletes that send this channel — or undefined
   * when one sender survives, which means nothing is stranded: that sender
   * stays, and the handler keeps its work.
   *
   * A sender dies with the declaration that holds it, so the owner is the
   * *innermost* reported declaration around it. A class with five senders and
   * three fates is not one fate.
   */
  const deletedSenders = (channel: string): Finding[] | undefined => {
    const owners: Finding[] = [];
    for (const sender of senders.get(channel) ?? []) {
      const owner = innermostOwner(candidates, sender);
      if (!owner || !deletesDeclaration(owner)) return undefined;
      if (!owners.includes(owner)) owners.push(owner);
    }
    return owners;
  };

  const stranded: Finding[] = [];
  const reportedFar = new Set<Node>();
  for (const [finding, names] of channels) {
    const declaration = finding.node as Node;
    for (const name of names) {
      const sending = deletedSenders(name);
      if (!sending) continue;
      const far = (farSides.get(name) ?? []).find(site => !isInside(site.compilerNode, declaration.compilerNode));
      if (!far) continue;
      // "Deleting it" has to be true of this finding's own fix. An
      // over-exported declaration loses a keyword and keeps every line.
      if (!finding.strands && deletesDeclaration(finding)) {
        finding.strands = `deleting it strands the far side of \`'${name}'\` at ${location(far, cwd)}`;
      }
      if (!reportedFar.has(far) && reportFarSide(far)) {
        reportedFar.add(far);
        stranded.push(strandedFinding(far, name, sending, cwd));
      }
    }
  }
  return stranded;
}

/**
 * The reported declaration closest around this sender. A method reported on
 * its own answers for the sender it holds; the class around it answers only
 * when nothing nearer does.
 */
function innermostOwner(candidates: Finding[], sender: Node): Finding | undefined {
  let owner: Finding | undefined;
  let inner: ts.Node | undefined;
  for (const candidate of candidates) {
    const node = (candidate.node as Node).compilerNode;
    if (!isInside(sender.compilerNode, node)) continue;
    if (!inner || (node.pos >= inner.pos && node.end <= inner.end)) {
      owner = candidate;
      inner = node;
    }
  }
  return owner;
}

/**
 * True when acting on this finding takes the declaration away. Reported is not
 * dying: the fix for an `over-exported` finding removes an `export` keyword
 * and deletes nothing, so every sender inside it keeps sending.
 */
function deletesDeclaration(finding: Finding): boolean {
  return finding.verdict !== undefined && finding.verdict !== 'over-exported';
}

/**
 * The far side, as a finding of its own. Its own file, its own line: the
 * handler is dead the moment the last sender goes, and this is the one report
 * that can still see it.
 */
function strandedFinding(far: Node, channel: string, sending: Finding[], cwd: string): Finding {
  const sourceFile = far.getSourceFile();
  const { line, column } = sourceFile.getLineAndColumnAtPos(far.getStart());
  const named = sending
    .slice(0, 3)
    .map(f => `\`${f.name}\` at ${formatLocation(f.filePath, f.line, cwd)}`)
    .join(', ');
  const rest = sending.length > 3 ? `, and ${sending.length - 3} more` : '';
  const who =
    sending.length === 1
      ? `its only sender is ${named}, which this report says to delete`
      : `every sender of it — ${named}${rest} — is one this report says to delete`;
  return {
    kind: 'stranded',
    filePath: sourceFile.getFilePath(),
    line,
    column,
    name: channel,
    context: sending.map(f => f.name).join(', '),
    anonymous: false,
    evidence: `${who}, so nothing will send \`'${channel}'\` once this report is applied — and no reference for any analysis to follow to this handler`,
  };
}

function push(map: Map<string, Node[]>, key: string, value: Node): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

/** The first-argument string of each call whose callee a project .d.ts declares. */
function channelStrings(declaration: Node): string[] {
  const names: string[] = [];
  for (const call of declaration.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!hasAmbientCallee(call)) continue;
    const [first] = call.getArguments();
    if (first?.isKind(SyntaxKind.StringLiteral) || first?.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)) {
      names.push(first.getLiteralText());
    }
  }
  return names;
}

function stringLiterals(sourceFile: Node): Array<Node & { getLiteralText(): string }> {
  return [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.StringLiteral),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
  ];
}
