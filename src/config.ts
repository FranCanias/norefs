import fs from 'node:fs';
import path from 'node:path';

interface Config {
  /** tsconfig paths; a monorepo lists one per package. */
  project: string[];
  entry: string[];
  ignore: string[];
  only?: string[];
  ignoreDependencies: string[];
}

const KNOWN_KEYS = ['project', 'entry', 'ignore', 'only', 'ignoreDependencies'];

/** Read noref.json from the directory, if present. Throws when the file is invalid. */
export function loadConfig(dir: string): Config {
  const filePath = path.join(dir, 'noref.json');
  if (!fs.existsSync(filePath)) return { project: [], entry: [], ignore: [], ignoreDependencies: [] };

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`noref.json is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('noref.json must be a JSON object');
  }
  const data = raw as Record<string, unknown>;
  for (const key of Object.keys(data)) {
    if (!KNOWN_KEYS.includes(key)) {
      throw new Error(`noref.json has an unknown key "${key}" (expected ${KNOWN_KEYS.join(', ')})`);
    }
  }
  return {
    project: readStringOrStrings(data, 'project'),
    entry: readStrings(data, 'entry'),
    ignore: readStrings(data, 'ignore'),
    only: data.only === undefined ? undefined : readStrings(data, 'only'),
    ignoreDependencies: readStrings(data, 'ignoreDependencies'),
  };
}

/** Accepts a single string or an array of strings; normalizes to an array. */
function readStringOrStrings(data: Record<string, unknown>, key: string): string[] {
  const value = data[key];
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`noref.json "${key}" must be a string or an array of strings`);
  }
  return value as string[];
}

function readStrings(data: Record<string, unknown>, key: string): string[] {
  const value = data[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`noref.json "${key}" must be an array of strings`);
  }
  return value as string[];
}
