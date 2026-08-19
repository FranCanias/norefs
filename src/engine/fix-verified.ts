import path from 'node:path';
import type { Project } from 'ts-morph';
import type { Finding } from '../types';
import type { CommentLocation } from './fix';
import { applyFixes, isFixable, UnappliedFix } from './fix';
import { errorInventory, newErrors, snapshotTexts } from './verify';

interface HeldBack {
  finding: Finding;
  /** The verification errors that appeared while this fix was applied. */
  errors: string[];
  /** True when the editor refused the edit, rather than the probe rejecting it. */
  unapplied?: boolean | undefined;
}

interface VerifiedFixOptions {
  project: Project;
  /** The findings of the pristine project, already baseline-filtered. */
  findings: Finding[];
  /** Fresh, baseline-filtered findings for the current in-memory state. */
  reanalyze: () => Finding[];
  unsafe: boolean;
  /** Verify with the type checker: no new errors compared to the pre-fix inventory. */
  verify: boolean;
  /**
   * An extra probe on top of the type-error inventory: empty result means the
   * project is healthy. It runs only when the type check is green, and gets
   * the files currently changed in memory. The seam --verify-command plugs
   * into.
   */
  check?: ((project: Project, dirtyFilePaths: string[]) => string[]) | undefined;
  cwd: string;
  log: (line: string) => void;
}

interface VerifiedFixResult {
  fixed: number;
  /** Files changed in memory. Nothing is saved — that is the caller's call. */
  touched: string[];
  /** Fixes withheld because applying them made the probe fail. */
  heldBack: HeldBack[];
  /** Comments the applied fixes left next to their edits, for a human to reread. */
  keptComments: CommentLocation[];
  /** Set when verification failed and no culprit could be isolated; the project is pristine. */
  aborted?: string[] | undefined;
}

const MAX_PASSES = 5;
const MAX_HELD_BACK = 8;

/**
 * Fix everything fixable, prove it, and keep only what holds.
 *
 * Every edit stays in memory. A campaign fixes to the cascade fixpoint, then
 * the probe runs — by default a type-check compared against the pre-fix error
 * inventory. When the probe fails, the campaign is rolled back in memory and
 * the first-pass fixes are bisected to the culprit, which is held back with
 * its evidence; the loop then runs again without it. Disk is never touched:
 * the caller saves the touched files of a verified result.
 */
export function applyVerifiedFixes(options: VerifiedFixOptions): VerifiedFixResult {
  const { project, cwd } = options;
  const pristine = snapshotTexts(project);
  const inventory = options.verify ? errorInventory(project) : undefined;
  const verifying = options.verify || options.check !== undefined;
  const probe = (): string[] => {
    const typeErrors = inventory ? newErrors(inventory, project, cwd) : [];
    if (typeErrors.length > 0) return typeErrors;
    return options.check ? options.check(project, [...dirty]) : [];
  };

  const dirty = new Set<string>();
  let pristineTree = true;
  const restore = (): void => {
    for (const filePath of dirty) {
      const text = pristine.get(filePath);
      const sourceFile = project.getSourceFile(filePath);
      if (text !== undefined && sourceFile && sourceFile.getFullText() !== text) {
        sourceFile.replaceWithText(text);
      }
    }
    dirty.clear();
  };

  // A probe that is red before any fix can never vouch for one. The default
  // probe is green on the pristine tree by construction, so only a custom
  // check needs the pre-flight.
  if (options.check) {
    const preExisting = options.check(project, []);
    if (preExisting.length > 0) {
      return { fixed: 0, touched: [], heldBack: [], keptComments: [], aborted: preExisting };
    }
  }

  const excluded = new Set<string>();
  const byKey = new Map<string, Finding>();

  /**
   * One fixing run against the current tree. `allowed` restricts the first
   * pass to a subset under bisection; cascades re-analyze and continue to the
   * fixpoint. Findings come from the pristine analysis when the tree is
   * untouched, from a re-analysis otherwise. The kept-comment notes belong to
   * the run's own passes, so each caller reads the notes of the exact tree
   * state its campaign produced — no shared mutable to go stale.
   */
  const campaign = (
    allowed: Set<string> | undefined,
    cascades: boolean
  ): { fixedKeys: string[]; fixed: number; keptComments: CommentLocation[] } => {
    let findings = pristineTree ? options.findings : options.reanalyze();
    pristineTree = false;
    const fixedKeys: string[] = [];
    const keptComments: CommentLocation[] = [];
    let fixed = 0;
    for (let pass = 1; pass <= (cascades ? MAX_PASSES : 1); pass++) {
      const fixable = findings.filter(f => {
        if (!isFixable(f, options.unsafe)) return false;
        const key = findingKey(f, cwd);
        if (excluded.has(key)) return false;
        return pass > 1 || allowed === undefined || allowed.has(key);
      });
      if (fixable.length === 0) break;
      const result = applyFixes(fixable, { save: false, unsafe: options.unsafe });
      for (const filePath of result.filePaths) dirty.add(filePath);
      keptComments.push(...result.keptComments);
      if (result.fixed === 0) break;
      fixed += result.fixed;
      if (pass === 1) {
        for (const finding of fixable) {
          const key = findingKey(finding, cwd);
          fixedKeys.push(key);
          byKey.set(key, finding);
        }
      } else {
        options.log(`Pass ${pass}: fixed ${result.fixed} more finding(s)`);
      }
      if (!cascades) break;
      findings = options.reanalyze();
    }
    return { fixedKeys, fixed, keptComments };
  };

  const failsWith = (keys: string[]): { fails: boolean; keptComments: CommentLocation[] } => {
    restore();
    const run = campaign(new Set(keys), false);
    return { fails: probe().length > 0, keptComments: run.keptComments };
  };

  /** The smallest first-pass subset that still fails the probe. */
  const bisect = (keys: string[]): string[] => {
    if (keys.length <= 1) return keys;
    const mid = keys.length >> 1;
    const left = keys.slice(0, mid);
    const right = keys.slice(mid);
    if (failsWith(left).fails) return bisect(left);
    if (failsWith(right).fails) return bisect(right);
    return keys; // they only break together: hold the group back whole
  };

  const heldBack: HeldBack[] = [];
  for (;;) {
    try {
      restore();
      const attempt = campaign(undefined, true);
      if (attempt.fixed === 0) return { fixed: 0, touched: [], heldBack, keptComments: [] };
      if (!verifying) {
        return { fixed: attempt.fixed, touched: [...dirty], heldBack, keptComments: attempt.keptComments };
      }

      const errors = probe();
      if (errors.length === 0) {
        return { fixed: attempt.fixed, touched: [...dirty], heldBack, keptComments: attempt.keptComments };
      }

      const single = failsWith(attempt.fixedKeys);
      if (!single.fails) {
        // Only a cascade pass breaks the probe: keep the verified single-pass state.
        options.log('Cascade fixes held back: a later pass would introduce errors.');
        return { fixed: attempt.fixedKeys.length, touched: [...dirty], heldBack, keptComments: single.keptComments };
      }

      const culprits = bisect(attempt.fixedKeys);
      for (const key of culprits) {
        excluded.add(key);
        const finding = byKey.get(key);
        if (finding) heldBack.push({ finding, errors });
      }
      if (excluded.size > MAX_HELD_BACK || culprits.length === 0) {
        restore();
        return { fixed: 0, touched: [], heldBack, keptComments: [], aborted: errors };
      }
    } catch (error) {
      // A fix the editor could not carry out gets the answer a fix that fails
      // the type check gets: rolled back, held back, named — and the rest of
      // the run goes on without it. The tree it half-edited is thrown away
      // with the rest of the campaign.
      if (!(error instanceof UnappliedFix)) throw error;
      // The throw skipped the bookkeeping the campaign does on a clean return,
      // so the files it named join the dirty set before anything is restored.
      for (const filePath of error.filePaths) dirty.add(filePath);
      const key = findingKey(error.finding, cwd);
      const looping = excluded.has(key);
      if (!looping) {
        excluded.add(key);
        heldBack.push({ finding: error.finding, errors: [error.reason], unapplied: true });
      }
      if (looping || excluded.size > MAX_HELD_BACK) {
        restore();
        return { fixed: 0, touched: [], heldBack, keptComments: [], aborted: [error.reason] };
      }
    }
  }
}

/** How --fix recognizes one finding across re-analyses: content, not object identity. */
export function findingKey(finding: Finding, cwd: string): string {
  return [finding.kind, path.relative(cwd, finding.filePath), finding.name, finding.context].join('\x00');
}
