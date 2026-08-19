import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Build the binary once, before any worker starts.
 *
 * `cli.test.ts` and `smoke.test.ts` both spawn `dist/index.js`, and both used
 * to build it in their own `beforeAll`. Those hooks run in separate worker
 * processes, so one suite's build could delete `dist` while the other was
 * spawning it. Here there is one build, and it finishes before the first test
 * exists.
 *
 * A contributor iterating on one in-memory test should not pay a full tsc per
 * run, so the build is skipped when `dist/index.js` is newer than every build
 * input. CI builds unconditionally, so staleness cannot hide there.
 */
export default function setup(): void {
  const root = path.resolve(__dirname, '..');
  if (!process.env.CI && distIsFresh(root)) return;
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const build = spawnSync(npm, ['run', 'build'], { cwd: root, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`build failed: ${build.stderr || build.stdout}`);
}

/** True when dist/index.js is newer than every file that feeds the build. */
function distIsFresh(root: string): boolean {
  const built = mtime(path.join(root, 'dist', 'index.js'));
  if (built === undefined) return false;
  const inputs = [
    path.join(root, 'tsconfig.json'),
    path.join(root, 'package.json'),
    ...fs
      .readdirSync(path.join(root, 'src'), { recursive: true, encoding: 'utf8' })
      .map(name => path.join(root, 'src', name)),
  ];
  // Directories in the listing have no mtime worth reading; only files feed tsc.
  return inputs.every(input => {
    const changed = mtime(input);
    return changed === undefined || changed < built;
  });
}

function mtime(filePath: string): number | undefined {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}
