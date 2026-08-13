import type { Node, Project } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import type { Finding } from '../types';
import { isInside } from './reference-index';
import { hasAmbientCallee, location } from './verdicts';

/**
 * A dead bridge wrapper has a far side. When a reported declaration calls a
 * bridge the project's own .d.ts declares — an IPC invoke, a preload global —
 * the first string it passes is a channel name, and the handler registered
 * under the same string lives in another file, usually an entry file no
 * reference-based analysis will ever flag: the registration call keeps it
 * "used". Deleting the wrapper strands that handler, unreachable in practice
 * and invisible in principle. The channel string is the only correlation
 * there is, so the finding carries it.
 *
 * The claim stays honest by shape: a channel is only the *first* argument of
 * a bridge call, never a payload; a far side must look like a registration —
 * the same string first in a call that also takes a handler — and must not
 * itself be a bridge call, because a bridge call is another near side (a
 * second dead wrapper is not anyone's handler).
 */
export function annotateStrandedChannels(project: Project, findings: Finding[], cwd: string): void {
  const candidates = findings.filter(
    f => f.verdict === 'dead' && f.node && (f.kind === 'member' || f.kind === 'export')
  );
  const channels = new Map<Finding, string[]>();
  for (const finding of candidates) {
    const names = channelStrings(finding.node as Node);
    if (names.length > 0) channels.set(finding, names);
  }
  if (channels.size === 0) return;

  // One pass over the project: every wanted string in registration position.
  const wanted = new Set([...channels.values()].flat());
  const sites = new Map<string, Node[]>();
  for (const sourceFile of project.getSourceFiles()) {
    if (sourceFile.isDeclarationFile()) continue;
    for (const literal of stringLiterals(sourceFile)) {
      const text = literal.getLiteralText();
      if (!wanted.has(text)) continue;
      const call = literal.getParent();
      if (!call?.isKind(SyntaxKind.CallExpression)) continue;
      const args = call.getArguments();
      // A registration passes the channel first and a handler with it.
      if (args[0] !== literal || args.length < 2) continue;
      // A bridge call is a near side, not a registration.
      if (hasAmbientCallee(call)) continue;
      const list = sites.get(text) ?? [];
      list.push(literal);
      sites.set(text, list);
    }
  }

  for (const [finding, names] of channels) {
    const declaration = finding.node as Node;
    for (const name of names) {
      const far = (sites.get(name) ?? []).find(site => !isInside(site.compilerNode, declaration.compilerNode));
      if (!far) continue;
      finding.strands = `deleting it strands the far side of \`'${name}'\` at ${location(far, cwd)}`;
      break;
    }
  }
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
