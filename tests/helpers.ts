import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Project } from 'ts-morph';
import { analyze } from '../src/engine/analyze';
import type { Finding } from '../src/types';

/** The repository root, and the binary a user installs. */
export const root = path.resolve(__dirname, '..');
export const cli = path.join(root, 'dist', 'index.js');

/** A fixture path under tests/, anchored to this file — an IDE runner's cwd is not the repo root. */
export function fixture(...parts: string[]): string {
  return path.join(__dirname, ...parts);
}

/**
 * mkdtemp with symlinks resolved: macOS's os.tmpdir() is a symlink, and the
 * engine compares real paths, so an unresolved dir fails every path equality.
 */
export function makeTempDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Analyze these files in an in-memory project. Paths are absolute, as ts-morph wants them. */
export function analyzeFiles(files: Record<string, string>, options: Parameters<typeof analyze>[1] = {}): Finding[] {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, text] of Object.entries(files)) project.createSourceFile(filePath, text);
  return analyze(project, options);
}

/** Analyze one file, for a case that needs no second module. */
export function analyzeSource(source: string): Finding[] {
  return analyzeFiles({ '/main.ts': source });
}

/**
 * A temp directory that goes away however the test ends. An assertion that
 * fails mid-body is the case a trailing `rmSync` misses.
 */
export function withTempDir<T>(prefix: string, body: (dir: string) => T): T {
  const dir = makeTempDir(prefix);
  const remove = (): void => fs.rmSync(dir, { recursive: true, force: true });
  let result: T;
  try {
    result = body(dir);
  } catch (error) {
    remove();
    throw error;
  }
  // An async body is still running when it returns: removing the directory now
  // would pull it out from under the test.
  if (result instanceof Promise) return result.finally(remove) as T;
  remove();
  return result;
}

/**
 * Temp directories for a test file that needs one per case. Pass `removeAll`
 * to `afterEach`, and a failing assertion still leaves nothing behind.
 */
export function tempDirs(prefix: string): { make(): string; removeAll(): void } {
  const made: string[] = [];
  return {
    make: () => {
      const dir = makeTempDir(prefix);
      made.push(dir);
      return dir;
    },
    removeAll: () => {
      for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Write these files under `dir`, creating the directories they need. */
export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
}

/** A throwaway copy of a project on disk, for the tests that run the binary. */
export function inProject<T>(prefix: string, files: Record<string, string>, body: (dir: string) => T): T {
  return withTempDir(prefix, dir => {
    writeFiles(dir, files);
    return body(dir);
  });
}

export interface CliRun {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the built binary in this directory.
 *
 * The timeout exists because a wedged binary blocks the worker synchronously —
 * vitest's own timeout cannot interrupt spawnSync — and should fail the one
 * test that spawned it, with a story. The buffer is raised because a report
 * past spawnSync's 1 MB default would truncate into a confusing assertion
 * failure. A spawn that never finished throws here, centrally, instead of
 * surfacing as `status: -1` somewhere downstream.
 */
export function runCli(cwd: string, ...args: string[]): CliRun {
  const run = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error || run.status === null) {
    throw new Error(
      `norefs ${args.join(' ')} did not finish: ${run.error?.message ?? `killed by ${run.signal ?? 'a signal'}`}\n` +
        `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`
    );
  }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** A tsconfig that compiles every .ts file beside it — what most fixtures need. */
export const TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true },
  include: ['**/*.ts'],
});
