import fs from 'node:fs';
import path from 'node:path';

/**
 * The little of a filesystem the readers need, so the in-memory one the tests
 * drive and the real one on disk both fit. Neither reader builds a program, and
 * a missing path is an answer rather than a throw.
 */
export interface ReadOnlyFileSystem {
  readFile(filePath: string): string | undefined;
  readDir(dirPath: string): Array<{ path: string; isDirectory: boolean }>;
}

/** Real files on disk, for the syntax-only run that never builds a program. */
export const diskFileSystem: ReadOnlyFileSystem = {
  readFile(filePath) {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return undefined;
    }
  },
  readDir(dirPath) {
    try {
      return fs
        .readdirSync(dirPath, { withFileTypes: true })
        .map(entry => ({ path: path.join(dirPath, entry.name), isDirectory: entry.isDirectory() }));
    } catch {
      return [];
    }
  },
};

/**
 * A loaded project's filesystem, which the tests drive in memory. Structural,
 * so this file needs no ts-morph import to describe it.
 */
export function hostFileSystem(host: {
  readFileSync(filePath: string): string;
  readDirSync(dirPath: string): Array<{ name: string; isDirectory: boolean }>;
}): ReadOnlyFileSystem {
  return {
    readFile(filePath) {
      try {
        return host.readFileSync(filePath);
      } catch {
        return undefined;
      }
    },
    readDir(dirPath) {
      try {
        return host.readDirSync(dirPath).map(entry => ({ path: entry.name, isDirectory: entry.isDirectory }));
      } catch {
        return [];
      }
    },
  };
}
