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

const CONFIG_FILE = 'noref.config.json';

const KNOWN_KEYS = ['project', 'entry', 'ignore', 'only', 'ignoreDependencies'];

/** Read noref.config.json from the directory, if present. Throws when the file is invalid. */
export function loadConfig(dir: string): Config {
  const filePath = path.join(dir, CONFIG_FILE);
  if (!fs.existsSync(filePath)) return { project: [], entry: [], ignore: [], ignoreDependencies: [] };

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${CONFIG_FILE} must be a JSON object`);
  }
  const data = raw as Record<string, unknown>;
  for (const key of Object.keys(data)) {
    if (!KNOWN_KEYS.includes(key)) {
      throw new Error(`${CONFIG_FILE} has an unknown key "${key}" (expected ${KNOWN_KEYS.join(', ')})`);
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

/**
 * Write a noref.config.json holding every key at its default. Empty arrays keep
 * the defaults: no extra entry points, nothing ignored, every kind reported.
 * Returns the file name. Throws when the file already exists.
 */
export function initConfig(dir: string): string {
  const filePath = path.join(dir, CONFIG_FILE);
  if (fs.existsSync(filePath)) throw new Error(`${CONFIG_FILE} already exists — delete it first to start over`);

  const defaults: Config = {
    project: ['tsconfig.json'],
    entry: [],
    ignore: [],
    only: [],
    ignoreDependencies: [],
  };
  fs.writeFileSync(filePath, `${JSON.stringify(defaults, null, 2)}\n`);
  return CONFIG_FILE;
}

/** Accepts a single string or an array of strings; normalizes to an array. */
function readStringOrStrings(data: Record<string, unknown>, key: string): string[] {
  const value = data[key];
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${CONFIG_FILE} "${key}" must be a string or an array of strings`);
  }
  return value as string[];
}

function readStrings(data: Record<string, unknown>, key: string): string[] {
  const value = data[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${CONFIG_FILE} "${key}" must be an array of strings`);
  }
  return value as string[];
}
