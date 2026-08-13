import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';

describe('the anonymous flag', () => {
  it('marks members of a literal nested inside another type as anonymous', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      '/main.ts',
      [
        'type ChangeEvent = {',
        '  target: { value: string; checked: boolean };',
        '  bubbles: boolean;',
        '};',
        'declare const e: ChangeEvent;',
        'export const run = () => [e.target.value, e.bubbles];',
        '',
      ].join('\n')
    );
    const findings = analyze(project);

    // `checked` sits in an unnamed inline type: reported, but flagged
    // anonymous so the default run hides it.
    const checked = findings.find(f => f.kind === 'member' && f.name === 'checked');
    expect(checked?.anonymous).toBe(true);
  });
});
