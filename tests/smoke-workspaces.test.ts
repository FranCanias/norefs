import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inProject, root, runCli, withTempDir, writeFiles } from './helpers';

/**
 * The release probe, part three: the two-target app that produced 0.6.0's
 * eight false positives, the self-declared monorepo, and a declared boundary —
 * split from smoke.test.ts so vitest runs the halves in parallel workers.
 */
describe('an app whose build has two targets', () => {
  /**
   * The repository shape that produced 0.6.0's false positives: a desktop app
   * with a headless server build. Its second bundler config, its aliases, an
   * ESLint config the compiler never reads, a coverage plugin behind a flag, a
   * socket extra behind its host, and a module the runtime provides. 0.6.0
   * reported ten findings here and eight of them were false: four dead files,
   * four dead dependencies, and a misplaced entry. Two are real — `orphan.ts`,
   * which nothing reaches, and the one dependency nothing anywhere uses.
   */
  const APP: Record<string, string> = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
        outDir: 'dist',
        rootDir: '.',
      },
      include: ['src/**/*', 'server/**/*', '*.config.ts'],
    }),
    'package.json': `${JSON.stringify(
      {
        name: 'recipe-box-app',
        private: true,
        main: 'dist/src/main.js',
        scripts: {
          dev: 'bundler',
          build: 'bundler build --config vite.config.server.ts',
          test: 'harness --coverage',
          lint: 'linter .',
        },
        dependencies: { sockets: '1.0.0' },
        devDependencies: {
          abandoned: '1.0.0',
          bundler: '1.0.0',
          'dom-shim': '1.0.0',
          harness: '1.0.0',
          'harness-coverage': '1.0.0',
          'host-shell': '1.0.0',
          linter: '1.0.0',
          'linter-plugin-pantry': '1.0.0',
          'socket-extra': '1.0.0',
        },
      },
      null,
      2
    )}\n`,
    'index.html': '<script type="module" src="/src/boot.tsx"></script>\n',
    // The alias targets are written the way imports are: no extension, and a
    // directory whose index is the module.
    'vite.config.ts': [
      "import { defineConfig } from 'bundler';",
      '',
      'export default defineConfig({',
      "  resolve: { alias: { '@/routes': './src/Routes.web', '@/api': './src/api' } },",
      '});',
      '',
    ].join('\n'),
    'vite.config.server.ts': [
      "import { defineConfig } from 'bundler';",
      '',
      "export default defineConfig({ build: { rollupOptions: { input: 'server/main.ts' } } });",
      '',
    ].join('\n'),
    'vitest.config.ts': "export default { test: { environment: 'dom-shim' } };\n",
    'eslint.config.js': "import pantry from 'linter-plugin-pantry';\n\nexport default [pantry.configs.strict];\n",
    'src/main.ts': "import { app } from 'host-shell';\n\nexport const start = (): unknown => app;\n",
    'src/boot.tsx': "export const boot = (): string => 'ready';\n",
    'src/Routes.web.tsx': "export const routes = ['/recipes'];\n",
    'src/api/index.ts': 'export const load = (): number => 1;\n',
    'server/main.ts': "import { serve } from 'sockets';\n\nexport const server = (): unknown => serve();\n",
    'src/orphan.ts': 'export const orphan = 1;\n',
    'node_modules/abandoned/package.json': '{"name":"abandoned"}',
    'node_modules/bundler/package.json': '{"name":"bundler","types":"index.d.ts","bin":{"bundler":"./cli.js"}}',
    'node_modules/bundler/index.d.ts': 'export declare function defineConfig(config: unknown): unknown;\n',
    'node_modules/dom-shim/package.json': '{"name":"dom-shim"}',
    'node_modules/harness/package.json':
      '{"name":"harness","bin":{"harness":"./cli.js"},"peerDependencies":{"harness-coverage":"1.0.0"},"peerDependenciesMeta":{"harness-coverage":{"optional":true}}}',
    'node_modules/harness-coverage/package.json': '{"name":"harness-coverage"}',
    'node_modules/host-shell/package.json': '{"name":"host-shell","main":"index.js","types":"shell.d.ts"}',
    'node_modules/host-shell/shell.d.ts': "declare module 'host-shell' {\n  export const app: unknown;\n}\n",
    'node_modules/linter/package.json': '{"name":"linter","bin":{"linter":"./cli.js"}}',
    'node_modules/linter-plugin-pantry/package.json': '{"name":"linter-plugin-pantry"}',
    'node_modules/sockets/package.json':
      '{"name":"sockets","types":"index.d.ts","peerDependencies":{"socket-extra":"1.0.0"},"peerDependenciesMeta":{"socket-extra":{"optional":true}}}',
    'node_modules/sockets/index.d.ts': 'export declare function serve(): unknown;\n',
    'node_modules/socket-extra/package.json': '{"name":"socket-extra"}',
  };

  function app(...args: string[]) {
    return inProject('norefs-app-', APP, dir => runCli(dir, ...args));
  }

  /** How many times a report says something. "And nothing else" is a count. */
  function count(text: string, pattern: RegExp): number {
    return text.match(pattern)?.length ?? 0;
  }

  it('finds every entry point its build declares, and says which file said so', () => {
    const run = app('entries');
    expect(run.stdout.trim().split('\n')).toEqual([
      'server/main.ts  —  a path named in vite.config.server.ts',
      'src/api/index.ts  —  a path named in vite.config.ts',
      'src/boot.tsx  —  <script src> in index.html',
      'src/main.ts  —  package.json main',
      'src/Routes.web.tsx  —  a path named in vite.config.ts',
    ]);
  });

  it('reports the one dead file and the one dead dependency, and nothing else', () => {
    // The syntax-only pipeline: what a CI gate runs.
    const run = app('--only', 'files,dependencies,unlisted,misplaced');
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('dead dependency `abandoned`');
    expect(run.stdout).toContain('src/orphan.ts');
    expect(run.stdout).toContain('dead file');
    // 0.6.0: "10 findings: 9 dead, 1 misplaced dependency", eight of them false.
    expect(run.stdout).toContain('2 findings: 2 dead');
  });

  it('agrees with itself when the type checker is loaded', () => {
    // The same repository, the other pipeline. It reads the same configs through
    // the project's own filesystem, so the two must not disagree about a
    // manifest — and every import has to resolve, or a reference is invisible.
    const run = app();
    expect(count(run.stdout, /dead dependency/g)).toBe(1);
    expect(run.stdout).toContain('dead dependency `abandoned`');
    expect(count(run.stdout, /is in dev|is in dependencies/g)).toBe(0);
    expect(count(run.stdout, /dead file/g)).toBe(1);
    expect(run.stdout).toContain('src/orphan.ts');
    expect(run.stderr).not.toContain('do not resolve');
  });
});

describe('a monorepo that declares its own packages', () => {
  const workspace = path.join(root, 'tests', 'workspace-fixtures');

  function inWorkspace(...args: string[]) {
    return runCli(workspace, ...args);
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

  it('analyzes the root too when the declaration lists only the packages under it', () => {
    // unplugin: `packages: [docs]`, and the library at the root under its own
    // tsconfig. The run said "1 workspace package(s)", warned that no entry
    // point resolved — in docs — and never named what it skipped.
    const files: Record<string, string> = {
      'pnpm-workspace.yaml': 'ignoreWorkspaceRootCheck: true\npackages:\n  - docs\n',
      'package.json': JSON.stringify({ name: 'pantry', main: 'src/index.ts' }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true }, include: ['src'] }),
      'src/index.ts': 'export const plate = 1;\n',
      'src/orphan.ts': 'export const orphan = 1;\n',
      'docs/package.json': JSON.stringify({ name: 'docs', private: true, main: 'src/site.ts' }),
      'docs/tsconfig.json': JSON.stringify({ compilerOptions: { strict: true }, include: ['src'] }),
      'docs/src/site.ts': 'export const site = 1;\n',
    };
    const run = inProject('norefs-workspace-root-', files, dir => runCli(dir));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      '1 workspace package(s) from pnpm-workspace.yaml, plus the root, whose tsconfig.json holds files of its own'
    );
    expect(run.stdout).toContain('src/orphan.ts');

    // A root tsconfig that only references the packages holds nothing, and is
    // left out without a word: nobody asked for it.
    const solution = inProject(
      'norefs-workspace-solution-',
      { ...files, 'tsconfig.json': JSON.stringify({ files: [], references: [{ path: 'docs' }] }) },
      dir => runCli(dir)
    );
    expect(solution.stderr).toContain('1 workspace package(s) from pnpm-workspace.yaml\n');
    expect(solution.stderr).not.toContain('warning');
    expect(solution.stdout).not.toContain('src/orphan.ts');
  });

  it('lets an explicit --project win over the declaration', () => {
    const run = inWorkspace('-p', 'packages/core/tsconfig.json');
    expect(run.stderr).not.toContain('workspace package(s)');
    expect(run.stdout).toContain('packages/core/src/orphan.ts');
    expect(run.stdout).not.toContain('apps/web');
  });

  it('reports a missing tsconfig as a usage error, not a stack trace', () => {
    withTempDir('norefs-no-tsconfig-', dir => {
      writeFiles(dir, { 'package.json': '{"name":"solo"}' });
      const run = runCli(dir);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('error: no tsconfig at tsconfig.json');
      expect(run.stderr).not.toMatch(/^\s+at /m);
    });
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
    return inProject('norefs-boundary-', REST, dir => {
      fs.writeFileSync(path.join(dir, 'norefs.config.json'), JSON.stringify(config));
      return runCli(dir);
    });
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
