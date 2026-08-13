import fs from 'node:fs';
import path from 'node:path';
import type { Project } from 'ts-morph';
import { FileSystemRefreshResult } from 'ts-morph';

const DEBOUNCE_MS = 200;
const SKIP_DIRS = /(^|\/)(node_modules|\.git)(\/|$)/;

/**
 * Watch the tsconfig directories and keep the loaded project — the expensive
 * part of a run — in sync with the file system. After each batch of changes
 * that actually touches the project, call onChange so the caller re-analyzes.
 */
export function watchProject(project: Project, tsConfigFilePaths: string[], onChange: () => void): void {
  const dirs = [...new Set(tsConfigFilePaths.map(filePath => path.dirname(path.resolve(filePath))))];
  // Nested directories already get events from their ancestor's watcher.
  const roots = dirs.filter(dir => !dirs.some(other => other !== dir && dir.startsWith(`${other}/`)));

  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    const changed = [...pending];
    pending.clear();
    if (refreshProject(project, tsConfigFilePaths, changed)) onChange();
  };

  for (const dir of roots) {
    fs.watch(dir, { recursive: true }, (_event, fileName) => {
      if (!fileName) return;
      const filePath = path.join(dir, fileName);
      if (SKIP_DIRS.test(filePath)) return;
      pending.add(filePath);
      clearTimeout(timer);
      timer = setTimeout(flush, DEBOUNCE_MS);
    });
  }
}

/**
 * Bring the in-memory project up to date with a batch of changed paths:
 * refresh (or forget) the loaded files under them, then re-glob the tsconfigs
 * to pick up created files. A changed path can also be a directory — a rename
 * or delete fires one event for the directory, not its contents. Returns true
 * when anything the analysis reads actually changed.
 */
// norefs-ignore used in tests
export function refreshProject(project: Project, tsConfigFilePaths: string[], changedPaths: string[]): boolean {
  const manifestDirs = new Set(tsConfigFilePaths.map(filePath => path.dirname(path.resolve(filePath))));
  let dirty = changedPaths.some(
    filePath => path.basename(filePath) === 'package.json' && manifestDirs.has(path.dirname(filePath))
  );

  // Copy the list: refreshing a deleted file forgets it, mutating the project.
  for (const sourceFile of [...project.getSourceFiles()]) {
    const filePath = sourceFile.getFilePath();
    if (!changedPaths.some(changed => filePath === changed || filePath.startsWith(`${changed}/`))) continue;
    if (sourceFile.refreshFromFileSystemSync() !== FileSystemRefreshResult.NoChange) dirty = true;
  }

  const countBefore = project.getSourceFiles().length;
  for (const tsConfigFilePath of tsConfigFilePaths) {
    project.addSourceFilesFromTsConfig(tsConfigFilePath);
  }
  return dirty || project.getSourceFiles().length > countBefore;
}
