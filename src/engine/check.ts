import type { Node, PropertyNamedNode, SourceFile } from 'ts-morph';
import { writeValueStaysLocal } from '../collectors/escape';
import { isReadReference, isWriteReference, referenceIndex } from '../lookup/reference-index';
import { findReferencesAsNodes } from '../lookup/references';

type MemberUsage = 'used' | 'unused' | 'test-only' | 'write-only';

/**
 * How a member is consumed. `test-only` means every reference sits in a
 * harness file: production code never touches it, tests keep it alive.
 * `write-only` means every reference fills the member in and none reads it —
 * the code writes a value nobody ever asks for. A member answering a base
 * type's declaration is `used` whatever its count — remove it and the owner
 * stops compiling.
 *
 * A write is a reference, which is why it took a rule of its own to see. An
 * annotated literal that sets `spareJars` gives the member a reference the
 * search finds every time, and a count that stops at "found one" calls that
 * member alive. Nothing reads it.
 *
 * The verdict needs the writes to stay where this run can see them. A literal
 * passed on as an argument is read at the far end, and the far end can be a
 * declaration file nothing scans — so that member is left as it was.
 */
export function memberUsage(member: PropertyNamedNode, isHarness: (sourceFile: SourceFile) => boolean): MemberUsage {
  const nameNode = member.getNameNode();
  const references = findReferencesAsNodes(nameNode);
  const required = (): boolean => referenceIndex(nameNode.getProject()).isRequiredByBaseType(nameNode);
  const outsideHarness = (): boolean => references.some(ref => !isHarness(ref.getSourceFile()));

  if (references.length === 0) return required() ? 'used' : 'unused';
  // One reference the analysis cannot call a write settles it the old way: a
  // second declaration, an implementing class member, a shape nothing here
  // classifies. Only a member whose every reference writes is write-only.
  if (references.every(isWriteReference)) {
    if (required() || references.some(writeIsRead)) return 'used';
    // Writes that live only in the harness are the test-only story, and
    // `--production` already knows how to read that one. That verdict says
    // who touches the member, not whether anybody reads it, so it stands
    // wherever the values go.
    if (!outsideHarness()) return 'test-only';
    // Saying nothing reads it needs the writes to stay where this run can
    // look. A literal handed to a body it does not hold is read at the far
    // end, and the member keeps the answer it had before.
    return references.every(writeValueStaysLocal) ? 'write-only' : 'used';
  }
  if (outsideHarness()) return 'used';
  return required() ? 'used' : 'test-only';
}

/**
 * True when the write is itself read.
 *
 * `satisfies` and `as const` leave the literal holding its own type, so
 * `limits.shelfCount` lands on the property written there rather than on the
 * member it was checked against. The member is not unread — the reads resolve
 * to the other declaration, and deleting it would take the value with it. An
 * annotation hands the binding the declared type instead, and its writes have
 * no reads of their own to show.
 */
function writeIsRead(site: Node): boolean {
  return findReferencesAsNodes(site).some(isReadReference);
}

/**
 * The references that fill a member in. They are the evidence behind a
 * `write-only` verdict and the worklist a fix retires with the member, so the
 * pass that reports the member is the pass that collects them.
 */
export function memberWriteSites(member: PropertyNamedNode): Node[] {
  return findReferencesAsNodes(member.getNameNode()).filter(isWriteReference);
}
