import type { SourceFile } from 'ts-morph';
import type { Candidate } from './candidate';
import { toCandidate } from './candidate';
import { isKeyofTargeted } from './dynamic-usage';
import type { CollectContext } from './index';

export function collectInterfaceCandidates(sourceFile: SourceFile, ctx: CollectContext): Candidate[] {
  const candidates: Candidate[] = [];
  for (const iface of sourceFile.getInterfaces()) {
    if (ctx.dynamic.suppressed.has(iface)) continue;
    if (isKeyofTargeted(iface.getNameNode())) continue;
    const probed = ctx.dynamic.probed.get(iface);
    const context = `interface \`${iface.getName()}\``;
    for (const member of iface.getMembers()) {
      const candidate = toCandidate(member, context, false, probed);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}
