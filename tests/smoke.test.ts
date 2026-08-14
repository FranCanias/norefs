import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The release probe. Every other test calls the engine; this one runs the
 * binary a user installs, against a repository that holds the exhibits five
 * reviews have raised — the colour chain, the IPC bridge, the imperative
 * handle. 0.4.0 shipped a headline feature that had never completed a run
 * against the example in its own release notes. This is the run.
 */
const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'dist', 'index.js');
const repo = path.join(root, 'tests', 'exhibit-repo');
const tsconfig = path.relative(root, path.join(repo, 'tsconfig.json'));

function norefs(...args: string[]): { status: number; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [cli, '-p', tsconfig, ...args], { cwd: root, encoding: 'utf8' });
  return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
}

/** One hash over the fixture tree, so a run that promised to write nothing can be held to it. */
function treeHash(): string {
  const hash = createHash('sha256');
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else hash.update(full).update(fs.readFileSync(full));
    }
  };
  walk(repo);
  return hash.digest('hex');
}

beforeAll(() => {
  const build = spawnSync('npm', ['run', 'build'], { cwd: root, encoding: 'utf8' });
  expect(build.status, build.stderr).toBe(0);
}, 60_000);

describe('the binary, on the exhibit repository', () => {
  it('reports the exhibits and exits 1, as the flag reference says', () => {
    const run = norefs();
    expect(run.status).toBe(1);
    expect(run.stderr).not.toContain('at Object.');
    // The colour chain: three proven writes, each named with its own site.
    expect(run.stdout).toContain('write-only property `canvas`');
    expect(run.stdout).toContain('proven, never read');
    // The imperative handle: the write cannot be this owner's shape, so the
    // sibling is not protected by it.
    expect(run.stdout).toContain('dead property `reset`');
    // The IPC bridge: the over-exported class strands nothing, the dead
    // method strands its own handler — and the handler is named, once.
    expect(run.stdout).toContain('over-exported: `RecipeBoxService`');
    expect(run.stdout).not.toContain("'recipeBox:saveRecipe'");
    expect(run.stdout).toContain("stranded handler for `'recipeBox:oldRecipe'`");
    expect(run.stdout).toContain('`oldRecipe` at tests/exhibit-repo/src/service.ts:10');
  });

  it('completes --fix-unsafe --dry-run and writes nothing', () => {
    const before = treeHash();
    const run = norefs('--fix-unsafe', '--dry-run');
    expect(run.status).toBe(1);
    // No stack trace, no half-finished campaign: the whole feature runs.
    expect(run.stderr).not.toContain('ManipulationError');
    expect(run.stderr).not.toContain('Manipulation error');
    expect(run.stderr).not.toMatch(/^\s+at /m);
    expect(run.stderr).toContain('Dry run: would fix 6 finding(s) in 3 file(s)');
    expect(run.stderr).toContain('Verified: tsc reports no new errors');
    // Each comment leaves with the property it described, and none of them
    // lands on a line it never described.
    expect(run.stdout).toContain('-      canvas, // light: #F9F9FA, dark: #242424');
    expect(run.stdout).toContain('-      // Grid - more visible in dark');
    expect(run.stdout).toContain('-    [canvas, grid, curve]');
    expect(run.stdout).toContain('+    []');
    expect(run.stdout).not.toMatch(/^\+.*#F9F9FA/m);
    expect(treeHash()).toBe(before);
  });

  it('exits 0 with no findings and 2 on a usage error', () => {
    expect(norefs('--only', 'unlisted').status).toBe(0);
    expect(norefs('--dry-run').status).toBe(2);
    expect(norefs('bogus').status).toBe(2);
  });

  it('shows its entry points and what named each one', () => {
    // An entry point silently makes a file used and its exports public API.
    // The audit for that has to work in the binary a user installs.
    const run = norefs('entries');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('tests/exhibit-repo/src/index.ts  —  index/main/cli beside a tsconfig');
    expect(run.stderr).toContain('1 entry point(s)');
  });
});

describe('the settings a project decides once', () => {
  const PROJECT: Record<string, string> = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true },
      include: ['**/*.ts'],
    }),
    // A named dead member with two unnamed ones nested under it, so --anon has
    // something to add.
    'src/lib.ts': [
      'export type Props = {',
      '  target: { value: string; label: string };',
      '  keep: string;',
      '};',
      'export const helper = (p: Props): string => p.keep;',
      '',
    ].join('\n'),
    'src/other.ts': [
      'export interface Other {',
      '  used: string;',
      '  unused: string;',
      '}',
      'export const other = (o: Other): string => o.used;',
      '',
    ].join('\n'),
    'src/index.ts': [
      "import { helper, type Props } from './lib';",
      "import { other, type Other } from './other';",
      'declare const p: Props;',
      'declare const o: Other;',
      'export const run = (): string => helper(p) + other(o);',
      '',
    ].join('\n'),
  };

  /** A throwaway project with a config file beside its tsconfig. */
  function configured(config: Record<string, unknown>, ...args: string[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'norefs-config-run-'));
    try {
      for (const [name, text] of Object.entries(PROJECT)) {
        fs.mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), text);
      }
      fs.writeFileSync(path.join(dir, 'norefs.config.json'), JSON.stringify(config, null, 2));
      const run = spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });
      return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('reads scope from the config file', () => {
    const run = configured({ scope: 'src/other.ts' });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('src/other.ts');
    expect(run.stdout).not.toContain('src/lib.ts');
  });

  it('reads reporter from the config file', () => {
    const run = configured({ reporter: 'github' });
    expect(run.stdout).toContain('::error file=src/lib.ts');
    // Not the text report's "line:column  claim" lines.
    expect(run.stdout).not.toMatch(/^ {2}\d+:\d+ {2}/m);
  });

  it('reads explain and anon from the config file', () => {
    const chain = 'no references anywhere';
    expect(configured({}).stdout).not.toContain(chain);
    expect(configured({ explain: true }).stdout).toContain(chain);

    expect(configured({}).stdout).not.toContain('`value`');
    expect(configured({ anon: true }).stdout).toContain('`value`');
  });

  it('lets a flag passed on the run win over the config', () => {
    const run = configured({ reporter: 'github' }, '--reporter', 'json');
    expect(run.stdout.trimStart().startsWith('[')).toBe(true);
    expect(run.stdout).not.toContain('::error');
  });

  it('lets --no-explain and --no-anon turn a config setting back off', () => {
    // The reason neither flag carries a default: a run has to be able to say
    // no to a project that said yes.
    expect(configured({ explain: true }, '--no-explain').stdout).not.toContain('no references anywhere');
    expect(configured({ anon: true }, '--no-anon').stdout).not.toContain('`value`');
  });

  it('names the config file when the reporter in it is not a real one', () => {
    const run = configured({ reporter: 'jsonl' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('"reporter" in norefs.config.json must be one of');
    // And names the flag when the flag is what carried it.
    expect(norefs('--reporter', 'jsonl').stderr).toContain('--reporter must be one of');
  });

  it('refuses an action in the config file', () => {
    // --fix, --baseline, --dry-run, --watch and --export each write something.
    // They belong to a run, not to the project.
    for (const action of ['fix', 'baseline', 'dry-run', 'watch', 'export']) {
      const run = configured({ [action]: true });
      expect(run.status, action).toBe(2);
      expect(run.stderr, action).toContain(`unknown key "${action}"`);
    }
  });
});

describe('the shipping code path alone', () => {
  const PROD: Record<string, string> = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true },
      include: ['**/*.ts'],
    }),
    'src/index.ts': "import { ship } from './lib';\nexport const boot = (): string => ship();\n",
    'src/lib.ts': [
      "export const ship = (): string => 'ok';",
      'export const helperForTests = (): string => ship();',
      '',
    ].join('\n'),
    'src/fixtures.ts': "export const sample = 'a';\n",
    'tests/lib.test.ts': [
      "import { helperForTests } from '../src/lib';",
      "import { sample } from '../src/fixtures';",
      'export const check = (): string => helperForTests() + sample;',
      '',
    ].join('\n'),
  };

  function prod(config: Record<string, unknown>, ...args: string[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'norefs-production-'));
    try {
      for (const [name, text] of Object.entries(PROD)) {
        fs.mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), text);
      }
      fs.writeFileSync(path.join(dir, 'norefs.config.json'), JSON.stringify(config));
      const run = spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });
      return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('labels what the tests hold up, and --production stops counting them', () => {
    const normal = prod({});
    expect(normal.stdout).toContain('test-only export `helperForTests`');
    expect(normal.stdout).toContain('test-only export `sample`');

    const strict = prod({}, '--production');
    expect(strict.status).toBe(1);
    // The file only a test imports stops being reachable at all.
    expect(strict.stdout).toContain('src/fixtures.ts');
    expect(strict.stdout).toContain('dead file');
    expect(strict.stdout).toContain('dead export `helperForTests`');
    expect(strict.stdout).not.toContain('test-only');
    // And the test file itself reports nothing, because it is not there.
    expect(strict.stdout).not.toContain('tests/lib.test.ts');
  });

  it('reads production from the config file, and --no-production says no to it', () => {
    expect(prod({ production: true }).stdout).not.toContain('test-only');
    expect(prod({ production: true }, '--no-production').stdout).toContain('test-only');
  });

  it('refuses --production with --fix', () => {
    // Its findings are dead to production and may be alive in the tests this
    // run never looked at. Deleting them breaks those tests.
    const run = prod({}, '--production', '--fix', '--allow-dirty');
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('--production cannot combine with --fix');
    // The config key reaches the same guard.
    expect(prod({ production: true }, '--fix', '--allow-dirty').status).toBe(2);
  });
});

describe('the package.json a run can fix', () => {
  /** A project whose installed packages declare their own binaries. */
  const DEPS: Record<string, string> = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true },
      include: ['**/*.ts'],
    }),
    'package.json': `${JSON.stringify(
      {
        name: 'demo',
        scripts: { build: 'tsc -p tsconfig.json' },
        dependencies: { 'only-in-tests': '1.0.0' },
        devDependencies: { 'left-pad': '1.3.0', runtime: '1.0.0', typescript: '5.0.0' },
      },
      null,
      2
    )}\n`,
    'node_modules/typescript/package.json': '{"name":"typescript","bin":{"tsc":"./bin/tsc"}}',
    'node_modules/left-pad/package.json': '{"name":"left-pad"}',
    'node_modules/runtime/package.json': '{"name":"runtime"}',
    'node_modules/only-in-tests/package.json': '{"name":"only-in-tests"}',
    'src/shims.d.ts': "declare module 'runtime';\ndeclare module 'only-in-tests';\n",
    'src/index.ts': "import 'runtime';\nexport const boot = 1;\n",
    'src/app.test.ts': "import 'only-in-tests';\nexport const t = 1;\n",
  };

  function deps(...args: string[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'norefs-deps-'));
    for (const [name, text] of Object.entries(DEPS)) {
      fs.mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), text);
    }
    const run = spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });
    return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr, dir };
  }

  it('reads the scripts, so a tool nothing imports is not called dead', () => {
    const run = deps('--only', 'dependencies,misplaced');
    // `tsc` is typescript, and the build script has always said so.
    expect(run.stdout).not.toContain('typescript');
    expect(run.stdout).toContain('dead dependency `left-pad`');
    expect(run.stdout).toContain('`runtime` is in devDependencies');
    expect(run.stdout).toContain('`only-in-tests` is in dependencies');
    fs.rmSync(run.dir, { recursive: true, force: true });
  });

  it('leaves package.json alone under --fix, and says why', () => {
    const run = deps('--fix', '--allow-dirty');
    expect(fs.readFileSync(path.join(run.dir, 'package.json'), 'utf8')).toBe(DEPS['package.json']);
    expect(run.stderr).toContain('package.json findings need --fix-unsafe');
    fs.rmSync(run.dir, { recursive: true, force: true });
  });

  it('retires and relocates entries under --fix-unsafe, leaving valid JSON', () => {
    const run = deps('--fix-unsafe', '--allow-dirty');
    const after = JSON.parse(fs.readFileSync(path.join(run.dir, 'package.json'), 'utf8'));
    expect(after.dependencies).toEqual({ runtime: '1.0.0' });
    expect(after.devDependencies).toEqual({ 'only-in-tests': '1.0.0', typescript: '5.0.0' });
    // The rest of the file is untouched, formatting included.
    expect(after.scripts).toEqual({ build: 'tsc -p tsconfig.json' });
    // No probe reads a manifest, and the run says so rather than implying cover.
    expect(run.stderr).toContain('A type check cannot see');
    expect(run.stderr).toContain('a package.json edit');
    fs.rmSync(run.dir, { recursive: true, force: true });
  });

  it('holds the manifest edits back when the command you supplied rejects them', () => {
    // The type check never reads package.json, so --verify-command is the only
    // probe that can judge these — and it gets the last word, on its own.
    const run = deps('--fix-unsafe', '--allow-dirty', '--verify-command', 'grep -q left-pad package.json');
    expect(fs.readFileSync(path.join(run.dir, 'package.json'), 'utf8')).toBe(DEPS['package.json']);
    expect(run.stderr).toContain('Held back the package.json edits');
    // The source fixes it verified are still applied: the two are separable.
    expect(fs.readFileSync(path.join(run.dir, 'src/app.test.ts'), 'utf8')).not.toContain('export const t');
    fs.rmSync(run.dir, { recursive: true, force: true });
  });
});

describe('a monorepo that declares its own packages', () => {
  const workspace = path.join(root, 'tests', 'workspace-fixtures');

  function inWorkspace(...args: string[]) {
    const run = spawnSync(process.execPath, [cli, ...args], { cwd: workspace, encoding: 'utf8' });
    return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
  }

  it('analyzes every declared package with no --project flags at all', () => {
    const run = inWorkspace();
    expect(run.status).toBe(1);
    // Which packages a run covers decides what its findings mean, so it says.
    expect(run.stderr).toContain('2 workspace package(s) from pnpm-workspace.yaml');
    expect(run.stderr).toContain('skipped tools/jsonly — no tsconfig.json');
    expect(run.stdout).toContain('apps/web/src/orphan.ts');
    expect(run.stdout).toContain('packages/core/src/orphan.ts');
    // `!packages/legacy` is excluded, so nothing in it is analyzed at all.
    expect(run.stdout).not.toContain('packages/legacy');
    expect(run.stderr).not.toMatch(/^\s+at /m);
  });

  it('lets an explicit --project win over the declaration', () => {
    const run = inWorkspace('-p', 'packages/core/tsconfig.json');
    expect(run.stderr).not.toContain('workspace package(s)');
    expect(run.stdout).toContain('packages/core/src/orphan.ts');
    expect(run.stdout).not.toContain('apps/web');
  });

  it('reports a missing tsconfig as a usage error, not a stack trace', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'norefs-no-tsconfig-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"solo"}');
      const run = spawnSync(process.execPath, [cli], { cwd: dir, encoding: 'utf8' });
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('error: no tsconfig at tsconfig.json');
      expect(run.stderr).not.toMatch(/^\s+at /m);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a boundary the project declares', () => {
  /** A REST project: a client that fetches, a route table nothing exports from. */
  const REST: Record<string, string> = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true },
      include: ['**/*.ts'],
    }),
    'src/server.d.ts': [
      'interface Router {',
      '  get(path: string, handler: () => void): void;',
      '}',
      'declare const app: Router;',
      'declare function fetch(input: string): Promise<unknown>;',
      '',
    ].join('\n'),
    'src/routes.ts': ["app.get('/api/recipes', () => {});", "app.get('/api/recipes/:id/audit', () => {});", ''].join(
      '\n'
    ),
    'src/client.ts': [
      'export class ApiClient {',
      '  live(): Promise<unknown> {',
      "    return fetch('/api/recipes');",
      '  }',
      '  gone(): Promise<unknown> {',
      `    return fetch(\`/api/recipes/\${String(1)}/audit\`);`,
      '  }',
      '}',
      '',
    ].join('\n'),
    'src/index.ts': [
      "import './routes';",
      "import { ApiClient } from './client';",
      'export const boot = (): Promise<unknown> => new ApiClient().live();',
      '',
    ].join('\n'),
  };

  function rest(config: Record<string, unknown>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'norefs-boundary-'));
    try {
      for (const [name, text] of Object.entries(REST)) {
        fs.mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), text);
      }
      fs.writeFileSync(path.join(dir, 'norefs.config.json'), JSON.stringify(config));
      const run = spawnSync(process.execPath, [cli], { cwd: dir, encoding: 'utf8' });
      return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('pairs a dead sender with its route, and names the route as written', () => {
    const run = rest({ boundaries: [{ send: 'fetch', handle: 'app.get' }] });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('dead property `gone`');
    // The route the two sides agree on is matched with its `:id` cut out. The
    // report never shows that cut — a reader searches for what they wrote.
    expect(run.stdout).toContain("stranded handler for `'/api/recipes/:id/audit'`");
    // The live route keeps its handler: `live` still sends to it.
    expect(run.stdout).not.toContain("`'/api/recipes'`");
    // And a route file nothing exports from is not a dead file.
    expect(run.stdout).not.toContain('dead file');
  });

  it('pairs nothing without the declaration', () => {
    const run = rest({});
    expect(run.stdout).toContain('dead property `gone`');
    expect(run.stdout).not.toContain('stranded handler');
  });

  it('refuses a boundary missing a side', () => {
    // A boundary that pairs nothing is a config that looks like it works.
    const run = rest({ boundaries: [{ send: 'fetch' }] });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('"boundaries" must be an array of');
  });
});
