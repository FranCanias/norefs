import type { CrossFile } from './cross-file-def';

export function readFar(v: CrossFile): number {
  return v.farUsed;
}
