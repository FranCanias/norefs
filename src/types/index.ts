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
  | 'empty-type';

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
  /** The declaration behind the finding, kept so --fix can act on it. Unset for file findings. */
  node?: Node;
}
