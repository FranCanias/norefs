import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSession, parseCli } from '../src/cli';
import { inProject, TSCONFIG } from './helpers';

/**
 * The option resolution, tested in-process. `cli.test.ts` proves the binary
 * wires these branches end to end; this file is what lets coverage see them —
 * a child process is outside the instrumentation, so before the resolution
 * moved into `createSession`, nobody could tell which of these branches a
 * test had genuinely reached.
 */
const PROJECT: Record<string, string> = {
  'tsconfig.json': TSCONFIG,
  'src/index.ts': 'export const a = 1;\n',
};

/** Resolve one flag list in a throwaway project, without spawning the binary. */
function resolve<T>(argv: string[], body: (open: () => ReturnType<typeof createSession>, dir: string) => T): T {
  return inProject('norefs-options-', PROJECT, dir => body(() => createSession(parseCli(argv).values, dir), dir));
}

describe('flag combinations that cannot work', () => {
  it('refuses --dry-run without --fix', () => {
    resolve(['--dry-run'], open => expect(open).toThrow('--dry-run requires --fix'));
  });

  it('refuses --watch with the flags that write', () => {
    resolve(['--watch', '--fix'], open => expect(open).toThrow('--watch cannot combine with --fix or --baseline'));
    resolve(['--watch', '--baseline'], open => expect(open).toThrow('--watch cannot combine'));
  });

  it('refuses --production with --fix, from the flag and from the config', () => {
    resolve(['--production', '--fix', '--allow-dirty'], open =>
      expect(open).toThrow('--production cannot combine with --fix')
    );
    resolve(['--fix', '--allow-dirty'], (open, dir) => {
      fs.writeFileSync(path.join(dir, 'norefs.config.json'), JSON.stringify({ production: true }));
      expect(open).toThrow('--production cannot combine with --fix');
    });
  });
});

describe('names picked from a table', () => {
  it('refuses an export format it does not write', () => {
    resolve(['--export', 'yaml'], open => expect(open).toThrow('--export must be one of md, json, got "yaml"'));
  });

  it('names the flag or the config file, whichever carried the bad reporter', () => {
    resolve(['--reporter', 'jsonl'], open => expect(open).toThrow('--reporter must be one of'));
    resolve([], (open, dir) => {
      fs.writeFileSync(path.join(dir, 'norefs.config.json'), JSON.stringify({ reporter: 'jsonl' }));
      expect(open).toThrow('"reporter" in norefs.config.json must be one of');
    });
  });

  it('refuses an unknown --only kind by name', () => {
    resolve(['--only', 'bogus'], open => expect(open).toThrow('unknown kind "bogus"'));
  });
});

describe('paths that must exist', () => {
  it('refuses a missing tsconfig, with the hint only when nothing named one', () => {
    resolve(['-p', 'missing/tsconfig.json'], open => {
      expect(open).toThrow('no tsconfig at missing/tsconfig.json');
      expect(open).not.toThrow('Pass one with --project');
    });
    return inProject('norefs-options-bare-', { 'note.txt': 'no tsconfig here\n' }, dir => {
      const open = (): unknown => createSession(parseCli([]).values, dir);
      expect(open).toThrow('no tsconfig at tsconfig.json');
      expect(open).toThrow('Pass one with --project');
    });
  });

  it('refuses a --scope or --entry path that does not exist', () => {
    resolve(['--scope', 'src/typo'], open => expect(open).toThrow('no such path: --scope src/typo'));
    resolve(['--entry', 'src/typo.ts'], open => expect(open).toThrow('no such path: --entry src/typo.ts'));
  });
});

describe('the config file merge', () => {
  it('lets a passed flag win and the config fill the rest', () => {
    resolve([], (open, dir) => {
      fs.writeFileSync(path.join(dir, 'norefs.config.json'), JSON.stringify({ scope: 'src/typo' }));
      // The config's scope is validated exactly like the flag's.
      expect(open).toThrow('no such path: --scope src/typo');
    });
    resolve(['--scope', 'src'], (open, dir) => {
      fs.writeFileSync(path.join(dir, 'norefs.config.json'), JSON.stringify({ scope: 'src/typo' }));
      // The flag's existing path wins over the config's typo.
      expect(open).not.toThrow();
    });
  });
});
