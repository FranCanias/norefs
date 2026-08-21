import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliRun } from './helpers';
import { inProject, root, runCli } from './helpers';

/**
 * The release probe, part two: the settings a project decides once, the
 * production lens, and the package.json a run can fix — split from
 * smoke.test.ts so vitest runs the halves in parallel workers.
 */
const repo = path.join(root, 'tests', 'exhibit-repo');
const tsconfig = path.relative(root, path.join(repo, 'tsconfig.json'));

function norefs(...args: string[]) {
  return runCli(root, '-p', tsconfig, ...args);
}

describe('the settings a project decides once', () => {
  const PROJECT: Record<string, string> = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true },
      include: ['**/*.ts'],
    }),
    // A named dead member (`dropped`) and an unnamed one (`value`) nested under
    // a property something reads, so --anon has something to add.
    'src/lib.ts': [
      'export type Props = {',
      '  target: { value: string; label: string };',
      '  keep: string;',
      '  dropped: string;',
      '};',
      'export const helper = (p: Props): string => p.keep + p.target.label;',
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
    return inProject('norefs-config-run-', PROJECT, dir => {
      fs.writeFileSync(path.join(dir, 'norefs.config.json'), JSON.stringify(config, null, 2));
      return runCli(dir, ...args);
    });
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
    return inProject('norefs-production-', PROD, dir => {
      fs.writeFileSync(path.join(dir, 'norefs.config.json'), JSON.stringify(config));
      return runCli(dir, ...args);
    });
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

  /** Run in a throwaway copy, and hand the run and the directory to the body. */
  function deps<T>(args: string[], body: (run: CliRun, dir: string) => T): T {
    return inProject('norefs-deps-', DEPS, dir => body(runCli(dir, ...args), dir));
  }

  it('reads the scripts, so a tool nothing imports is not called dead', () => {
    deps(['--only', 'dependencies,misplaced'], run => {
      // `tsc` is typescript, and the build script has always said so.
      expect(run.stdout).not.toContain('typescript');
      expect(run.stdout).toContain('dead dependency `left-pad`');
      expect(run.stdout).toContain('`runtime` is in devDependencies');
      expect(run.stdout).toContain('`only-in-tests` is in dependencies');
    });
  });

  it('leaves package.json alone under --fix, and says why', () => {
    deps(['--fix', '--allow-dirty'], (run, dir) => {
      expect(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe(DEPS['package.json']);
      expect(run.stderr).toContain('package.json findings need --fix-unsafe');
    });
  });

  it('retires and relocates entries under --fix-unsafe, leaving valid JSON', () => {
    deps(['--fix-unsafe', '--allow-dirty'], (run, dir) => {
      const after = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      expect(after.dependencies).toEqual({ runtime: '1.0.0' });
      expect(after.devDependencies).toEqual({ 'only-in-tests': '1.0.0', typescript: '5.0.0' });
      // The rest of the file is untouched, formatting included.
      expect(after.scripts).toEqual({ build: 'tsc -p tsconfig.json' });
      // No probe reads a manifest, and the run says so rather than implying cover.
      expect(run.stderr).toContain('A type check cannot see');
      expect(run.stderr).toContain('a package.json edit');
    });
  });

  it('holds the manifest edits back when the command you supplied rejects them', () => {
    // The type check never reads package.json, so --verify-command is the only
    // probe that can judge these — and it gets the last word, on its own.
    deps(['--fix-unsafe', '--allow-dirty', '--verify-command', 'grep -q left-pad package.json'], (run, dir) => {
      expect(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe(DEPS['package.json']);
      expect(run.stderr).toContain('Held back the package.json edits');
      // The source fixes it verified are still applied: the two are separable.
      expect(fs.readFileSync(path.join(dir, 'src/app.test.ts'), 'utf8')).not.toContain('export const t');
    });
  });
});
