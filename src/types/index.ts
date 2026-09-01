import type { Node } from 'ts-morph';

/** The declaration keyword behind a type finding. */
export type TypeKeyword = 'interface' | 'type' | 'enum';

/**
 * One way a channel leaves this program, named by the project that built it.
 *
 * norefs finds the Electron-shaped bridge on its own — a callee the project's
 * own .d.ts declares. Every other boundary is a library's convention, and no
 * shape says which library pairs `fetch` with `app.get` rather than running the
 * handler itself. So the project says it: two lists of callee names, one that
 * sends on a channel and one that registers a handler for it.
 */
export interface Boundary {
  /** Callee names that send on a channel: `fetch`, `apiClient.request`. */
  send: string[];
  /** Callee names that register a handler for one: `app.get`, `socket.on`. */
  handle: string[];
}

/**
 * The claim a finding makes, with its safety profile:
 * - `dead` — no references, no structural twin, no boundary crossing. Safe to delete.
 * - `over-exported` — used in its own file only. Safe to de-export.
 * - `write-only` — a write of the name survives validation: a proven typed write, or a name match the analysis could not type. Suspicious, not dead.
 * - `contract` — its type crosses a serialization boundary. Documentation of a wire format; needs a human.
 * - `shadowed` — a structural twin elsewhere is read. The real finding is the duplication.
 * - `test-only` — production code never touches it; only tests keep it alive. Delete it with its tests.
 */
export type Verdict = 'dead' | 'over-exported' | 'write-only' | 'contract' | 'shadowed' | 'test-only';

/** What every finding carries, whatever its kind. */
interface FindingBase {
  filePath: string;
  line: number;
  column: number;
  /** The member, export, file, package, or channel name. */
  name: string;
  anonymous: boolean;
  /**
   * The claim this finding makes. Unset for `unlisted`, which claims a
   * manifest gap, and for `stranded`, which claims a reachability gap — code
   * that is alive today and dead the moment you apply the rest of the report.
   */
  verdict?: Verdict | undefined;
  /** Human-readable evidence behind the verdict: the twin that reads the member, the boundary the type crosses. */
  evidence?: string | undefined;
}

/** A file no chain of imports from any entry point reaches. */
interface FileFinding extends FindingBase {
  kind: 'file';
  context: '';
}

/**
 * An exported declaration nothing outside its own file uses. `type` and
 * `ns-type` are the type declarations; `ns-export` and `ns-type` sit inside a
 * namespace (TS namespace or `import * as`) that is itself used.
 */
export interface ExportFinding extends FindingBase {
  kind: 'export' | 'type' | 'ns-export' | 'ns-type';
  /** The namespace name for ns findings; empty for plain exports. */
  context: string;
  /** Zero references anywhere: --fix removes the declaration whole instead of de-exporting it. */
  dead: boolean;
  /** The keyword of the declaration, on type and ns-type findings. */
  typeKind?: TypeKeyword | undefined;
  /** The declaration behind the finding, kept so --fix can act on it. */
  node: Node;
  /** On a reported bridge wrapper: where the far side of the shared channel string lives. */
  strands?: string | undefined;
}

/** An unused member of an interface, type, object literal, enum, or class. */
export interface MemberFinding extends FindingBase {
  kind: 'member';
  /** The owner description: "type `Config`", "props of `render`". */
  context: string;
  /** The member declaration, kept so --fix can act on it. */
  node: Node;
  /**
   * On a proven `write-only` member: the write sites the evidence cites. A fix
   * that deletes the member must delete these too — the value chain is the
   * finding, and a declaration removed without them leaves the writes running
   * into a shape no type describes.
   *
   * The verdict pass fills this in from the name matches it validated. The
   * analysis fills it in first when the member's own references are the
   * writes, which is proof of a kind no name match can reach.
   */
  writeSites?: Node[] | undefined;
  /** On a reported bridge wrapper: where the far side of the shared channel string lives. */
  strands?: string | undefined;
}

/** A still-referenced shape that becomes empty once its unused members go. */
export interface EmptyTypeFinding extends FindingBase {
  kind: 'empty-type';
  /**
   * What kind of owner empties: a declaration, a function's returned object,
   * or the property or binding that holds a shape written inline.
   */
  context: 'interface' | 'type' | 'returned object' | 'property' | 'const';
  /** How many member findings folded into this one. */
  swallowed: number;
  /** The member nodes whose findings folded in, for verdict and strand inheritance. */
  members: Node[];
  /** On a reported bridge wrapper: where the far side of the shared channel string lives. */
  strands?: string | undefined;
}

/**
 * A dependency finding: `dependency` is listed and never used; `misplaced`
 * is listed in the section that does not match how it is used.
 */
interface DependencyFinding extends FindingBase {
  kind: 'dependency' | 'misplaced';
  /** The manifest section the entry is written in now — what tells a fix where the entry it moves lives. */
  context: 'dependencies' | 'devDependencies';
}

/** An imported package no scanned package.json lists. */
interface UnlistedFinding extends FindingBase {
  kind: 'unlisted';
  context: '';
}

/** A handler whose every sender this report deletes: dead once they go. */
interface StrandedFinding extends FindingBase {
  kind: 'stranded';
  /** The reported senders, named. */
  context: string;
}

export type Finding =
  | FileFinding
  | ExportFinding
  | MemberFinding
  | EmptyTypeFinding
  | DependencyFinding
  | UnlistedFinding
  | StrandedFinding;

export type FindingKind = Finding['kind'];
