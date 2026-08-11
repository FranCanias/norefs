import type { SourceFile } from 'ts-morph';
import type { Candidate } from './candidate';
import { toCandidate } from './candidate';

export function collectInterfaceCandidates(sourceFile: SourceFile): Candidate[] {
  const candidates: Candidate[] = [];
  for (const iface of sourceFile.getInterfaces()) {
    const context = `interface \`${iface.getName()}\``;
    for (const member of iface.getMembers()) {
      const candidate = toCandidate(member, context, false);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}
