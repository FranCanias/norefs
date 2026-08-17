import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');

/**
 * The files npm would publish, asked of npm rather than re-derived from `files`.
 *
 * This is also why no lifecycle script may rebuild `dist`. `npm pack` runs
 * `prepare` — and runs it even under `--ignore-scripts` — so a `prepare` here
 * would wipe `dist` under the suites that spawn the binary, and write its own
 * output into the JSON this parses. The build belongs to `prepublishOnly`,
 * which `npm pack` leaves alone.
 */
function published(): Set<string> {
  // On Windows npm is a .cmd, which execFile cannot start by its bare name.
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const output = execFileSync(npm, ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
  const [tarball] = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
  return new Set(tarball.files.map(file => file.path));
}

/** Every relative link target in a markdown file. Anchors and URLs are not files. */
function linkedFiles(markdown: string): string[] {
  const targets = [...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map(match => match[1]);
  const files = targets.filter(target => !/^(https?:|#|mailto:)/.test(target)).map(target => target.split('#')[0]);
  return [...new Set(files)];
}

describe('the published package', () => {
  it('ships every page its own docs link to', () => {
    // 0.4.0 linked docs/flags.md from the changelog and left it out of the
    // tarball: the page every installed copy pointed at was on no machine that
    // installed the tool. A claim in the release notes has to be true of the
    // artifact, not only of the repository.
    const files = published();
    const docs = fs.readdirSync(path.join(root, 'docs')).map(name => `docs/${name}`);
    for (const source of ['README.md', 'CHANGELOG.md', ...docs]) {
      const markdown = fs.readFileSync(path.join(root, source), 'utf8');
      for (const link of linkedFiles(markdown)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(source), link));
        expect(fs.existsSync(path.join(root, target)), `${source} links to a missing ${target}`).toBe(true);
        expect(files.has(target), `${source} links to ${target}, which the package does not ship`).toBe(true);
      }
    }
  });

  it('documents the same set of flags in all three places that list them', () => {
    // Flag descriptions live three times: the README table, the HELP string,
    // and docs/flags.md. Links and exit codes have tests; the flag lists did
    // not, and every doc drift the 0.7.0 audit found was in one of these.
    const flagsIn = (text: string): Set<string> => new Set(text.match(/--[a-z][a-z-]*/g) ?? []);
    // The negations are forms of the flags they negate, and `--only` names
    // kinds rather than flags; neither is a flag of its own.
    const drop = new Set(['--no-verify', '--no-anon', '--no-explain', '--no-production']);
    const flags = (text: string): string[] => [...flagsIn(text)].filter(flag => !drop.has(flag)).sort();

    const help = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8');
    const helpText = help.slice(help.indexOf('Options:'), help.indexOf('Configuration:'));
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    const readmeTable = readme.slice(readme.indexOf('| Option |'), readme.indexOf('`norefs` exits with code'));
    const reference = fs.readFileSync(path.join(root, 'docs/flags.md'), 'utf8');

    expect(flags(readmeTable)).toEqual(flags(helpText));
    // The reference covers the combinations too, so it is a superset of neither
    // list's absence: every documented flag has to appear there.
    for (const flag of flags(helpText)) {
      expect(reference.includes(flag), `docs/flags.md never mentions ${flag}`).toBe(true);
    }
  });

  it('ships the flag reference the exit codes are documented in', () => {
    const files = published();
    expect(files.has('docs/flags.md')).toBe(true);
    expect(files.has('CHANGELOG.md')).toBe(true);
    expect(files.has('README.md')).toBe(true);
  });

  it('declares itself a CLI and nothing more', () => {
    // The build once emitted 48 declaration files, 13% of the tarball, that
    // nothing could import: no `main`, no `exports`, no `types` to reach them
    // through. Either the manifest publishes an API or the build stops
    // pretending there is one. This pins which way that was decided.
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(manifest.bin).toEqual({ norefs: 'dist/index.js' });
    for (const field of ['main', 'exports', 'types', 'typings', 'module']) {
      expect(manifest[field], `package.json declares ${field}, so it promises an API`).toBeUndefined();
    }
    expect([...published()].filter(file => file.endsWith('.d.ts'))).toEqual([]);
  });
});
