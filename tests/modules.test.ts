import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import { loadProject } from '../src/engine/project';
import type { Finding } from '../src/types';

const rootDir = path.resolve('tests/module-fixtures');
const project = loadProject([path.join(rootDir, 'tsconfig.json')]);
const findings = analyze(project, { rootDirs: [rootDir] });

function reportedIn(fixture: string): Array<[Finding['kind'], string]> {
  return findings
    .filter(f => f.filePath.endsWith(`/${fixture}`))
    .map(f => [f.kind, f.name] as [Finding['kind'], string])
    .sort();
}

describe('unused files', () => {
  it('reports a file nothing references', () => {
    expect(reportedIn('orphan.ts')).toEqual([['file', 'orphan.ts']]);
  });

  it('suppresses export and member findings inside an unused file', () => {
    expect(findings.filter(f => f.filePath.endsWith('/orphan.ts') && f.kind !== 'file')).toEqual([]);
  });

  it('treats index files in the root as entry points', () => {
    expect(reportedIn('index.ts')).toEqual([]);
  });

  it('keeps a file alive that only a side-effect import reaches', () => {
    // A file with no import and no export of its own is a script, and the type
    // system links a specifier only to a module — so `getReferencedSourceFiles`
    // drops `import './registered'` and the file looks unreached. tsc compiles
    // it without complaint, so calling it dead is a false positive at the
    // highest confidence there is.
    expect(reportedIn('registered.ts')).toEqual([]);
  });

  it('treats test and config files as their own entry points', () => {
    expect(reportedIn('harness.config.ts')).toEqual([]);
  });
});

describe('unused exports and exported types', () => {
  it('reports exports and types nothing imports, and skips used ones', () => {
    expect(reportedIn('exports.ts')).toEqual([
      ['export', 'deadFn'],
      ['export', 'deadValue'],
      ['type', 'DeadAlias'],
      ['type', 'DeadEnum'],
      ['type', 'DeadShape'],
    ]);
  });

  it('resolves usage through a re-export chain', () => {
    expect(reportedIn('barrel.ts')).toEqual([]);
    expect(reportedIn('chain.ts')).toEqual([['export', 'chainDead']]);
  });

  it('suppresses member findings inside a dead exported declaration', () => {
    const memberNames = findings.filter(f => f.kind === 'member').map(f => f.name);
    expect(memberNames).not.toContain('height');
    expect(memberNames).not.toContain('A');
  });
});

describe('exports in used namespace', () => {
  it('downgrades unused exports of a namespace-imported module', () => {
    expect(reportedIn('helpers.ts')).toEqual([
      ['ns-export', 'two'],
      ['ns-type', 'DeadNsShape'],
    ]);
    expect(findings.find(f => f.name === 'two')?.context).toBe('helpers');
  });

  it('reports exported members of a used TS namespace whose references never leave the body', () => {
    expect(reportedIn('ns-decl.ts')).toEqual([
      ['ns-export', 'dead'],
      ['ns-export', 'helper'],
      ['ns-export', 'internalUser'],
      ['ns-type', 'DeadName'],
      ['ns-type', 'DeadOptions'],
    ]);
    expect(findings.find(f => f.name === 'dead')?.context).toBe('Config');
  });
});

describe('exports a dynamic import destructures', () => {
  // `const { plated } = await import('./lazy')` uses `plated`, and the binding
  // it creates is a symbol of its own — so nothing about the occurrence says
  // which export it names. The exports were reported dead, which is the one
  // mistake this analysis does not make. The link is the module the pattern
  // reads, and it is in the expression, so no member analysis is needed to
  // follow it.
  it('counts the awaited form, renamed bindings included', () => {
    expect(reportedIn('lazy.ts')).not.toContainEqual(['export', 'plated']);
    expect(reportedIn('lazy.ts')).not.toContainEqual(['type', 'Course']);
  });

  it('counts the form `then` hands the namespace to', () => {
    expect(reportedIn('lazy.ts')).not.toContainEqual(['export', 'poured']);
  });

  it('still reports an export in that module nobody destructures', () => {
    expect(reportedIn('lazy.ts')).toEqual([['export', 'lazyDead']]);
  });
});
