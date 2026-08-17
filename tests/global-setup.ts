import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * Build the binary once, before any worker starts.
 *
 * `cli.test.ts` and `smoke.test.ts` both spawn `dist/index.js`, and both used
 * to build it in their own `beforeAll`. Those hooks run in separate worker
 * processes, so one suite's build could delete `dist` while the other was
 * spawning it. Here there is one build, and it finishes before the first test
 * exists. It costs under a second, so every run pays it and no run has to
 * reason about whether `dist` is current.
 */
export default function setup(): void {
  const root = path.resolve(__dirname, '..');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const build = spawnSync(npm, ['run', 'build'], { cwd: root, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`build failed: ${build.stderr || build.stdout}`);
}
