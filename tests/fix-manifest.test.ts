import { describe, expect, it } from 'vitest';
import { editManifest } from '../src/engine/fix-manifest';

/**
 * A manifest is a file people read and write by hand. Every test here checks
 * the same thing twice: that the entry moved, and that nothing else did.
 */
const MANIFEST = [
  '{',
  '  "name": "demo",',
  '  "scripts": {',
  '    "build": "tsc -p tsconfig.json"',
  '  },',
  '  "dependencies": {',
  '    "alpha": "^1.0.0",',
  '    "only-in-tests": "1.0.0",',
  '    "zulu": "3.2.1"',
  '  },',
  '  "devDependencies": {',
  '    "biome": "2.0.0",',
  '    "runtime": "1.0.0"',
  '  }',
  '}',
  '',
].join('\n');

function parsed(text: string): Record<string, Record<string, string>> {
  return JSON.parse(text);
}

describe('editing package.json as text', () => {
  it('removes an entry and leaves every other line untouched', () => {
    const { text, refused } = editManifest(MANIFEST, [{ name: 'only-in-tests', from: 'dependencies' }]);
    expect(refused).toEqual([]);
    expect(parsed(text).dependencies).toEqual({ alpha: '^1.0.0', zulu: '3.2.1' });
    expect(text.split('\n').filter(line => line.includes('"build"'))).toEqual(['    "build": "tsc -p tsconfig.json"']);
    // One line fewer, and it is the one that was asked for.
    expect(MANIFEST.split('\n').length - text.split('\n').length).toBe(1);
  });

  it('removes the last entry of a section without leaving a trailing comma', () => {
    const { text } = editManifest(MANIFEST, [{ name: 'zulu', from: 'dependencies' }]);
    expect(() => parsed(text)).not.toThrow();
    expect(parsed(text).dependencies).toEqual({ alpha: '^1.0.0', 'only-in-tests': '1.0.0' });
  });

  it('closes up a section it just emptied', () => {
    const { text } = editManifest(MANIFEST, [
      { name: 'biome', from: 'devDependencies' },
      { name: 'runtime', from: 'devDependencies' },
    ]);
    expect(() => parsed(text)).not.toThrow();
    expect(parsed(text).devDependencies).toEqual({});
    expect(text).toContain('"devDependencies": {}');
  });

  it('moves an entry into a sorted section, in sorted position', () => {
    const { text } = editManifest(MANIFEST, [{ name: 'only-in-tests', from: 'dependencies', to: 'devDependencies' }]);
    expect(() => parsed(text)).not.toThrow();
    const after = parsed(text);
    expect(after.dependencies).toEqual({ alpha: '^1.0.0', zulu: '3.2.1' });
    expect(after.devDependencies).toEqual({ biome: '2.0.0', 'only-in-tests': '1.0.0', runtime: '1.0.0' });
    // Alphabetical, because the section already was.
    expect(Object.keys(after.devDependencies)).toEqual(['biome', 'only-in-tests', 'runtime']);
    expect(text).toContain('    "only-in-tests": "1.0.0",');
  });

  it('moves an entry the other way, keeping its version range', () => {
    const { text } = editManifest(MANIFEST, [{ name: 'runtime', from: 'devDependencies', to: 'dependencies' }]);
    expect(() => parsed(text)).not.toThrow();
    const after = parsed(text);
    expect(after.dependencies.runtime).toBe('1.0.0');
    expect(after.devDependencies).toEqual({ biome: '2.0.0' });
  });

  it('appends to an unsorted section rather than reordering it', () => {
    const unsorted = [
      '{',
      '  "dependencies": {',
      '    "zulu": "1.0.0",',
      '    "alpha": "1.0.0"',
      '  },',
      '  "devDependencies": {',
      '    "moving": "1.0.0"',
      '  }',
      '}',
      '',
    ].join('\n');
    const { text } = editManifest(unsorted, [{ name: 'moving', from: 'devDependencies', to: 'dependencies' }]);
    expect(() => parsed(text)).not.toThrow();
    expect(Object.keys(parsed(text).dependencies)).toEqual(['zulu', 'alpha', 'moving']);
  });

  it('refuses a move with no section to move into, and says so', () => {
    const noDevSection = ['{', '  "dependencies": {', '    "solo": "1.0.0"', '  }', '}', ''].join('\n');
    const { text, refused } = editManifest(noDevSection, [
      { name: 'solo', from: 'dependencies', to: 'devDependencies' },
    ]);
    expect(text).toBe(noDevSection);
    expect(refused).toEqual([{ name: 'solo', reason: 'there is no "devDependencies" section to move it into' }]);
  });

  it('reopens a section it emptied, when something moves into it', () => {
    // Order matters: the entry leaving is the last one, so the section closes
    // up — and then the entry arriving has to open it again.
    const { text, refused } = editManifest(MANIFEST, [
      { name: 'alpha', from: 'dependencies', to: 'devDependencies' },
      { name: 'only-in-tests', from: 'dependencies', to: 'devDependencies' },
      { name: 'zulu', from: 'dependencies', to: 'devDependencies' },
      { name: 'runtime', from: 'devDependencies', to: 'dependencies' },
    ]);
    expect(refused).toEqual([]);
    expect(() => parsed(text)).not.toThrow();
    expect(parsed(text).dependencies).toEqual({ runtime: '1.0.0' });
    expect(parsed(text).devDependencies).toEqual({
      alpha: '^1.0.0',
      biome: '2.0.0',
      'only-in-tests': '1.0.0',
      zulu: '3.2.1',
    });
    expect(text).toContain('    "runtime": "1.0.0"');
  });

  it('refuses a one-line section with the true reason, not "not found"', () => {
    const compact = ['{', '  "dependencies": { "alpha": "1.0.0", "beta": "2.0.0" }', '}', ''].join('\n');
    const { text, refused } = editManifest(compact, [{ name: 'beta', from: 'dependencies' }]);
    expect(text).toBe(compact);
    expect(refused[0].reason).toContain('shares a line with others');
  });

  it('refuses an entry that is not where it was said to be', () => {
    const { text, refused } = editManifest(MANIFEST, [{ name: 'ghost', from: 'dependencies' }]);
    expect(text).toBe(MANIFEST);
    expect(refused).toEqual([{ name: 'ghost', reason: 'no "ghost" entry in dependencies' }]);
  });

  it('does not confuse a script name with the dependency of the same name', () => {
    const collide = [
      '{',
      '  "scripts": {',
      '    "biome": "biome check ."',
      '  },',
      '  "devDependencies": {',
      '    "biome": "2.0.0"',
      '  }',
      '}',
      '',
    ].join('\n');
    const { text } = editManifest(collide, [{ name: 'biome', from: 'devDependencies' }]);
    expect(() => parsed(text)).not.toThrow();
    expect(parsed(text).scripts).toEqual({ biome: 'biome check .' });
    expect(parsed(text).devDependencies).toEqual({});
  });

  it('keeps two-space and four-space files in their own style', () => {
    const wide = [
      '{',
      '    "dependencies": {',
      '        "alpha": "1.0.0"',
      '    },',
      '    "devDependencies": {',
      '        "moving": "1.0.0"',
      '    }',
      '}',
      '',
    ].join('\n');
    const { text } = editManifest(wide, [{ name: 'moving', from: 'devDependencies', to: 'dependencies' }]);
    expect(() => parsed(text)).not.toThrow();
    expect(text).toContain('        "moving": "1.0.0"');
  });

  it('indents into an empty section one level in, not level with its braces', () => {
    // A section left open but empty — what removing its last entry produces in
    // a hand-written file — has no entry whose indent the arriving one can copy.
    const emptied = [
      '{',
      '  "dependencies": {',
      '    "moving": "1.0.0"',
      '  },',
      '  "devDependencies": {',
      '  }',
      '}',
      '',
    ].join('\n');
    const { text } = editManifest(emptied, [{ name: 'moving', from: 'dependencies', to: 'devDependencies' }]);
    expect(() => parsed(text)).not.toThrow();
    expect(text).toContain('    "moving": "1.0.0"');
  });

  it('leaves a CRLF manifest in CRLF', () => {
    const crlf = MANIFEST.split('\n').join('\r\n');
    const { text, refused } = editManifest(crlf, [
      { name: 'only-in-tests', from: 'dependencies', to: 'devDependencies' },
    ]);
    expect(refused).toEqual([]);
    expect(() => parsed(text)).not.toThrow();
    // Every break is still a pair. A lone \n would be a line this edit rewrote
    // without being asked to.
    expect(text.split('\n').length - 1).toBe(text.split('\r\n').length - 1);
    expect(text).toContain('\r\n    "only-in-tests": "1.0.0",\r\n');
  });
});
