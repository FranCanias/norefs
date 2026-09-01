import path from 'node:path';
import { structuredPatch } from 'diff';
import type { Finding, MemberFinding, TypeKeyword } from '../types';

function describeFinding(finding: Finding): string {
  switch (finding.kind) {
    case 'file':
      return 'dead file';
    case 'export':
      // `default` is the module system's name for an export the author left
      // unnamed, so the sentence says what it is instead of quoting it.
      if (finding.name === 'default') {
        return finding.verdict === 'test-only'
          ? 'test-only default export: production code never uses it'
          : `dead default export${strandNote(finding)}`;
      }
      if (finding.verdict === 'test-only') return `test-only export \`${finding.name}\`: production code never uses it`;
      return finding.dead
        ? `dead export \`${finding.name}\`${strandNote(finding)}`
        : `over-exported: \`${finding.name}\` is used only in this file`;
    case 'type':
      if (finding.verdict === 'test-only') {
        return `test-only ${typeNoun(finding)} \`${finding.name}\`: production code never uses it`;
      }
      return finding.dead
        ? `dead exported ${typeNoun(finding)} \`${finding.name}\``
        : `over-exported: ${typeNoun(finding)} \`${finding.name}\` is used only in this file`;
    case 'ns-export':
      return finding.dead
        ? `dead export \`${finding.name}\` in used namespace \`${finding.context}\``
        : `over-exported: \`${finding.name}\` is used only inside namespace \`${finding.context}\``;
    case 'ns-type':
      return finding.dead
        ? `dead exported ${typeNoun(finding)} \`${finding.name}\` in used namespace \`${finding.context}\``
        : `over-exported: ${typeNoun(finding)} \`${finding.name}\` is used only inside namespace \`${finding.context}\``;
    case 'member':
      return describeMember(finding);
    case 'empty-type': {
      if (finding.context === 'returned object') {
        const properties =
          finding.swallowed === 1 ? 'its only property is unused' : `all ${finding.swallowed} properties are unused`;
        return `nobody reads what \`${finding.name}\` returns: ${properties} — the computation is dead weight${strandNote(finding)}`;
      }
      // A shape offering one member is common enough to deserve its own
      // sentence: "all 1 members are dead" is not something a person writes.
      const count =
        finding.swallowed === 1
          ? 'its only member is'
          : finding.swallowed
            ? `all ${finding.swallowed} members are`
            : 'every member is';
      const claim = `${finding.context} \`${finding.name}\` becomes empty: ${count} ${memberClaim(finding)}`;
      const described =
        finding.verdict && finding.verdict !== 'dead' && finding.evidence ? `${claim} — ${finding.evidence}` : claim;
      return `${described}${strandNote(finding)}`;
    }
    case 'dependency':
      return `dead dependency \`${finding.name}\``;
    case 'unlisted':
      return `dependency \`${finding.name}\` is not listed in package.json`;
    case 'misplaced':
      return `\`${finding.name}\` is in ${finding.context}: ${finding.evidence}`;
    case 'stranded':
      return `stranded handler for \`'${finding.name}'\`: ${finding.evidence ?? 'this report deletes its only sender'}`;
  }
}

function memberClaim(finding: { verdict?: string | undefined }): string {
  switch (finding.verdict) {
    case 'write-only':
      return 'write-only';
    case 'contract':
      return 'unread, and it looks like a data contract';
    case 'shadowed':
      return 'shadowed by a duplicate type';
    default:
      return 'dead';
  }
}

function describeMember(finding: MemberFinding): string {
  const subject = `property \`${finding.name}\` in ${finding.context}`;
  switch (finding.verdict) {
    case 'write-only':
      return `write-only ${subject}: ${finding.evidence ?? 'assigned somewhere, never read'}`;
    case 'contract':
      return `${subject} looks like a data contract: ${finding.evidence ?? 'its type crosses a serialization boundary'}`;
    case 'shadowed':
      return `${subject} is unread here, but ${finding.evidence ?? 'a structural twin reads it'} — the finding is the duplication`;
    case 'test-only':
      return `test-only ${subject}: production code never reads it`;
    default:
      return `dead ${subject}${strandNote(finding)}`;
  }
}

/** The far side of a dead bridge wrapper rides along, whatever the reporter. */
function strandNote(finding: { strands?: string | undefined }): string {
  return finding.strands ? ` — ${finding.strands}` : '';
}

function typeNoun(finding: { typeKind?: TypeKeyword | undefined }): string {
  return finding.typeKind ?? 'type';
}

/** The headline counts by verdict: the claim each finding makes, not one flat "unused". */
function summarize(findings: Finding[]): string {
  const count = (match: (f: Finding) => boolean): number => findings.filter(match).length;
  const groups: Array<[number, string, string]> = [
    [count(f => f.verdict === 'dead'), 'dead', 'dead'],
    [count(f => f.verdict === 'over-exported'), 'over-exported', 'over-exported'],
    [count(f => f.verdict === 'write-only'), 'write-only', 'write-only'],
    [count(f => f.verdict === 'contract'), 'likely contract', 'likely contracts'],
    [count(f => f.verdict === 'shadowed'), 'shadowed by a duplicate type', 'shadowed by duplicate types'],
    [count(f => f.verdict === 'test-only'), 'test-only', 'test-only'],
    [count(f => f.kind === 'unlisted'), 'unlisted dependency', 'unlisted dependencies'],
    [count(f => f.kind === 'misplaced'), 'misplaced dependency', 'misplaced dependencies'],
    [count(f => f.kind === 'stranded'), 'stranded handler', 'stranded handlers'],
  ];
  const parts = groups.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  return `${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}: ${parts.join(', ')}`;
}

/** The finding plus its evidence chain, for --explain. Soft verdicts embed it already. */
function withEvidence(finding: Finding, explain: boolean): string {
  const message = describeFinding(finding);
  if (!explain || !finding.evidence || message.includes(finding.evidence)) return message;
  return `${message} — ${finding.evidence}`;
}

function groupByFile(findings: Finding[]): Map<string, Finding[]> {
  const byFile = new Map<string, Finding[]>();
  for (const finding of findings) {
    const list = byFile.get(finding.filePath) ?? [];
    list.push(finding);
    byFile.set(finding.filePath, list);
  }
  return byFile;
}

export function formatText(findings: Finding[], cwd: string, explain = false): string {
  if (findings.length === 0) return 'No unused code found.\n';

  const lines: string[] = [];
  for (const [filePath, fileFindings] of groupByFile(findings)) {
    lines.push(path.relative(cwd, filePath));
    for (const finding of fileFindings) {
      lines.push(
        finding.kind === 'file'
          ? `  ${withEvidence(finding, explain)}`
          : `  ${finding.line}:${finding.column}  ${withEvidence(finding, explain)}`
      );
    }
  }
  lines.push('', summarize(findings));
  return lines.join('\n');
}

export function formatMarkdown(findings: Finding[], cwd: string, explain = false): string {
  const lines: string[] = ['# norefs findings', ''];
  if (findings.length === 0) {
    lines.push('No unused code found.');
    return lines.join('\n');
  }

  lines.push(summarize(findings), '');
  for (const [filePath, fileFindings] of groupByFile(findings)) {
    const relativePath = path.relative(cwd, filePath);
    lines.push(`[${path.basename(relativePath)}](${relativePath})`, '');
    for (const finding of fileFindings) {
      lines.push(
        finding.kind === 'file'
          ? `- ${withEvidence(finding, explain)}`
          : `- ${withEvidence(finding, explain)} (line ${finding.line}, column ${finding.column})`
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** A unified diff of one file, for --fix --dry-run. */
export function formatPatch(relativePath: string, before: string, after: string): string {
  const patch = structuredPatch(relativePath, relativePath, before, after);
  const lines = [`--- ${relativePath}`, `+++ ${relativePath}`];
  for (const hunk of patch.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    lines.push(...hunk.lines);
  }
  return lines.join('\n');
}

/** One GitHub workflow command per finding, so they show inline on pull requests. */
export function formatGitHub(findings: Finding[], cwd: string): string {
  if (findings.length === 0) return 'No unused code found.';
  const lines = findings.map(f => {
    const file = escapeProperty(path.relative(cwd, f.filePath));
    return `::error file=${file},line=${f.line},col=${f.column},title=norefs::${escapeData(describeFinding(f))}`;
  });
  lines.push(summarize(findings));
  return lines.join('\n');
}

function escapeData(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

export function formatSarif(findings: Finding[], cwd: string): string {
  return JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'norefs',
              informationUri: 'https://github.com/FranCanias/norefs',
              rules: [...new Set(findings.map(f => f.kind))].map(kind => ({ id: kind })),
            },
          },
          results: findings.map(f => ({
            ruleId: f.kind,
            level: 'warning',
            message: { text: describeFinding(f) },
            ...(f.verdict ? { properties: { verdict: f.verdict } } : {}),
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: path.relative(cwd, f.filePath) },
                  region: { startLine: f.line, startColumn: f.column },
                },
              },
            ],
          })),
        },
      ],
    },
    null,
    2
  );
}

export function formatJson(findings: Finding[], cwd: string): string {
  return JSON.stringify(
    findings.map(f => ({
      kind: f.kind,
      filePath: path.relative(cwd, f.filePath),
      line: f.line,
      column: f.column,
      name: f.name,
      context: f.context,
      anonymous: f.anonymous,
      dead: 'dead' in f ? f.dead : undefined,
      typeKind: 'typeKind' in f ? f.typeKind : undefined,
      verdict: f.verdict,
      evidence: f.evidence,
      swallowed: 'swallowed' in f ? f.swallowed : undefined,
      strands: 'strands' in f ? f.strands : undefined,
    })),
    null,
    2
  );
}
