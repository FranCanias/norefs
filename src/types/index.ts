import type { Node } from 'ts-morph';

export type FindingKind =
  /** An unused member of an interface, type, object literal, enum, or class. */
  | 'member'
  /** A file no other file references. */
  | 'file'
  /** An exported value nothing imports or uses. */
  | 'export'
  /** An exported type nothing imports or uses. */
  | 'type'
  /** An unused export whose namespace (TS namespace or `import * as`) is used. */
  | 'ns-export'
  /** An unused exported type whose namespace is used. */
  | 'ns-type';

export interface Finding {
  kind: FindingKind;
  filePath: string;
  line: number;
  column: number;
  /** The member, export, or file name. */
  name: string;
  /** The owner description for members; the namespace name for ns findings. */
  context: string;
  anonymous: boolean;
  /** The declaration behind the finding, kept so --fix can act on it. Unset for file findings. */
  node?: Node;
}
