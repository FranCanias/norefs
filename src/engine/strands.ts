import type { CallExpression, Node, Project, ts } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import { descendantsOfKind } from '../lookup/descendants';
import { isInside } from '../lookup/reference-index';
import type { Boundary, ExportFinding, Finding, MemberFinding } from '../types';
import { formatLocation, lineAndColumnAt, location } from './location';
import { hasAmbientCallee } from './verdicts';

/**
 * A reported bridge wrapper has a far side. When a reported declaration sends
 * on a channel that leaves this program — an IPC invoke, a preload global, an
 * HTTP request — the first string it passes is the channel name, and the
 * handler registered under the same string lives in another file, usually an
 * entry file no reference-based analysis will ever flag: the registration call
 * keeps it "used". Deleting the wrapper strands that handler, unreachable in
 * practice and invisible in principle. The channel string is the only
 * correlation there is, so the finding carries it — and the far side gets a
 * finding of its own, at its own coordinates, so the handler is visible
 * *before* the deletion that hides it forever.
 *
 * The claim stays honest by shape: a channel is only the *first* argument of a
 * sending call, never a payload; a far side must look like a registration — the
 * same string first in a call that also takes a handler — and must not itself
 * be a sender, because a sender is another near side. And nothing strands while
 * a sender survives: every near side of the channel must sit inside a
 * declaration this report deletes, or deleting this one leaves the handler with
 * work to do.
 */
export function annotateStrandedChannels(
  project: Project,
  findings: Finding[],
  cwd: string,
  options: {
    /**
     * True when this far side deserves a finding of its own. The caller owns
     * that policy — a dead file or a suppressed one already tells the story.
     */
    reportFarSide?: ((node: Node) => boolean) | undefined;
    /** Boundaries the project declared, each paired independently of the rest. */
    boundaries?: Boundary[] | undefined;
  } = {}
): Finding[] {
  const reportFarSide = options.reportFarSide ?? (() => true);
  const candidates = findings.filter(
    (f): f is MemberFinding | ExportFinding => f.kind === 'member' || f.kind === 'export'
  );
  if (candidates.length === 0) return [];

  const pairings: Pairing[] = [];
  for (const rule of [OWN_BRIDGE, ...(options.boundaries ?? []).map(declaredRule)]) {
    const channels = new Map<Sender, string[]>();
    for (const finding of candidates) {
      const names = channelsSentBy(finding.node, rule);
      if (names.length > 0) channels.set(finding, names);
    }
    if (channels.size > 0) {
      pairings.push({
        rule,
        channels,
        wanted: new Set([...channels.values()].flat()),
        senders: new Map(),
        farSides: new Map(),
      });
    }
  }
  if (pairings.length === 0) return [];

  // One pass over the project. Each rule claims the calls it recognizes: a
  // sender of a wanted channel, or a registration of one. A call no rule
  // recognizes is neither, and a rule that does not want the channel never
  // looks at it.
  for (const sourceFile of project.getSourceFiles()) {
    if (sourceFile.isDeclarationFile()) continue;
    for (const call of descendantsOfKind(sourceFile, SyntaxKind.CallExpression)) {
      const first = call.getArguments()[0];
      const channel = channelOf(first);
      if (first === undefined || channel === undefined) continue;
      for (const pairing of pairings) {
        if (!pairing.wanted.has(channel)) continue;
        if (pairing.rule.sends(call)) push(pairing.senders, channel, first);
        else if (pairing.rule.registers(call)) push(pairing.farSides, channel, first);
      }
    }
  }

  const stranded: Finding[] = [];
  const reportedFar = new Set<Node>();
  for (const pairing of pairings) collectStrands(pairing, candidates, cwd, reportFarSide, reportedFar, stranded);
  return stranded;
}

/** A finding a channel can be sent from: the kinds that carry a declaration node. */
type Sender = MemberFinding | ExportFinding;

/** A rule and everything the project scan found for it. */
interface Pairing {
  rule: ChannelRule;
  /** The channels each reported declaration sends on. */
  channels: Map<Sender, string[]>;
  wanted: Set<string>;
  senders: Map<string, Node[]>;
  farSides: Map<string, Node[]>;
}

/** Which calls send on a channel, and which register a handler for one. */
interface ChannelRule {
  sends(call: CallExpression): boolean;
  registers(call: CallExpression): boolean;
}

/**
 * The bridge a project wrote for itself. A callee its own .d.ts declares — a
 * preload global, an ambient IPC handle — runs outside this program, so the
 * string it takes first is a channel. Anything else taking the same string
 * first, with a handler beside it, is the far side.
 */
const OWN_BRIDGE: ChannelRule = {
  sends: call => hasAmbientCallee(call),
  registers: call => !hasAmbientCallee(call) && call.getArguments().length >= 2,
};

/** A boundary the project named: these callees send, those ones register. */
function declaredRule(boundary: Boundary): ChannelRule {
  return {
    sends: call => calleeMatches(call, boundary.send),
    registers: call => calleeMatches(call, boundary.handle) && call.getArguments().length >= 2,
  };
}

/**
 * True when the callee as written is one of these names. A name matches the
 * whole callee or its tail, so `app.get` covers `this.app.get` and `fetch`
 * covers `window.fetch` — without covering `getApp`.
 */
function calleeMatches(call: CallExpression, names: string[]): boolean {
  const text = call.getExpression().getText();
  return names.some(name => text === name || text.endsWith(`.${name}`));
}

function collectStrands(
  pairing: Pairing,
  candidates: Sender[],
  cwd: string,
  reportFarSide: (node: Node) => boolean,
  reportedFar: Set<Node>,
  stranded: Finding[]
): void {
  const { channels, senders, farSides } = pairing;

  /**
   * The declarations this report deletes that send this channel — or undefined
   * when one sender survives, which means nothing is stranded: that sender
   * stays, and the handler keeps its work.
   *
   * A sender dies with the declaration that holds it, so the owner is the
   * *innermost* reported declaration around it. A class with five senders and
   * three fates is not one fate.
   */
  const deletedSenders = (channel: string): Sender[] | undefined => {
    const owners: Sender[] = [];
    for (const sender of senders.get(channel) ?? []) {
      const owner = innermostOwner(candidates, sender);
      if (!owner || !deletesDeclaration(owner)) return undefined;
      if (!owners.includes(owner)) owners.push(owner);
    }
    return owners;
  };

  for (const [finding, names] of channels) {
    const declaration = finding.node;
    for (const name of names) {
      const sending = deletedSenders(name);
      if (!sending) continue;
      const far = (farSides.get(name) ?? []).find(site => !isInside(site.compilerNode, declaration.compilerNode));
      if (!far) continue;
      // Matching normalizes a route; naming it must not. A reader goes looking
      // for the channel, and the one to search for is the one they wrote.
      const written = writtenChannel(far);
      // "Deleting it" has to be true of this finding's own fix. An
      // over-exported declaration loses a keyword and keeps every line.
      if (!finding.strands && deletesDeclaration(finding)) {
        finding.strands = `deleting it strands the far side of \`'${written}'\` at ${location(far, cwd)}`;
      }
      if (!reportedFar.has(far) && reportFarSide(far)) {
        reportedFar.add(far);
        stranded.push(strandedFinding(far, written, sending, cwd));
      }
    }
  }
}

/**
 * The reported declaration closest around this sender. A method reported on
 * its own answers for the sender it holds; the class around it answers only
 * when nothing nearer does.
 */
function innermostOwner(candidates: Sender[], sender: Node): Sender | undefined {
  let owner: Sender | undefined;
  let inner: ts.Node | undefined;
  for (const candidate of candidates) {
    const node = candidate.node.compilerNode;
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
function strandedFinding(far: Node, channel: string, sending: Sender[], cwd: string): Finding {
  const sourceFile = far.getSourceFile();
  const { line, column } = lineAndColumnAt(sourceFile, far.getStart());
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

/** The channels this declaration sends on, under one rule. */
function channelsSentBy(declaration: Node, rule: ChannelRule): string[] {
  const names: string[] = [];
  for (const call of declaration.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!rule.sends(call)) continue;
    const channel = channelOf(call.getArguments()[0]);
    if (channel !== undefined) names.push(channel);
  }
  return names;
}

/**
 * The channel an argument names, or nothing. A written string is the channel
 * itself. A template is one only when it starts with `/`: a route's holes are
 * exactly what the two sides fill differently, while an interpolated opaque
 * name has no shape the two sides can agree on.
 */
function channelOf(argument: Node | undefined): string | undefined {
  if (!argument) return undefined;
  if (argument.isKind(SyntaxKind.StringLiteral) || argument.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)) {
    const text = argument.getLiteralText();
    return text.startsWith('/') ? routeShape(text) : text;
  }
  if (argument.isKind(SyntaxKind.TemplateExpression)) {
    const head = argument.getHead().getLiteralText();
    if (!head.startsWith('/')) return undefined;
    const spans = argument.getTemplateSpans().map(span => `${HOLE}${routeShape(span.getLiteral().getLiteralText())}`);
    return routeShape(head) + spans.join('');
  }
  return undefined;
}

/** The channel as its own site writes it: the text a reader can search for. */
function writtenChannel(node: Node): string {
  if (node.isKind(SyntaxKind.StringLiteral) || node.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)) {
    return node.getLiteralText();
  }
  return node.getText();
}

/** Stands in for a hole, so both sides of a route write it the same way. */
const HOLE = '*';

/**
 * A route as its shape. The two sides write the same route differently —
 * `app.get('/recipes/:id/audit')` against `` fetch(`/recipes/${id}/audit`) ``
 * — and every difference sits in the holes. Turning each hole into one
 * character leaves a string both sides produce and no other route does. The
 * list route, the item route, and the nested one under it all stay apart,
 * which matters: they are the three routes every REST API has.
 */
function routeShape(text: string): string {
  return text.replace(/:[A-Za-z0-9_]+/g, HOLE);
}
