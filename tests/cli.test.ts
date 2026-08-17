import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildCli, cli, inProject, runCli, TSCONFIG } from './helpers';

/**
 * The flags at the layer that wires them.
 *
 * Every flag here has a unit test under it already. What none of them proves
 * is that `main()` reaches the unit at all: 0.5.0 shipped a feature that had
 * never run end to end, and this file is the answer to that class of miss.
 */
const PROJECT: Record<string, string> = {
  'tsconfig.json': TSCONFIG,
  'src/index.ts': "import { helper } from './lib';\nexport const boot = (): string => helper();\n",
  'src/lib.ts': [
    'type Props = { target: { value: string }; keep: string };',
    'declare const props: Props;',
    'export const helper = (): string => props.keep;',
    "export const dead = (): string => 'dead';",
    '',
  ].join('\n'),
  // Nothing imports it: a second finding, in a second file, for --scope to cut.
  'src/orphan.ts': 'export const orphan = 1;\n',
};

function project<T>(body: (dir: string) => T): T {
  return inProject('norefs-cli-', PROJECT, body);
}

beforeAll(buildCli, 60_000);

describe('argument errors', () => {
  it('answers an unknown flag with a usage error, not a stack trace', () => {
    project(dir => {
      const run = runCli(dir, '--bogus');
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('error:');
      expect(run.stderr).toMatch(/--bogus/);
      expect(run.stderr).not.toMatch(/^\s+at /m);
    });
  });

  it('answers a flag missing its value the same way', () => {
    project(dir => {
      const run = runCli(dir, '--reporter');
      expect(run.status).toBe(2);
      expect(run.stderr).not.toMatch(/^\s+at /m);
    });
  });

  it('refuses a --scope or --entry path that does not exist', () => {
    // A typo'd path filters everything out, and a run that reports nothing
    // reads as a clean project. It says the path instead.
    project(dir => {
      const scope = runCli(dir, '--scope', 'src/typo');
      expect(scope.status).toBe(2);
      expect(scope.stderr).toContain('no such path: --scope src/typo');

      const entry = runCli(dir, '--entry', 'src/typo.ts');
      expect(entry.status).toBe(2);
      expect(entry.stderr).toContain('no such path: --entry src/typo.ts');
    });
  });
});

describe('the flags that shape one report', () => {
  it('cuts the report down to --scope and keeps resolving usages outside it', () => {
    project(dir => {
      const run = runCli(dir, '--scope', 'src/lib.ts');
      expect(run.status).toBe(1);
      expect(run.stdout).toContain('`dead`');
      expect(run.stdout).not.toContain('orphan.ts');
    });
  });

  it('adds the evidence chain under --explain and the unnamed types under --anon', () => {
    project(dir => {
      expect(runCli(dir).stdout).not.toContain('no references anywhere');
      expect(runCli(dir, '--explain').stdout).toContain('no references anywhere');
      expect(runCli(dir).stdout).not.toContain('`value`');
      expect(runCli(dir, '--anon').stdout).toContain('`value`');
    });
  });

  it('treats an --entry file as an entry point, so nothing in it is unused', () => {
    project(dir => {
      expect(runCli(dir).stdout).toContain('orphan.ts');
      const run = runCli(dir, '--entry', 'src/orphan.ts');
      expect(run.stdout).not.toContain('orphan.ts');
    });
  });

  it('writes SARIF a code-scanning upload would accept', () => {
    project(dir => {
      const run = runCli(dir, '--reporter', 'sarif');
      const report = JSON.parse(run.stdout);
      expect(report.version).toBe('2.1.0');
      expect(report.runs[0].tool.driver.name).toBe('norefs');
      expect(report.runs[0].results.length).toBeGreaterThan(0);
    });
  });
});

describe('norefs init', () => {
  it('writes a config the next run reads, and refuses to overwrite it', () => {
    project(dir => {
      const first = runCli(dir, 'init');
      expect(first.status).toBe(0);
      expect(first.stderr).toContain('Wrote norefs.config.json');
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'norefs.config.json'), 'utf8')).reporter).toBe('text');
      // The written defaults are a config a run accepts, key for key.
      expect(runCli(dir).status).toBe(1);

      const again = runCli(dir, 'init');
      expect(again.status).toBe(2);
      expect(again.stderr).toContain('already exists');
    });
  });
});

describe('--baseline and --ratchet', () => {
  it('records the findings, then reports and fails on new ones only', () => {
    project(dir => {
      const write = runCli(dir, '--baseline');
      expect(write.status).toBe(0);
      expect(write.stderr).toContain('Wrote norefs-baseline.json with 3 finding(s)');

      // Everything recorded: the run passes and says what it suppressed.
      const clean = runCli(dir);
      expect(clean.status).toBe(0);
      expect(clean.stderr).toContain('Baseline: 3 finding(s) matched and were not reported');

      // One new finding is the only thing reported, and it fails the run.
      fs.appendFileSync(path.join(dir, 'src/lib.ts'), 'export const alsoDead = 2;\n');
      const after = runCli(dir);
      expect(after.status).toBe(1);
      expect(after.stdout).toContain('`alsoDead`');
      expect(after.stdout).not.toContain('`dead`');
    });
  });

  it('asks for a refresh when a recorded finding is gone, and --ratchet does it', () => {
    project(dir => {
      runCli(dir, '--baseline');
      fs.rmSync(path.join(dir, 'src/orphan.ts'));

      const stale = runCli(dir);
      expect(stale.stderr).toContain('1 baseline finding(s) no longer occur');
      const before = JSON.parse(fs.readFileSync(path.join(dir, 'norefs-baseline.json'), 'utf8'));
      expect(before).toHaveLength(3);

      const ratchet = runCli(dir, '--ratchet');
      expect(ratchet.status).toBe(0);
      expect(ratchet.stderr).toContain('Ratchet: dropped 1 stale entry from the baseline');
      const after = JSON.parse(fs.readFileSync(path.join(dir, 'norefs-baseline.json'), 'utf8'));
      expect(after.map((entry: { name: string }) => entry.name).sort()).toEqual(['dead', 'target']);
    });
  });

  it('refuses a baseline file that is not a baseline', () => {
    project(dir => {
      fs.writeFileSync(path.join(dir, 'norefs-baseline.json'), JSON.stringify([{ kind: 'export' }]));
      const run = runCli(dir);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('needs a kind, filePath, name, and context');
    });
  });
});

describe('--export', () => {
  it('writes the markdown report beside the text one', () => {
    project(dir => {
      const run = runCli(dir, '--export', 'md');
      expect(run.stderr).toContain('Wrote norefs-findings.md');
      const report = fs.readFileSync(path.join(dir, 'norefs-findings.md'), 'utf8');
      expect(report).toContain('# norefs');
      expect(report).toContain('`dead`');
      // The report on stdout is still the text one.
      expect(run.stdout).not.toContain('# norefs');
    });
  });

  it('writes the JSON report, with the same findings the reporter prints', () => {
    project(dir => {
      const run = runCli(dir, '--export', 'json');
      expect(run.stderr).toContain('Wrote norefs-findings.json');
      const findings = JSON.parse(fs.readFileSync(path.join(dir, 'norefs-findings.json'), 'utf8'));
      expect(findings.map((f: { name: string }) => f.name).sort()).toEqual(['dead', 'orphan.ts', 'target']);
    });
  });

  it('refuses a format it does not write', () => {
    project(dir => {
      const run = runCli(dir, '--export', 'yaml');
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('--export must be "md" or "json"');
    });
  });
});

describe('the dirty-tree guard', () => {
  /** A git repository with one uncommitted change in it. */
  function dirtyRepo(dir: string): void {
    const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('add', '-A');
    git('commit', '-qm', 'fixtures');
    fs.appendFileSync(path.join(dir, 'src/lib.ts'), '// an edit of my own\n');
  }

  it('refuses --fix in a tree with uncommitted changes', () => {
    project(dir => {
      dirtyRepo(dir);
      const before = fs.readFileSync(path.join(dir, 'src/lib.ts'), 'utf8');
      const run = runCli(dir, '--fix');
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('the working tree has uncommitted changes');
      expect(fs.readFileSync(path.join(dir, 'src/lib.ts'), 'utf8')).toBe(before);
    });
  });

  it('lets --allow-dirty through, and --dry-run past it without the flag', () => {
    project(dir => {
      dirtyRepo(dir);
      expect(runCli(dir, '--fix', '--dry-run').status).toBe(1);

      const run = runCli(dir, '--fix', '--allow-dirty');
      expect(run.stderr).toContain('Fixed');
      expect(fs.readFileSync(path.join(dir, 'src/lib.ts'), 'utf8')).not.toContain('const dead');
    });
  });
});

describe('--watch', () => {
  it('reports once, keeps watching, and reports again after an edit', async () => {
    await project(async dir => {
      const watcher = spawn(process.execPath, [cli, '--watch'], { cwd: dir });
      let output = '';
      const seen = (text: string, timeoutMs = 20_000): Promise<void> =>
        new Promise((resolve, reject) => {
          const check = (): void => {
            if (!output.includes(text)) return;
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => reject(new Error(`never saw ${text} in:\n${output}`)), timeoutMs);
          for (const stream of [watcher.stdout, watcher.stderr]) {
            stream.on('data', (chunk: Buffer) => {
              output += chunk.toString();
              check();
            });
          }
          check();
        });

      try {
        await seen('Watching for file changes');
        expect(output).toContain('`dead`');

        output = '';
        fs.writeFileSync(path.join(dir, 'src/lib.ts'), "export const helper = (): string => 'ok';\n");
        // The re-run reports the file it just watched change.
        await seen('Watching for file changes');
        expect(output).not.toContain('`dead`');
      } finally {
        watcher.kill();
      }
    });
  }, 40_000);

  it('refuses to combine with the flags that write', () => {
    project(dir => {
      expect(runCli(dir, '--watch', '--fix').status).toBe(2);
      expect(runCli(dir, '--watch', '--baseline').stderr).toContain('--watch cannot combine');
    });
  });
});
