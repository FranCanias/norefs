import type { Node, PropertyNamedNode } from 'ts-morph';

export interface Finding {
  filePath: string;
  line: number;
  column: number;
  propertyName: string;
  context: string;
  anonymous: boolean;
  /** The declaration behind the finding, kept so --fix can remove it. */
  member: PropertyNamedNode & Node;
}
