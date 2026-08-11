import type { Node, SourceFile } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import { describeTypeLiteralContext } from '../engine/describe';
import type { Candidate } from './candidate';
import { toCandidate } from './candidate';
import { isKeyofTargeted } from './dynamic-usage';

export function collectTypeLiteralCandidates(sourceFile: SourceFile): Candidate[] {
  const candidates: Candidate[] = [];
  for (const typeLiteral of sourceFile.getDescendantsOfKind(SyntaxKind.TypeLiteral)) {
    if (isGenericConstraint(typeLiteral)) continue;
    const alias = typeLiteral.getParentIfKind(SyntaxKind.TypeAliasDeclaration);
    if (alias && isKeyofTargeted(alias.getNameNode())) continue;
    const { label, anonymous } = describeTypeLiteralContext(typeLiteral);
    for (const member of typeLiteral.getMembers()) {
      const candidate = toCandidate(member, label, anonymous);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

function isGenericConstraint(node: Node): boolean {
  return node.getFirstAncestor(a => a.isKind(SyntaxKind.TypeParameter)) !== undefined;
}
