import type { SourceFile } from 'ts-morph';
import type { Candidate, CollectContext } from './candidate';
import { toCandidate } from './candidate';
import { mergeNames } from './constraints';
import { isKeyofTargeted } from './dynamic-usage';

export function collectInterfaceCandidates(sourceFile: SourceFile, ctx: CollectContext): Candidate[] {
  const candidates: Candidate[] = [];
  for (const iface of sourceFile.getInterfaces()) {
    if (ctx.dynamic.suppressed.has(iface)) continue;
    let targeted = ctx.keyofTargeted.get(iface);
    if (targeted === undefined) {
      targeted = isKeyofTargeted(iface.getNameNode());
      ctx.keyofTargeted.set(iface, targeted);
    }
    if (targeted) continue;
    const skip = mergeNames(ctx.dynamic.probed.get(iface), ctx.constrained.get(iface));
    const context = `interface \`${iface.getName()}\``;
    for (const member of iface.getMembers()) {
      const candidate = toCandidate(member, context, false, skip);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}
