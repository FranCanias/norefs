import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import { loadProject } from '../src/engine/project';
import type { Finding, FindingKind } from '../src/types';
import { fixture } from './helpers';

const fixturesDir = fixture('fixtures');
const options = { rootDirs: [fixturesDir], entries: [fixturesDir] };

/** A finding as a comparable line, so two runs can be compared exactly. */
function lines(findings: Finding[], kinds: FindingKind[]): string[] {
  return findings
    .filter(f => kinds.includes(f.kind))
    .map(f => `${f.kind} ${f.filePath}:${f.line}:${f.column} ${f.name} ${f.context}`)
    .sort();
}

/** A fresh project each time: the run must not depend on an index left behind. */
function run(kinds?: FindingKind[]): Finding[] {
  return analyze(loadProject([fixture('fixtures', 'tsconfig.json')]), { ...options, kinds });
}

describe('asking for fewer kinds does not change the findings', () => {
  const everything = run();

  it('reports the same exports and types without the member analysis', () => {
    const kinds: FindingKind[] = ['export', 'type'];
    expect(lines(run(kinds), kinds)).toEqual(lines(everything, kinds));
  });

  it('reports the same files and dependencies without the member analysis', () => {
    const kinds: FindingKind[] = ['file', 'dependency', 'unlisted'];
    expect(lines(run(kinds), kinds)).toEqual(lines(everything, kinds));
  });

  it('reports the same members when they are all that is asked for', () => {
    const kinds: FindingKind[] = ['member'];
    expect(lines(run(kinds), kinds)).toEqual(lines(everything, kinds));
  });

  it('still reports empty types, which rest on the member analysis', () => {
    const source = [
      'interface Zone {',
      '  dead1: number;',
      '  dead2: number;',
      '}',
      'export function useZone(zone: Zone): number {',
      '  return 0;',
      '}',
      '',
    ].join('\n');
    const inProject = (kinds?: FindingKind[]): Finding[] => {
      const project = new Project({ useInMemoryFileSystem: true });
      project.createSourceFile('/main.ts', source);
      return analyze(project, { kinds });
    };

    const asked = lines(inProject(['empty-type']), ['empty-type']);
    expect(asked).toEqual(lines(inProject(), ['empty-type']));
    expect(asked).toHaveLength(1);
  });

  it('an empty kind list means every kind', () => {
    expect(run([]).length).toBe(everything.length);
  });
});
