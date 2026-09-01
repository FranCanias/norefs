import fs from 'node:fs';
import path from 'node:path';
import type { ts } from 'ts-morph';
import type { DependencyUse } from './dependencies';
import type { PackageConfig } from './project';
import { isHarnessFile } from './reachability';
import { WHOLE_MODULE } from './scan';
import { SourceIndex } from './sources';

/**
 * What the code beside the program says.
 *
 * A tsconfig decides which files a run holds, and plenty of projects leave
 * real code out of it: an `exclude` that names the tests, a `files` list of
 * one declaration file whose implementation is JavaScript, a `scripts`
 * directory nobody compiles. Those files still import the project, and the program cannot see
 * a line of them — so an export a sibling test imports reads as private, and
 * a package only `lib/*.js` loads reads as dead. Both are stated in absolute
 * terms, and both are wrong by exactly the width of the exclusion.
 *
 * So the text is read where the program will not go. A scan of the files
 * beside it answers three questions and no others: which project files they
 * import, which names they take, and which packages they name. It never
 * reports a finding of its own — nothing in these files was analyzed, and a
 * finding about code nobody looked at is a guess.
 */
interface OutsideImports {
  /** Project files something outside the program imports. */
  targets: ReadonlySet<string>;
  /** The names taken from a project file; `*` stands for the whole module. */
  names: ReadonlyMap<string, ReadonlySet<string>>;
  /** Every package the outside files name, as dependency uses. */
  uses: DependencyUse[];
}

const NOTHING: OutsideImports = { targets: new Set(), names: new Map(), uses: [] };

/** What a scanner can read: TypeScript and JavaScript, in every extension either is written with. */
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

interface OutsideOptions {
  rootDirs: string[];
  packages: PackageConfig[];
  fallbackOptions: ts.CompilerOptions;
  /** The shipping code path alone: a test outside the program is as absent as one inside it. */
  production?: boolean | undefined;
}

/**
 * Read every source file under the roots that the program does not hold.
 *
 * Build output is left out — an `outDir` is the same code twice, and counting
 * it would let yesterday's build keep today's dead code alive. So are
 * `node_modules` and the dot-directories, which belong to tools rather than
 * to the project.
 */
export function readOutside(seen: ReadonlySet<string>, options: OutsideOptions): OutsideImports {
  // A project built in memory has nothing beside it: the paths in it name no
  // directory to read, and the roots would fall back to the real ones.
  if (!someExists(seen)) return NOTHING;

  const filePaths = outsideFiles(seen, options);
  if (filePaths.length === 0) return NOTHING;

  const index = new SourceIndex(filePaths, options.packages, options.fallbackOptions, seen);
  const targets = new Set<string>();
  const names = new Map<string, Set<string>>();
  const uses: DependencyUse[] = [];
  for (const filePath of filePaths) {
    // A harness file the program excluded is still a harness file, and a
    // production run treats it as absent wherever it sits.
    const absent = options.production === true && isHarnessFile(filePath, options.rootDirs);
    for (const entry of index.importsOf(filePath)) {
      const { specifier, target } = entry;
      if (target && !absent) {
        targets.add(target);
        const taken = names.get(target) ?? new Set<string>();
        for (const name of specifier.names) taken.add(name);
        names.set(target, taken);
      }
      uses.push({
        filePath,
        text: specifier.text,
        start: specifier.start,
        typeOnly: specifier.typeOnly,
        internal: entry.resolved && !entry.external,
        outside: true,
      });
    }
    for (const reference of index.typeReferencesOf(filePath)) {
      uses.push({
        filePath,
        text: reference.text,
        start: reference.start,
        typeOnly: true,
        internal: false,
        outside: true,
      });
    }
  }
  return { targets, names, uses };
}

/** True when a name this file exports is taken by a file outside the program. */
export function takenOutside(names: ReadonlySet<string> | undefined, name: string): boolean {
  return names !== undefined && (names.has(name) || names.has(WHOLE_MODULE));
}

function someExists(paths: ReadonlySet<string>): boolean {
  for (const filePath of paths) {
    if (fs.existsSync(filePath)) return true;
  }
  return false;
}

function outsideFiles(seen: ReadonlySet<string>, options: OutsideOptions): string[] {
  const output = new Set<string>();
  for (const { dir, options: compiler } of options.packages) {
    for (const written of [compiler.outDir, compiler.declarationDir]) {
      if (written !== undefined) output.add(path.resolve(dir, written));
    }
  }

  const found = new Set<string>();
  const walked = new Set<string>();
  for (const root of options.rootDirs) walk(root, seen, output, walked, found);
  return [...found].sort((a, b) => a.localeCompare(b));
}

function walk(
  dir: string,
  seen: ReadonlySet<string>,
  output: Set<string>,
  walked: Set<string>,
  found: Set<string>
): void {
  if (walked.has(dir) || output.has(dir)) return;
  walked.add(dir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const filePath = path.join(dir, entry.name);
    // A symbolic link is neither a file nor a directory here: following one
    // reads the same tree twice, or forever.
    if (entry.isDirectory()) walk(filePath, seen, output, walked, found);
    else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !seen.has(filePath)) found.add(filePath);
  }
}
