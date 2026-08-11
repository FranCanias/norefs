import fs from 'node:fs';
import path from 'node:path';

export interface Config {
  project?: string;
  entry: string[];
  ignore: string[];
  only?: string[];
}

const KNOWN_KEYS = ['project', 'entry', 'ignore', 'only'];

/** Read noref.json from the directory, if present. Throws when the file is invalid. */
export function loadConfig(dir: string): Config {
  const filePath = path.join(dir, 'noref.json');
  if (!fs.existsSync(filePath)) return { entry: [], ignore: [] };

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
    project: readString(data, 'project'),
    entry: readStrings(data, 'entry'),
    ignore: readStrings(data, 'ignore'),
    only: data.only === undefined ? undefined : readStrings(data, 'only'),
  };
}

function readString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`noref.json "${key}" must be a string`);
  return value;
}

function readStrings(data: Record<string, unknown>, key: string): string[] {
  const value = data[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`noref.json "${key}" must be an array of strings`);
  }
  return value as string[];
}
