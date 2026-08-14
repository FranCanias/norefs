import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The release probe. Every other test calls the engine; this one runs the
 * binary a user installs, against a repository that holds the exhibits five
 * reviews have raised — the colour chain, the IPC bridge, the imperative
 * handle. 0.4.0 shipped a headline feature that had never completed a run
 * against the example in its own release notes. This is the run.
 */
const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'dist', 'index.js');
const repo = path.join(root, 'tests', 'exhibit-repo');
const tsconfig = path.relative(root, path.join(repo, 'tsconfig.json'));

function norefs(...args: string[]): { status: number; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [cli, '-p', tsconfig, ...args], { cwd: root, encoding: 'utf8' });
  return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
}

/** One hash over the fixture tree, so a run that promised to write nothing can be held to it. */
function treeHash(): string {
  const hash = createHash('sha256');
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else hash.update(full).update(fs.readFileSync(full));
    }
  };
  walk(repo);
  return hash.digest('hex');
}

beforeAll(() => {
  const build = spawnSync('npm', ['run', 'build'], { cwd: root, encoding: 'utf8' });
  expect(build.status, build.stderr).toBe(0);
}, 60_000);

describe('the binary, on the exhibit repository', () => {
  it('reports the exhibits and exits 1, as the flag reference says', () => {
    const run = norefs();
    expect(run.status).toBe(1);
    expect(run.stderr).not.toContain('at Object.');
    // The colour chain: three proven writes, each named with its own site.
    expect(run.stdout).toContain('write-only property `canvas`');
    expect(run.stdout).toContain('proven, never read');
    // The imperative handle: the write cannot be this owner's shape, so the
    // sibling is not protected by it.
    expect(run.stdout).toContain('dead property `reset`');
    // The IPC bridge: the over-exported class strands nothing, the dead
    // method strands its own handler — and the handler is named, once.
    expect(run.stdout).toContain('over-exported: `RecipeBoxService`');
    expect(run.stdout).not.toContain("'recipeBox:saveRecipe'");
    expect(run.stdout).toContain("stranded handler for `'recipeBox:oldRecipe'`");
    expect(run.stdout).toContain('`oldRecipe` at tests/exhibit-repo/src/service.ts:10');
  });

  it('completes --fix-unsafe --dry-run and writes nothing', () => {
    const before = treeHash();
    const run = norefs('--fix-unsafe', '--dry-run');
    expect(run.status).toBe(1);
    // No stack trace, no half-finished campaign: the whole feature runs.
    expect(run.stderr).not.toContain('ManipulationError');
    expect(run.stderr).not.toContain('Manipulation error');
    expect(run.stderr).not.toMatch(/^\s+at /m);
    expect(run.stderr).toContain('Dry run: would fix 6 finding(s) in 3 file(s)');
    expect(run.stderr).toContain('Verified: tsc reports no new errors');
    // Each comment leaves with the property it described, and none of them
    // lands on a line it never described.
    expect(run.stdout).toContain('-      canvas, // light: #F9F9FA, dark: #242424');
    expect(run.stdout).toContain('-      // Grid - more visible in dark');
    expect(run.stdout).toContain('-    [canvas, grid, curve]');
    expect(run.stdout).toContain('+    []');
    expect(run.stdout).not.toMatch(/^\+.*#F9F9FA/m);
    expect(treeHash()).toBe(before);
  });

  it('exits 0 with no findings and 2 on a usage error', () => {
    expect(norefs('--only', 'unlisted').status).toBe(0);
    expect(norefs('--dry-run').status).toBe(2);
  });
});

describe('the settings a project decides once', () => {
  const PROJECT: Record<string, string> = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true },
      include: ['**/*.ts'],
    }),
    // A named dead member with two unnamed ones nested under it, so --anon has
    // something to add.
    'src/lib.ts': [
      'export type Props = {',
      '  target: { value: string; label: string };',
      '  keep: string;',
      '};',
      'export const helper = (p: Props): string => p.keep;',
      '',
    ].join('\n'),
    'src/other.ts': [
      'export interface Other {',
      '  used: string;',
      '  unused: string;',
      '}',
      'export const other = (o: Other): string => o.used;',
      '',
    ].join('\n'),
    'src/index.ts': [
      "import { helper, type Props } from './lib';",
      "import { other, type Other } from './other';",
      'declare const p: Props;',
      'declare const o: Other;',
      'export const run = (): string => helper(p) + other(o);',
      '',
    ].join('\n'),
  };

  /** A throwaway project with a config file beside its tsconfig. */
  function configured(config: Record<string, unknown>, ...args: string[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'norefs-config-run-'));
    try {
      for (const [name, text] of Object.entries(PROJECT)) {
        fs.mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), text);
      }
      fs.writeFileSync(path.join(dir, 'norefs.config.json'), JSON.stringify(config, null, 2));
      const run = spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });
      return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('reads scope from the config file', () => {
    const run = configured({ scope: 'src/other.ts' });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('src/other.ts');
    expect(run.stdout).not.toContain('src/lib.ts');
  });

  it('reads reporter from the config file', () => {
    const run = configured({ reporter: 'github' });
    expect(run.stdout).toContain('::error file=src/lib.ts');
    // Not the text report's "line:column  claim" lines.
    expect(run.stdout).not.toMatch(/^ {2}\d+:\d+ {2}/m);
  });

  it('reads explain and anon from the config file', () => {
    const chain = 'no references anywhere';
    expect(configured({}).stdout).not.toContain(chain);
    expect(configured({ explain: true }).stdout).toContain(chain);

    expect(configured({}).stdout).not.toContain('`value`');
    expect(configured({ anon: true }).stdout).toContain('`value`');
  });

  it('lets a flag passed on the run win over the config', () => {
    const run = configured({ reporter: 'github' }, '--reporter', 'json');
    expect(run.stdout.trimStart().startsWith('[')).toBe(true);
    expect(run.stdout).not.toContain('::error');
  });

  it('lets --no-explain and --no-anon turn a config setting back off', () => {
    // The reason neither flag carries a default: a run has to be able to say
    // no to a project that said yes.
    expect(configured({ explain: true }, '--no-explain').stdout).not.toContain('no references anywhere');
    expect(configured({ anon: true }, '--no-anon').stdout).not.toContain('`value`');
  });

  it('names the config file when the reporter in it is not a real one', () => {
    const run = configured({ reporter: 'jsonl' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('"reporter" in norefs.config.json must be one of');
    // And names the flag when the flag is what carried it.
    expect(norefs('--reporter', 'jsonl').stderr).toContain('--reporter must be one of');
  });

  it('refuses an action in the config file', () => {
    // --fix, --baseline, --dry-run, --watch and --export each write something.
    // They belong to a run, not to the project.
    for (const action of ['fix', 'baseline', 'dry-run', 'watch', 'export']) {
      const run = configured({ [action]: true });
      expect(run.status, action).toBe(2);
      expect(run.stderr, action).toContain(`unknown key "${action}"`);
    }
  });
});
