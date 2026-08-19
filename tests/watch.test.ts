import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze';
import { loadProject } from '../src/engine/project';
import { refreshProject } from '../src/engine/watch';
import { makeTempDir } from './helpers';

const dir = makeTempDir('norefs-watch-');
const tsConfigPath = path.join(dir, 'tsconfig.json');
const libPath = path.join(dir, 'src/lib.ts');
const orphanPath = path.join(dir, 'src/orphan.ts');

beforeAll(() => {
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(tsConfigPath, JSON.stringify({ compilerOptions: { strict: true }, include: ['src'] }));
  fs.writeFileSync(path.join(dir, 'src/index.ts'), "import { used } from './lib';\n\nused();\n");
  fs.writeFileSync(
    libPath,
    'export function used(): number {\n  return 1;\n}\n\nexport function dead(): number {\n  return 2;\n}\n'
  );
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('watch-mode project refresh', () => {
  it('follows edits, created files, and deletions without reloading the project', () => {
    const project = loadProject([tsConfigPath]);
    const names = () => analyze(project, { rootDirs: [dir] }).map(f => f.name);
    expect(names()).toEqual(['dead']);

    // An edit on disk: the finding disappears after a refresh.
    fs.writeFileSync(libPath, 'export function used(): number {\n  return 1;\n}\n');
    expect(refreshProject(project, [tsConfigPath], [libPath])).toBe(true);
    expect(names()).toEqual([]);

    // A created file: re-globbing the tsconfig picks it up.
    fs.writeFileSync(orphanPath, 'export const orphan = 1;\n');
    expect(refreshProject(project, [tsConfigPath], [orphanPath])).toBe(true);
    expect(names()).toEqual(['orphan.ts']);

    // A deletion: the file is forgotten and its finding goes away.
    fs.rmSync(orphanPath);
    expect(refreshProject(project, [tsConfigPath], [orphanPath])).toBe(true);
    expect(names()).toEqual([]);

    // Noise (an unrelated path, nothing changed on disk) reports no work.
    expect(refreshProject(project, [tsConfigPath], [path.join(dir, '.DS_Store')])).toBe(false);
  });

  it('treats a directory event as covering the files underneath it', () => {
    const project = loadProject([tsConfigPath]);
    const deepDir = path.join(dir, 'src/deep');
    fs.mkdirSync(deepDir);
    fs.writeFileSync(path.join(deepDir, 'stray.ts'), 'export const stray = 1;\n');
    expect(refreshProject(project, [tsConfigPath], [deepDir])).toBe(true);
    expect(analyze(project, { rootDirs: [dir] }).map(f => f.name)).toEqual(['stray.ts']);

    // Deleting the directory fires one event for the directory, not the file.
    fs.rmSync(deepDir, { recursive: true });
    expect(refreshProject(project, [tsConfigPath], [deepDir])).toBe(true);
    expect(analyze(project, { rootDirs: [dir] })).toEqual([]);
  });
});
