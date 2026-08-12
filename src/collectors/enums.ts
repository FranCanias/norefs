import type { EnumDeclaration, SourceFile } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import { findReferencesAsNodes } from '../engine/references';
import type { Candidate } from './candidate';
import { toCandidate } from './candidate';
import { isKeyofTargeted } from './dynamic-usage';
import type { CollectContext } from './index';

export function collectEnumCandidates(sourceFile: SourceFile, ctx: CollectContext): Candidate[] {
  const candidates: Candidate[] = [];
  for (const enumDecl of sourceFile.getEnums()) {
    if (ctx.dynamic.suppressed.has(enumDecl)) continue;
    let dynamic = ctx.keyofTargeted.get(enumDecl);
    if (dynamic === undefined) {
      dynamic = isKeyofTargeted(enumDecl.getNameNode()) || isIndexedDynamically(enumDecl);
      ctx.keyofTargeted.set(enumDecl, dynamic);
    }
    if (dynamic) continue;
    const probed = ctx.dynamic.probed.get(enumDecl);
    const context = `enum \`${enumDecl.getName()}\``;
    for (const member of enumDecl.getMembers()) {
      const candidate = toCandidate(member, context, false, probed);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

/**
 * True when the enum object is element-accessed with a non-literal key —
 * reverse mapping (`Code[n]`) or a computed member lookup. Those reads reach
 * members without per-member references.
 */
function isIndexedDynamically(enumDecl: EnumDeclaration): boolean {
  for (const ref of findReferencesAsNodes(enumDecl.getNameNode())) {
    const access = ref.getParentIfKind(SyntaxKind.ElementAccessExpression);
    if (!access || access.getExpression() !== ref) continue;
    if (!access.getArgumentExpression()?.isKind(SyntaxKind.StringLiteral)) return true;
  }
  return false;
}
