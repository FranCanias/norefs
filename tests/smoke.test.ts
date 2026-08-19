import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { root, runCli } from './helpers';

/**
 * The release probe. Every other test calls the engine; this one runs the
 * binary a user installs, against a repository that holds the exhibits five
 * reviews have raised — the colour chain, the IPC bridge, the imperative
 * handle. 0.4.0 shipped a headline feature that had never completed a run
 * against the example in its own release notes. This is the run.
 */
const repo = path.join(root, 'tests', 'exhibit-repo');
const tsconfig = path.relative(root, path.join(repo, 'tsconfig.json'));

function norefs(...args: string[]) {
  return runCli(root, '-p', tsconfig, ...args);
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
    expect(norefs('bogus').status).toBe(2);
  });

  it('shows its entry points and what named each one', () => {
    // An entry point silently makes a file used and its exports public API.
    // The audit for that has to work in the binary a user installs.
    const run = norefs('entries');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('tests/exhibit-repo/src/index.ts  —  index/main/cli beside a tsconfig');
    expect(run.stderr).toContain('1 entry point(s)');
  });
});
