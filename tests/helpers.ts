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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

/** Run the built binary in this directory. */
export function runCli(cwd: string, ...args: string[]): CliRun {
  const run = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
}

/** Build the binary the CLI tests spawn. */
export function buildCli(): void {
  const build = spawnSync('npm', ['run', 'build'], { cwd: root, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`build failed: ${build.stderr}`);
}

/** A tsconfig that compiles every .ts file beside it — what most fixtures need. */
export const TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true },
  include: ['**/*.ts'],
});
