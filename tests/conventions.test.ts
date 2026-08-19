import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { root } from './helpers';

describe('the suite keeps its own house rules', () => {
  it('references every fixture directory from at least one test', () => {
    // CONTRIBUTING promises that no checked-in fixture is orphaned. The
    // promise was a convention; this makes it a failure.
    const testsDir = path.join(root, 'tests');
    const entries = fs.readdirSync(testsDir, { withFileTypes: true });
    const fixtureDirs = entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
    const sources = entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
      .map(entry => fs.readFileSync(path.join(testsDir, entry.name), 'utf8'))
      .join('\n');
    for (const dir of fixtureDirs) {
      expect(sources.includes(`'${dir}'`), `tests/${dir} is referenced by no test`).toBe(true);
    }
  });
});
