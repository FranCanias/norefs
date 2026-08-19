import path from 'node:path';
import { isToolConfig } from './tool-configs';

/** Default entry files, following the convention knip uses: index/main/cli in the root or src/. */
const ENTRY_NAME = /^(index|main|cli)\.[cm]?[jt]sx?$/;
/** Files a harness runs directly; they import code but nothing imports them. */
const HARNESS_NAME = /\.(test|spec|stories|bench)\.[cm]?[jt]sx?$/;
const HARNESS_DIRS = new Set(['test', 'tests', '__tests__', '__mocks__']);

export function isEntryFile(filePath: string, rootDirs: string[], entries: string[]): boolean {
  if (entries.some(entry => filePath === entry || filePath.startsWith(`${entry}/`))) return true;
  if (!ENTRY_NAME.test(path.basename(filePath))) return false;
  const dir = path.dirname(filePath);
  return rootDirs.some(root => dir === root || dir === path.join(root, 'src'));
}

/**
 * A file the build or the test run reads, never the product: a test, a spec, a
 * story, a bench, or a tool's configuration. The config half is shared with the
 * entry-point reader, so a second target's config — `vite.config.server.ts` —
 * counts as one everywhere. It used to count nowhere, which made every package
 * that config imported look like something the product needs at run time.
 */
export function isHarnessFile(filePath: string, rootDirs: string[]): boolean {
  const name = path.basename(filePath);
  if (HARNESS_NAME.test(name) || isToolConfig(filePath, rootDirs)) return true;
  return rootDirs.some(root =>
    path
      .relative(root, path.dirname(filePath))
      .split(path.sep)
      .some(segment => HARNESS_DIRS.has(segment))
  );
}

/**
 * Files reachable through imports from any root: entry files, harness files,
 * and files suppressed with norefs-ignore-file (keeping a file means keeping
 * what it imports). Counting reachability instead of direct importers catches
 * dead clusters, like two unused files that import each other.
 */
export function reachableFiles<File>(
  files: File[],
  isRoot: (file: File) => boolean,
  importsOf: (file: File) => Iterable<File>
): Set<File> {
  const queue = files.filter(isRoot);
  const reachable = new Set<File>(queue);
  for (let head = 0; head < queue.length; head++) {
    for (const target of importsOf(queue[head]!)) {
      if (reachable.has(target)) continue;
      reachable.add(target);
      queue.push(target);
    }
  }
  return reachable;
}

/** The deepest directory holding every one of these files. */
export function commonDirectory(filePaths: string[]): string {
  const [first] = filePaths;
  if (first === undefined) return '/';
  let prefix = path.dirname(first).split('/');
  for (const filePath of filePaths.slice(1)) {
    const segments = path.dirname(filePath).split('/');
    let i = 0;
    while (i < prefix.length && i < segments.length && prefix[i] === segments[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix.join('/') || '/';
}
