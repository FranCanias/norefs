import path from 'node:path';
import type { ts } from 'ts-morph';
import type { DependencyUse } from './dependencies';
import type { ReadOnlyFileSystem } from './file-system';
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
 * directory nobody compiles, the other packages of the same workspace. Those
 * files still import the project and the program cannot see a line of them —
 * so an export a sibling test imports reads as private, and a package only
 * `lib/*.js` loads reads as dead. Both are stated in absolute terms, and both
 * are wrong by exactly the width of the exclusion.
 *
 * So the text is read where the program will not go. A scan of the files
 * beside it answers three questions and no others: which project files they
 * import, which names they take, and which packages they name. It never
 * reports a finding of its own — nothing in these files was analyzed, and a
 * finding about code nobody looked at is a guess.
 */

/** What some set of files beside the program takes from it. */
export interface OutsideReach {
  /** Project files something outside the program imports. */
  targets: ReadonlySet<string>;
  /** The names taken from a project file; `*` stands for the whole module. */
  names: ReadonlyMap<string, ReadonlySet<string>>;
}

interface OutsideImports {
  /** Every file beside the program, the excluded tests among them. */
  all: OutsideReach;
  /**
   * The subset that is not a harness file.
   *
   * A test the tsconfig excluded is still a test, and where a file sits
   * decides nothing about what it is. Keeping the two apart is what lets an
   * export only an excluded test imports read as `test-only` rather than as
   * plainly used — the same answer the run gives when the test is inside the
   * program, so the config stops deciding the verdict.
   */
  shipped: OutsideReach;
  /** Every package the outside files name, as dependency uses. */
  uses: DependencyUse[];
}

const NOTHING: OutsideImports = {
  all: { targets: new Set(), names: new Map() },
  shipped: { targets: new Set(), names: new Map() },
  uses: [],
};

/** What a scanner can read: TypeScript and JavaScript, in every extension either is written with. */
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

/**
 * Manifest fields that name where a build lands.
 *
 * `bin` and `types` are left out on purpose. Both name a checked-in file as
 * often as a generated one — a launcher script committed under `bin/`, a
 * hand-written `.d.ts` whose implementation is JavaScript — and a build that
 * emits either of those emits its modules beside them, so the fields here
 * already name the directory.
 */
const BUILD_FIELDS = ['main', 'module', 'browser', 'exports', 'unpkg'];

interface OutsideOptions {
  rootDirs: string[];
  /**
   * Packages of the same workspace the run was not pointed at.
   *
   * They are read for what they take from this program and for nothing else.
   * A sibling package importing `lodash` says nothing about this package's
   * manifest, and a manifest claim built on a file nobody analyzed, in a
   * package nobody asked about, would be two guesses deep.
   */
  siblingDirs?: string[] | undefined;
  /**
   * Every package whose manifest the run answers for, the roots included. A
   * workspace package under a root tsconfig names its build in its own
   * manifest, and that directory is left out of the reading the same way.
   */
  packageDirs?: string[] | undefined;
  packages: PackageConfig[];
  fallbackOptions: ts.CompilerOptions;
  /**
   * The files the run reads its own inputs through. An in-memory project
   * carries an in-memory filesystem, and walking it finds exactly the files
   * that project holds — so a project built for a test has nothing beside it
   * by construction, with no guard to get wrong.
   */
  fileSystem: ReadOnlyFileSystem;
}

/**
 * Read every source file under the roots, and under the workspace packages
 * beside them, that the program does not hold.
 *
 * Build output is left out — a compiled copy is the same code twice, and
 * counting it would let yesterday's build keep today's dead code alive. So are
 * `node_modules` and the dot-directories, which belong to tools rather than to
 * the project.
 */
export function readOutside(seen: ReadonlySet<string>, options: OutsideOptions): OutsideImports {
  const siblingDirs = (options.siblingDirs ?? []).map(slashed);
  const { own, siblings } = outsideFiles(seen, options, siblingDirs);
  const filePaths = [...own, ...siblings];
  if (filePaths.length === 0) return NOTHING;

  const index = new SourceIndex(filePaths, options.packages, options.fallbackOptions, seen);
  const all = { targets: new Set<string>(), names: new Map<string, Set<string>>() };
  const shipped = { targets: new Set<string>(), names: new Map<string, Set<string>>() };
  const uses: DependencyUse[] = [];
  const harnessDirs = [...options.rootDirs, ...siblingDirs];
  const ownFiles = new Set(own);
  for (const filePath of filePaths) {
    const harness = isHarnessFile(filePath, harnessDirs);
    const mine = ownFiles.has(filePath);
    for (const entry of index.importsOf(filePath)) {
      const { specifier, target } = entry;
      if (target) {
        credit(all, target, specifier.names);
        if (!harness) credit(shipped, target, specifier.names);
      }
      if (!mine) continue;
      uses.push({
        filePath,
        text: specifier.text,
        start: specifier.start,
        typeOnly: specifier.typeOnly,
        internal: entry.resolved && !entry.external,
        outside: true,
      });
    }
    if (!mine) continue;
    for (const reference of index.namedInCommentsOf(filePath)) {
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
  return { all, shipped, uses };
}

function credit(
  reach: { targets: Set<string>; names: Map<string, Set<string>> },
  target: string,
  names: string[]
): void {
  reach.targets.add(target);
  const taken = reach.names.get(target) ?? new Set<string>();
  for (const name of names) taken.add(name);
  reach.names.set(target, taken);
}

/** True when a name this file exports is taken by a file outside the program. */
export function takenOutside(names: ReadonlySet<string> | undefined, name: string): boolean {
  return names !== undefined && (names.has(name) || names.has(WHOLE_MODULE));
}

/**
 * Paths are compared against the ones the program holds, and those are always
 * written with forward slashes — the compiler's own spelling, whatever the
 * platform separator is. A path built here has to be spelled the same way, or
 * on Windows every file the program holds would read as a file beside it.
 */
function slashed(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function outsideFiles(
  seen: ReadonlySet<string>,
  options: OutsideOptions,
  siblingDirs: string[]
): { own: string[]; siblings: string[] } {
  const roots = options.rootDirs
    .map(slashed)
    // A run pointed at the filesystem root is a run with no root at all: the
    // common directory of nothing. Walking from there would read the disk.
    .filter(root => path.dirname(root) !== root);
  const output = new Set<string>();
  for (const { dir, options: compiler } of options.packages) {
    for (const written of [compiler.outDir, compiler.declarationDir]) {
      if (written !== undefined) output.add(slashed(path.resolve(dir, written)));
    }
    for (const built of builtDirectories(slashed(dir), seen, roots, options.fileSystem)) output.add(built);
  }
  for (const dir of options.packageDirs ?? []) {
    for (const built of builtDirectories(slashed(dir), seen, roots, options.fileSystem)) output.add(built);
  }

  const walked = new Set<string>();
  const own = new Set<string>();
  for (const root of roots) walk(root, seen, output, walked, own, options.fileSystem);
  const siblings = new Set<string>();
  for (const dir of siblingDirs) {
    // The sibling's own directory stands in for a root here: the program
    // holds none of its files, so nothing else would stop `"main": "index.js"`
    // from skipping the whole package.
    for (const built of builtDirectories(dir, seen, [...roots, dir], options.fileSystem)) output.add(built);
    walk(dir, seen, output, walked, siblings, options.fileSystem);
  }
  const sorted = (paths: Set<string>): string[] => [...paths].sort((a, b) => a.localeCompare(b));
  return { own: sorted(own), siblings: sorted(siblings) };
}

/**
 * The directories this package's manifest says its build lands in.
 *
 * A `tsc` build names its output in the tsconfig, and that is already skipped.
 * A bundler's is named nowhere the compiler reads — `"main": "dist/index.js"`
 * is the only place tsup, rollup or vite say where the file goes. Left in the
 * walk, yesterday's bundle imports every package today's sources dropped, and
 * the dependency check reads a stale copy as a live one.
 *
 * Two things keep a source directory out of this. A directory holding a file
 * the program holds is source by demonstration, whatever the manifest calls
 * it — `"source": "src/index.ts"` is a real field, and `"main": "index.js"`
 * beside the sources names the package root. And a directory the run was
 * pointed at is never output, which is the answer when the program holds no
 * files at all and the first test can prove nothing.
 */
function builtDirectories(
  packageDir: string,
  seen: ReadonlySet<string>,
  roots: string[],
  fileSystem: ReadOnlyFileSystem
): string[] {
  const text = fileSystem.readFile(`${packageDir}/package.json`);
  if (text === undefined) return [];
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof manifest !== 'object' || manifest === null) return [];
  const written = new Set<string>();
  for (const field of BUILD_FIELDS) collectStrings((manifest as Record<string, unknown>)[field], written);

  const found: string[] = [];
  for (const candidate of written) {
    // Every one of these fields holds a path into the package, written with
    // or without the leading `./`. An absolute one names a place no build
    // writes to and no walk starts from.
    if (path.isAbsolute(candidate)) continue;
    const dir = slashed(path.dirname(path.resolve(packageDir, candidate)));
    if (roots.some(root => root === dir || root.startsWith(`${dir}/`))) continue;
    if (holdsSeenFile(dir, seen)) continue;
    found.push(dir);
  }
  return found;
}

function collectStrings(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') out.add(value);
  else if (typeof value === 'object' && value !== null)
    for (const nested of Object.values(value)) collectStrings(nested, out);
}

function holdsSeenFile(dir: string, seen: ReadonlySet<string>): boolean {
  const prefix = `${dir}/`;
  for (const filePath of seen) {
    if (filePath.startsWith(prefix)) return true;
  }
  return false;
}

function walk(
  dir: string,
  seen: ReadonlySet<string>,
  output: Set<string>,
  walked: Set<string>,
  found: Set<string>,
  fileSystem: ReadOnlyFileSystem
): void {
  if (walked.has(dir) || output.has(dir)) return;
  walked.add(dir);
  for (const entry of fileSystem.readDir(dir)) {
    const filePath = slashed(entry.path);
    const name = path.posix.basename(filePath);
    if (name.startsWith('.') || name === 'node_modules') continue;
    // A symbolic link is neither a file nor a directory here: following one
    // reads the same tree twice, or forever.
    if (entry.isSymlink) continue;
    if (entry.isDirectory) walk(filePath, seen, output, walked, found, fileSystem);
    else if (SOURCE_FILE.test(name) && !seen.has(filePath)) found.add(filePath);
  }
}
