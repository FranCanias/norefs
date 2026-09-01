import path from 'node:path';
import type { CompilerOptions } from 'ts-morph';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import { analyzeSyntax, listEntryPoints } from '../src/engine/syntax-analyze';
import { fixture } from './helpers';

function findingsOf(manifest: object, files: Record<string, string>, compilerOptions: CompilerOptions = {}) {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions });
  project.getFileSystem().writeFileSync('/package.json', JSON.stringify(manifest));
  for (const [filePath, text] of Object.entries(files)) project.createSourceFile(filePath, text);
  return analyze(project, { rootDirs: ['/'] });
}

/** Files a build tool reads but TypeScript does not compile: HTML, configs. */
function findingsWith(
  manifest: object,
  plainFiles: Record<string, string>,
  sourceFiles: Record<string, string>,
  compilerOptions: CompilerOptions = {}
) {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions });
  const fileSystem = project.getFileSystem();
  fileSystem.writeFileSync('/package.json', JSON.stringify(manifest));
  for (const [filePath, text] of Object.entries(plainFiles)) fileSystem.writeFileSync(filePath, text);
  for (const [filePath, text] of Object.entries(sourceFiles)) project.createSourceFile(filePath, text);
  return analyze(project, { rootDirs: ['/'] });
}

function names(findings: ReturnType<typeof analyze>): string[] {
  return findings.filter(f => f.kind === 'file').map(f => f.name);
}

describe('package.json-aware entries', () => {
  it('maps main, bin, and exports through outDir back to source entry points', () => {
    const findings = findingsOf(
      {
        main: 'dist/app.js',
        bin: { tool: './dist/tool.js' },
        exports: {
          '.': { import: './dist/lib.mjs' },
          './direct': './src/direct.ts',
        },
      },
      {
        '/src/app.ts': 'export const app = 1;\n',
        '/src/tool.ts': 'export const tool = 1;\n',
        '/src/lib.ts': 'export const lib = 1;\n',
        '/src/direct.ts': 'export const direct = 1;\n',
        '/src/orphan.ts': 'export const orphan = 1;\n',
      },
      { outDir: 'dist', rootDir: 'src' }
    );
    // The named files are entry points: not unused, exports never reported.
    // The control file stays a finding.
    expect(findings.map(f => [f.kind, f.name])).toEqual([['file', 'orphan.ts']]);
  });

  it('expands an exports pattern against the files the run holds', () => {
    // `./*` publishes every subpath and names none of them, so the pattern is
    // what has to be read. A harness file is never published, whatever shape
    // the pattern takes.
    const findings = findingsOf(
      { exports: { './*': './dist/*.js' } },
      {
        '/src/anything.ts': 'export const anything = 1;\n',
        '/src/deep/nested.ts': 'export const nested = 1;\n',
        '/src/anything.test.ts': "import { anything } from './anything';\nexport const seen = anything;\n",
      },
      { outDir: 'dist', rootDir: 'src' }
    );
    // Both source files are published; the test file is not, and answers for
    // its own dead export like the harness file it is.
    expect(findings.map(f => [f.kind, f.name])).toEqual([['export', 'seen']]);
  });

  it('leaves a pattern that matches nothing alone', () => {
    const findings = findingsOf(
      { exports: { './*': './built/*.js' } },
      { '/src/anything.ts': 'export const anything = 1;\n' },
      { outDir: 'dist', rootDir: 'src' }
    );
    expect(findings.map(f => [f.kind, f.name])).toEqual([['file', 'anything.ts']]);
  });
});

describe('entry points the build declares', () => {
  it('a script that runs a source file names an entry point', () => {
    const findings = findingsOf(
      { scripts: { serve: 'tsx src/server.ts', lint: 'biome lint .' } },
      {
        '/src/server.ts': 'export const server = 1;\n',
        '/src/orphan.ts': 'export const orphan = 1;\n',
      }
    );
    expect(names(findings)).toEqual(['orphan.ts']);
  });

  it('a script flag written with = still names its file', () => {
    // Deliberately not a *.config.ts and not index/main/cli: those are entry
    // points already, and a test they pass without the token parsing proves
    // nothing about the token parsing.
    const findings = findingsOf(
      { scripts: { gen: 'codegen --schema=src/schema.ts' } },
      {
        '/src/schema.ts': 'export const schema = 1;\n',
        '/src/orphan.ts': 'export const orphan = 1;\n',
      }
    );
    expect(names(findings)).toEqual(['orphan.ts']);
  });

  it("an HTML file's script src names an entry point, root-absolute included", () => {
    const findings = findingsWith(
      {},
      { '/index.html': '<script type="module" src="/src/renderer/boot.tsx"></script>' },
      { '/src/renderer/boot.tsx': 'export const boot = 1;\n', '/src/orphan.ts': 'export const orphan = 1;\n' }
    );
    expect(names(findings)).toEqual(['orphan.ts']);
  });

  it('a path written in a tool config names an entry point', () => {
    const findings = findingsWith(
      {},
      { '/vite.config.ts': "export default { build: { rollupOptions: { input: 'src/preload.ts' } } };" },
      { '/src/preload.ts': 'export const preload = 1;\n', '/src/orphan.ts': 'export const orphan = 1;\n' }
    );
    expect(names(findings)).toEqual(['orphan.ts']);
  });

  it('a second target writes its config the same way, and is read the same way', () => {
    // `vite.config.server.ts` beside `vite.config.ts` is how a build says it has
    // two targets. Reading only the first one left the second target's entry
    // point looking like a dead file.
    const findings = findingsWith(
      {},
      { '/vite.config.server.ts': "export default { build: { rollupOptions: { input: 'server/main.ts' } } };" },
      { '/server/main.ts': 'export const serve = 1;\n', '/src/orphan.ts': 'export const orphan = 1;\n' }
    );
    expect(names(findings)).toEqual(['orphan.ts']);
  });

  it('a path with no extension resolves the way an import would, directories included', () => {
    // An alias target is written like an import: no extension, or the directory
    // whose index is the module.
    const findings = findingsWith(
      {},
      {
        '/vite.config.ts':
          "export default { resolve: { alias: { '@/routes': './src/Routes.web', '@/api': './src/api' } } };",
      },
      {
        '/src/Routes.web.tsx': 'export const routes = 1;\n',
        '/src/api/index.ts': 'export const api = 1;\n',
        '/src/orphan.ts': 'export const orphan = 1;\n',
      }
    );
    expect(names(findings)).toEqual(['orphan.ts']);
  });

  it('a bare word is a word, not a path missing its extension', () => {
    // `environment: 'jsdom'` names a package, and guessing extensions for it
    // would silence every finding in a file that happens to share the name.
    const findings = findingsWith(
      {},
      { '/vitest.config.ts': "export default { test: { environment: 'jsdom' } };" },
      { '/jsdom.ts': 'export const shim = 1;\n' }
    );
    expect(names(findings)).toEqual(['jsdom.ts']);
  });

  it('a module the config imports is not an entry point, so its exports stay private', () => {
    // The import is already an edge in the graph, which keeps the file alive.
    // Calling it an entry point on top of that would publish its exports as API.
    const findings = findingsWith(
      {},
      {},
      {
        '/vitest.config.ts': "import { fixture, probe } from './helpers';\nexport default { setupFiles: [probe] };\n",
        '/helpers.ts': 'export const probe = 1;\nexport const unusedProbe = 2;\n',
      }
    );
    // Both exports stay reportable — an entry point would have published them.
    expect(findings.map(f => [f.kind, f.name, f.verdict])).toEqual([
      ['export', 'probe', 'test-only'],
      ['export', 'unusedProbe', 'dead'],
    ]);
  });

  it('a specifier inside a comment is not something the config imports', () => {
    // The comment is a line somebody turned off. Reading the config's raw text
    // filed it as an import, which cancelled the setup file named right below
    // it — and a live file came back dead.
    const project = new Project({ useInMemoryFileSystem: true });
    const fileSystem = project.getFileSystem();
    fileSystem.writeFileSync('/package.json', '{}');
    fileSystem.writeFileSync(
      '/vitest.config.ts',
      "// vitest loads it the way import './probe' would\nexport default { test: { setupFiles: ['./probe'] } };\n"
    );
    // On disk and in the program, which is what makes the config a root: only
    // then does an import of its own count as an edge already in the graph.
    project.addSourceFileAtPath('/vitest.config.ts');
    project.createSourceFile('/probe.ts', 'export const probe = 1;\n');
    expect(names(analyze(project, { rootDirs: ['/'] }))).toEqual([]);
  });

  it('a config the program never holds is no root, so what it imports is an entry point', () => {
    // `eslint.config.js` is not a file the TypeScript program holds, so it is
    // not a root of the graph either. Skipping its imports as "already an edge"
    // left the file it names with no importer at all, and it came back dead.
    const findings = findingsWith(
      {},
      { '/eslint.config.js': "import rules from './tools/rules.js';\nexport default [rules];\n" },
      { '/tools/rules.ts': 'export const rules = 1;\n', '/src/orphan.ts': 'export const orphan = 1;\n' }
    );
    expect(names(findings)).toEqual(['orphan.ts']);
  });

  it('a directory a script scans is not an entry point', () => {
    // `linter src/lib` names a tree to look at, not a module to load. Reading
    // it as `src/lib/index.ts` would publish that file's exports as API.
    const findings = findingsOf(
      { scripts: { lint: 'linter src/lib' } },
      {
        '/src/main.ts': "import { used } from './lib';\nexport const main = used;\n",
        '/src/lib/index.ts': 'export const used = 1;\nexport const neverUsed = 2;\n',
      }
    );
    expect(findings.map(f => [f.kind, f.name, f.verdict])).toEqual([['export', 'neverUsed', 'dead']]);
  });

  it('a product file shaped like a second target config is still product code', () => {
    // `form.config.schema.ts` is a schema, and nothing in the name says
    // otherwise. Reading it as a build file made it absent from the product,
    // which lost the dead-file verdict on it and on everything it imports.
    const findings = findingsOf(
      {},
      {
        '/src/form.config.schema.ts': "import { deep } from './deep';\nexport const schema = deep;\n",
        '/src/deep.ts': 'export const deep = 1;\n',
      }
    );
    expect(names(findings)).toEqual(['deep.ts', 'form.config.schema.ts']);
  });

  it('a string that names no project file changes nothing', () => {
    // The loose split is only safe because the resolver throws away what it
    // cannot land on a file. A config full of prose must not silence anything.
    const findings = findingsWith(
      { scripts: { build: 'tsc && vite build --mode production' } },
      { '/app.config.ts': "export default { title: 'src', mode: './nothing/here.ts' };" },
      { '/src/orphan.ts': 'export const orphan = 1;\n' }
    );
    expect(names(findings)).toEqual(['orphan.ts']);
  });

  it('finds the source of a built entry when rootDir describes no build', () => {
    // swr's shape. A package built by a bundler keeps a tsconfig for the type
    // check alone, and it is free to say anything: `outDir: dist` with
    // `rootDir: .` maps `dist/index/index.js` onto a path no file has. Nothing
    // resolved, and the whole source tree came back dead.
    const findings = findingsOf(
      { main: './dist/index/index.js' },
      {
        '/src/index/index.ts': "export { whisk } from '../whisk';\n",
        '/src/whisk.ts': 'export const whisk = 1;\n',
        '/src/orphan.ts': 'export const orphan = 1;\n',
      },
      { outDir: '/dist', rootDir: '/' }
    );
    expect(names(findings)).toEqual(['orphan.ts']);
  });

  it('finds the source of a built entry when no outDir names the build', () => {
    // h3's shape: `noEmit: true`, no `outDir`, and a manifest that names
    // `./dist/_entries/node.mjs` all the same. There was no mapping to try, so
    // nothing was tried, and every published entry came back dead.
    const findings = findingsOf(
      { exports: { '.': { node: './dist/entries/node.mjs', default: './dist/entries/generic.mjs' } } },
      {
        '/src/entries/node.ts': "export { serve } from './generic';\n",
        '/src/entries/generic.ts': 'export const serve = 1;\n',
        '/src/orphan.ts': 'export const orphan = 1;\n',
      }
    );
    expect(names(findings)).toEqual(['orphan.ts']);
  });

  it('takes no guess at a directory the run holds a file in', () => {
    // `lib/tool.js` beside `lib/other.ts` is a file that is missing, not one
    // that is built: the directory is source by demonstration.
    const findings = findingsOf(
      { main: './lib/tool.js' },
      { '/lib/other.ts': 'export const other = 1;\n', '/src/tool.ts': 'export const tool = 1;\n' }
    );
    expect(names(findings)).toEqual(['other.ts', 'tool.ts']);
  });

  it('finds a built entry whose name lost its index. prefix', () => {
    // bunchee writes `src/index/index.react-server.ts` to
    // `dist/index/react-server.mjs`, and swr's `exports["."].react-server`
    // names the built one. `config.ts` dies with the entry: it is its only
    // importer.
    const findings = findingsOf(
      { exports: { '.': { 'react-server': './dist/index/react-server.mjs', default: './dist/index/index.mjs' } } },
      {
        '/src/index/index.ts': 'export const whisk = 1;\n',
        '/src/index/index.react-server.ts': "export { serverOnly } from './config';\n",
        '/src/index/config.ts': 'export const serverOnly = 1;\n',
        '/src/orphan.ts': 'export const orphan = 1;\n',
      },
      { outDir: '/dist', rootDir: '/' }
    );
    expect(names(findings)).toEqual(['orphan.ts']);
  });

  it('makes no guess when two source roots answer at once', () => {
    // Which one ships would be a coin toss, so neither is named and the run
    // says what it always says when no entry point resolves.
    const findings = findingsOf(
      { main: './dist/whisk.js' },
      {
        '/src/whisk.ts': 'export const fromSrc = 1;\n',
        '/lib/whisk.ts': 'export const fromLib = 1;\n',
      },
      { outDir: '/dist', rootDir: '/' }
    );
    expect(names(findings)).toEqual(['whisk.ts', 'whisk.ts']);
  });

  it('build output is never walked for configs', () => {
    const findings = findingsWith(
      {},
      { '/dist/stale.config.js': "export default { input: 'src/orphan.ts' };" },
      { '/src/orphan.ts': 'export const orphan = 1;\n' }
    );
    expect(names(findings)).toEqual(['orphan.ts']);
  });
});

describe('a real project on disk', () => {
  const dir = fixture('entry-fixtures');
  const tsConfig = path.join(dir, 'tsconfig.json');

  it('names every entry point and what declared it', () => {
    const found = listEntryPoints([tsConfig], {}, { rootDirs: [dir] }).map(entry => [
      path.relative(dir, entry.filePath),
      entry.source,
    ]);
    expect(found).toEqual([
      ['src/boot.tsx', '<script src> in index.html'],
      ['src/main.ts', 'index/main/cli beside a tsconfig'],
      ['src/preload.ts', 'a path named in vite.config.ts'],
      ['src/server.ts', 'package.json scripts.serve'],
    ]);
  });

  it('leaves the syntax-only run with the one true finding', () => {
    const findings = analyzeSyntax([tsConfig], {}, { rootDirs: [dir] });
    expect(findings.map(f => f.name)).toEqual(['orphan.ts']);
  });
});
