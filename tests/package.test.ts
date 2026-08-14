import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');

/** The files npm would publish, asked of npm rather than re-derived from `files`. */
function published(): Set<string> {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
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

  it('ships the flag reference the exit codes are documented in', () => {
    const files = published();
    expect(files.has('docs/flags.md')).toBe(true);
    expect(files.has('CHANGELOG.md')).toBe(true);
    expect(files.has('README.md')).toBe(true);
  });
});
