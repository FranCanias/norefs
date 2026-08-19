import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Project } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import type { Finding } from '../types';
import { isFixable, unremovableWrites } from './fix';
import { editManifest, manifestEdits } from './fix-manifest';
import { applyVerifiedFixes, findingKey } from './fix-verified';
import { formatLocation } from './location';
import { formatPatch } from './report';

interface CampaignOptions {
  project: Project;
  /** The findings of the pristine project, already baseline-filtered. */
  findings: Finding[];
  /** Fresh, baseline-filtered findings for the current in-memory state. */
  reanalyze: () => Finding[];
  /** Also fix write-only, contract, and shadowed findings, and edit package.json. */
  unsafe: boolean;
  /** Type-check the fixes before saving them. */
  verify: boolean;
  /** A command that must exit 0 for the fixes to count — the user's tests, say. */
  command?: string | undefined;
  /** False for --dry-run: nothing is written and the diffs come back instead. */
  save: boolean;
  cwd: string;
  /** Progress from inside the verified-fix loop. */
  log: (line: string) => void;
}

interface CampaignResult {
  /** Verification failed and no single fix could be isolated; nothing changed. */
  aborted?: string[] | undefined;
  /** What the run has to tell the operator, in the order it happened. */
  notes: string[];
  /** Unified diffs of the would-be changes. Empty unless `save` was false. */
  patches: string[];
}

/**
 * Fix, prove, save — and account for everything the proof could not cover.
 *
 * The verified campaign itself lives in `fix-verified.ts`; this is the policy
 * around it. What --fix refuses and why, which claims a type check cannot back,
 * the package.json edits no type check reads, and what a human still has to
 * reread: all of it decided here, so the CLI only routes the answers.
 */
export function runFixCampaign(options: CampaignOptions): CampaignResult {
  const { project, cwd, unsafe, save, command } = options;
  const findings = options.findings;
  const verify = options.verify && findings.some(f => isFixable(f, unsafe));
  const notes: string[] = [];
  const patches: string[] = [];

  // A fix finishes the finding it acts on or says why it can't. Read before
  // the first edit, so the coordinates are the ones the report printed.
  const refusals = unsafe
    ? findings.flatMap(finding => {
        const stuck = unremovableWrites(finding);
        if (stuck.length === 0) return [];
        const where = stuck
          .map(site => {
            const at = formatLocation(site.getSourceFile().getFilePath(), site.getStartLineNumber(), cwd);
            return site.isKind(SyntaxKind.SpreadAssignment)
              ? `the spread at ${at}, which carries members beyond this one,`
              : `the write at ${at}`;
          })
          .join(' and ');
        const at = formatLocation(finding.filePath, finding.line, cwd);
        return [`Kept \`${finding.name}\` (${at}): ${where} is why this isn't safe — removing it is yours to do`];
      })
    : [];
  // Counted here for the same reason: a fix the verify loop rolled back
  // leaves the findings it touched holding nodes the project has forgotten.
  const skipped = findings.filter(f => !isFixable(f, unsafe)).length;

  // "Verified" must not claim more than the probe can see: de-exporting is
  // compiler-checkable, but a deleted member can have runtime-only readers
  // (an identity-tracked context value, an inference-typed producer) that no
  // type check reaches — and a retired write takes a computation with it
  // that no type check weighs. Say so unless the user's own command also ran.
  const memberFixes = findings.some(f => f.kind === 'member' && isFixable(f, unsafe));
  const writeFixes = findings.some(f => f.kind === 'member' && (f.writeSites?.length ?? 0) > 0 && isFixable(f, unsafe));
  const blindSpot = writeFixes
    ? 'runtime-only reads of a deleted member, and it does not weigh what the writes deleted with it were doing'
    : 'runtime-only reads of deleted members';

  const result = applyVerifiedFixes({
    project,
    findings,
    reanalyze: options.reanalyze,
    unsafe,
    verify,
    check: command ? commandCheck(command, cwd) : undefined,
    cwd,
    log: options.log,
  });

  if (result.aborted) return { aborted: result.aborted, notes, patches };

  for (const { finding, errors, unapplied } of result.heldBack) {
    const where = `${path.relative(cwd, finding.filePath)}:${finding.line}`;
    const why = unapplied ? `the edit could not be applied — ${errors[0]}` : `fixing it would introduce ${errors[0]}`;
    notes.push(`Held back \`${finding.name}\` (${where}): ${why}`);
  }

  // Two things no probe can verify, so a human gets pointed at them: prose
  // that outlived the code it described, and the far side of a deleted
  // bridge wrapper. Comment locations were recorded against intermediate
  // pass states, so each one is re-found in the final text by its own words
  // and dropped when a later pass removed it.
  const spots: string[] = [];
  for (const kept of result.keptComments) {
    const content = project.getSourceFile(kept.filePath)?.getFullText();
    if (content === undefined) continue;
    const lines = content.split('\n');
    const line = (lines[kept.line - 1] ?? '').includes(kept.text)
      ? kept.line
      : lines.findIndex(l => l.includes(kept.text)) + 1;
    if (line === 0) continue; // the comment did not survive later passes
    const spot = formatLocation(kept.filePath, line, cwd);
    if (!spots.includes(spot)) spots.push(spot);
  }
  if (spots.length > 0) {
    notes.push(
      spots.length === 1
        ? `A comment near the fixes was kept: reread ${spots[0]}`
        : `${spots.length} comments near the fixes were kept: reread ${spots.join(', ')}`
    );
  }
  notes.push(...refusals);
  // Held-back findings come from a re-analysis, so they are matched by
  // content, never by object identity: a held-back wrapper was not deleted
  // and gets no stranding warning.
  const held = new Set(result.heldBack.map(h => findingKey(h.finding, cwd)));
  for (const finding of findings) {
    if (!('strands' in finding) || finding.strands === undefined) continue;
    if (!isFixable(finding, unsafe) || held.has(findingKey(finding, cwd))) continue;
    notes.push(`\`${finding.name}\`: ${finding.strands} — no analysis will flag it once the wrapper is gone`);
  }

  // package.json is edited as text, after the campaign and outside it: no
  // type check reads a manifest, so there is nothing for the campaign's probe
  // to say about these. The command you supply is the only probe that can
  // judge them, and it gets the last word below.
  const manifests = new Map<string, string>();
  let manifestFixed = 0;
  const manifestFindings = findings.filter(f => isFixable(f, unsafe) && !held.has(findingKey(f, cwd)));
  for (const [filePath, edits] of manifestEdits(manifestFindings)) {
    const before = fs.readFileSync(filePath, 'utf8');
    const { text, refused } = editManifest(before, edits);
    for (const { name, reason } of refused) {
      notes.push(`Held back \`${name}\` (${path.relative(cwd, filePath)}): ${reason}`);
    }
    if (text === before) continue;
    manifests.set(filePath, text);
    manifestFixed += edits.length - refused.length;
  }
  if (manifests.size > 0 && command) {
    const candidates = new Map(manifests);
    for (const filePath of result.touched) {
      const text = project.getSourceFile(filePath)?.getFullText();
      if (text !== undefined) candidates.set(filePath, text);
    }
    const errors = runOnCandidates(command, cwd, candidates);
    if (errors.length > 0) {
      notes.push(`Held back the package.json edits: ${errors[0]}`);
      manifests.clear();
      manifestFixed = 0;
    }
  }
  const fixedCount = result.fixed + manifestFixed;
  const fileCount = result.touched.length + manifests.size;

  const verifiedLine = (fixes: string): string => {
    const unseen = [memberFixes ? blindSpot : '', manifests.size > 0 ? 'a package.json edit' : ''].filter(
      part => part.length > 0
    );
    const caveat =
      unseen.length > 0 && !command
        ? ` A type check cannot see ${unseen.join(' or ')}; add --verify-command to run your tests too.`
        : '';
    return `Verified: tsc reports no new errors after the ${fixes}.${caveat}`;
  };

  if (!save) {
    for (const filePath of [...result.touched].sort()) {
      const before = fs.readFileSync(filePath, 'utf8');
      const after = project.getSourceFile(filePath)?.getFullText() ?? before;
      patches.push(formatPatch(path.relative(cwd, filePath), before, after));
    }
    for (const [filePath, after] of [...manifests].sort()) {
      const before = fs.readFileSync(filePath, 'utf8');
      patches.push(formatPatch(path.relative(cwd, filePath), before, after));
    }
    if (verify) notes.push(verifiedLine('would-be fixes'));
    notes.push(`Dry run: would fix ${fixedCount} finding(s) in ${fileCount} file(s)`);
    return { notes, patches };
  }

  for (const filePath of result.touched) {
    project.getSourceFile(filePath)?.saveSync();
  }
  for (const [filePath, text] of manifests) fs.writeFileSync(filePath, text);
  if (verify) notes.push(verifiedLine('fixes'));
  notes.push(`Fixed ${fixedCount} finding(s) in ${fileCount} file(s)`);

  if (skipped > 0) {
    const untouched = unsafe
      ? 'files, namespaces, emptied types, test-only findings, proven writes no single edit can retire'
      : 'write-only, contract, shadowed, and package.json findings need --fix-unsafe; files, namespaces, emptied types, and test-only findings are never touched';
    notes.push(`Skipped ${skipped} finding(s) --fix does not touch (${untouched})`);
  }
  return { notes, patches };
}

/**
 * The --verify-command probe. An external command reads from disk, so the
 * candidate texts go to disk for the run and the originals come back before
 * the verdict — a failed probe leaves no trace.
 */
function commandCheck(command: string, cwd: string): (project: Project, dirtyFilePaths: string[]) => string[] {
  return (project, dirtyFilePaths) => {
    const candidates = new Map<string, string>();
    for (const filePath of dirtyFilePaths) {
      const text = project.getSourceFile(filePath)?.getFullText();
      if (text !== undefined) candidates.set(filePath, text);
    }
    return runOnCandidates(command, cwd, candidates);
  };
}

/**
 * Run the command with these texts in place, and put the originals back.
 *
 * The probe is the one moment unverified text sits in the user's real files.
 * A crash inside that window would leave it there with nothing to compare
 * against, so the originals go to a restore record first — see
 * `docs/flags.md` for how to read one back.
 */
function runOnCandidates(command: string, cwd: string, candidates: Map<string, string>): string[] {
  const originals = new Map([...candidates.keys()].map(filePath => [filePath, fs.readFileSync(filePath, 'utf8')]));
  const record = writeRestoreRecord(originals);
  try {
    for (const [filePath, text] of candidates) fs.writeFileSync(filePath, text);
    const run = spawnSync(command, { shell: true, cwd, encoding: 'utf8' });
    if (run.status === 0) return [];
    const tail = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim().split('\n').slice(-3).join(' | ');
    return [`\`${command}\` exited with ${run.status ?? 'a signal'}: ${tail}`];
  } finally {
    for (const [filePath, text] of originals) fs.writeFileSync(filePath, text);
    fs.rmSync(record, { force: true });
  }
}

/** The pre-probe contents of every file about to be overwritten, keyed by path. */
function writeRestoreRecord(originals: Map<string, string>): string {
  const filePath = path.join(os.tmpdir(), `norefs-restore-${process.pid}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(Object.fromEntries(originals), null, 2)}\n`);
  return filePath;
}
