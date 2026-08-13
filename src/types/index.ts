import type { Node } from 'ts-morph';

export type FindingKind =
  /** An unused member of an interface, type, object literal, enum, or class. */
  | 'member'
  /** A file no chain of imports from any entry point reaches. */
  | 'file'
  /** An exported value nothing imports or uses. */
  | 'export'
  /** An exported type nothing imports or uses. */
  | 'type'
  /** An unused export whose namespace (TS namespace or `import * as`) is used. */
  | 'ns-export'
  /** An unused exported type whose namespace is used. */
  | 'ns-type'
  /** A still-referenced type that becomes empty once its unused members go. */
  | 'empty-type'
  /** A package.json dependency no source file imports. */
  | 'dependency'
  /** An imported package no scanned package.json lists. */
  | 'unlisted';

/** The declaration keyword behind a type finding. */
export type TypeKeyword = 'interface' | 'type' | 'enum';

/**
 * The claim a finding makes, with its safety profile:
 * - `dead` — no references, no structural twin, no boundary crossing. Safe to delete.
 * - `over-exported` — used in its own file only. Safe to de-export.
 * - `write-only` — assigned somewhere the analysis could not trace, never read. Suspicious, not dead.
 * - `contract` — its type crosses a serialization boundary. Documentation of a wire format; needs a human.
 * - `shadowed` — a structural twin elsewhere is read. The real finding is the duplication.
 * - `test-only` — production code never touches it; only tests keep it alive. Delete it with its tests.
 */
export type Verdict = 'dead' | 'over-exported' | 'write-only' | 'contract' | 'shadowed' | 'test-only';

export interface Finding {
  kind: FindingKind;
  filePath: string;
  line: number;
  column: number;
  /** The member, export, or file name. */
  name: string;
  /** The owner description for members; the namespace name for ns findings; "interface" or "type" for empty-type findings. */
  context: string;
  anonymous: boolean;
  /** True when the declaration has zero references anywhere, so --fix can remove it whole. */
  dead?: boolean;
  /** Set on type and ns-type findings: the keyword of the declaration. */
  typeKind?: TypeKeyword;
  /** The claim this finding makes. Unset only for `unlisted`, which claims a manifest gap, not unused code. */
  verdict?: Verdict;
  /** Human-readable evidence behind a non-dead verdict: the twin that reads the member, the boundary the type crosses. */
  evidence?: string;
  /** On empty-type findings: how many member findings folded into this one. */
  swallowed?: number;
  /** The declaration behind the finding, kept so --fix can act on it. Unset for file findings. */
  node?: Node;
}
