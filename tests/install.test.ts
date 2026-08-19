import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { root, withTempDir, writeFiles } from './helpers';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

describe('the built binary and the packed tarball', () => {
  it('ships an executable bin: shebang first, mode 0o755', () => {
    // The build chmods dist/index.js after tsc. Nothing pinned either half of
    // that promise, so a build change could ship a bin `npx` cannot start.
    const bin = path.join(root, 'dist', 'index.js');
    expect(fs.readFileSync(bin, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(bin).mode & 0o755).toBe(0o755);
    }
  });

  it('installs from the packed tarball and answers --help', () => {
    // The suite otherwise runs dist/index.js out of the repository, where a
    // stray require of something outside dist/ still resolves. Only an
    // installed copy proves the tarball is complete — the class of regression
    // where the published package cannot start at all.
    withTempDir('norefs-install-', dir => {
      const packed = execFileSync(npm, ['pack', '--pack-destination', dir], { cwd: root, encoding: 'utf8' })
        .trim()
        .split('\n')
        .at(-1);
      expect(packed).toBeDefined();
      writeFiles(dir, { 'package.json': '{ "name": "probe", "private": true }\n' });
      execFileSync(npm, ['install', '--no-audit', '--no-fund', path.join(dir, packed as string)], {
        cwd: dir,
        encoding: 'utf8',
      });
      const bin = path.join(dir, 'node_modules', 'norefs', 'dist', 'index.js');
      const run = spawnSync(process.execPath, [bin, '--help'], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('norefs - find unused');
    });
  });
});
