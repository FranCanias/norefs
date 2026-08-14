import fs from 'node:fs';
import path from 'node:path';
import type { Boundary } from './types';

/**
 * What a project decides once, in a file everyone shares.
 *
 * The line the file draws: it holds what shapes the analysis and the report,
 * and never what a run does to your working tree. `--fix`, `--baseline`,
 * `--dry-run`, `--export`, `--watch` are things you ask for on a given run,
 * and each one writes something. A scope, a reporter, `--anon`, `--explain`
 * are true of the project every time it is analyzed.
 */
interface Config {
  /** tsconfig paths; a monorepo lists one per package. */
  project: string[];
  entry: string[];
  ignore: string[];
  only?: string[];
  ignoreDependencies: string[];
  /** Channel boundaries this project uses, beyond the bridge norefs finds on its own. */
  boundaries: Boundary[];
  /** Report only findings declared under this path. Empty means the whole project. */
  scope: string;
  /** text, json, github, or sarif. The CLI checks the name it ends up with. */
  reporter?: string;
  anon: boolean;
  explain: boolean;
  /** Analyze the shipping code path alone; tests and tooling are treated as absent. */
  production: boolean;
}

export const CONFIG_FILE = 'norefs.config.json';

const KNOWN_KEYS = [
  'project',
  'entry',
  'ignore',
  'only',
  'ignoreDependencies',
  'boundaries',
  'scope',
  'reporter',
  'anon',
  'explain',
  'production',
];

/** Read norefs.config.json from the directory, if present. Throws when the file is invalid. */
export function loadConfig(dir: string): Config {
  const filePath = path.join(dir, CONFIG_FILE);
  if (!fs.existsSync(filePath)) {
    return {
      project: [],
      entry: [],
      ignore: [],
      ignoreDependencies: [],
      boundaries: [],
      scope: '',
      anon: false,
      explain: false,
      production: false,
    };
  }

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
    boundaries: readBoundaries(data),
    scope: readString(data, 'scope') ?? '',
    reporter: readString(data, 'reporter'),
    anon: readBoolean(data, 'anon'),
    explain: readBoolean(data, 'explain'),
    production: readBoolean(data, 'production'),
  };
}

/**
 * Write a norefs.config.json holding every key at its default. Empty arrays keep
 * the defaults: no extra entry points, nothing ignored, every kind reported.
 * An empty scope is the whole project. Returns the file name. Throws when the
 * file already exists.
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
    boundaries: [],
    scope: '',
    reporter: 'text',
    anon: false,
    explain: false,
    production: false,
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

function readString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${CONFIG_FILE} "${key}" must be a string`);
  return value;
}

function readBoolean(data: Record<string, unknown>, key: string): boolean {
  const value = data[key];
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error(`${CONFIG_FILE} "${key}" must be true or false`);
  return value;
}

/**
 * The boundaries a project declares. Each entry names the callees on both
 * sides, as a string or a list of them:
 *
 * ```json
 * "boundaries": [{ "send": "fetch", "handle": ["app.get", "app.post"] }]
 * ```
 *
 * An entry missing a side pairs nothing, and a boundary that pairs nothing is
 * a config that looks like it works. So both sides are required, and empty.
 */
function readBoundaries(data: Record<string, unknown>): Boundary[] {
  const value = data.boundaries;
  if (value === undefined) return [];
  const shape = `${CONFIG_FILE} "boundaries" must be an array of { "send": …, "handle": … } entries, each side a string or an array of strings`;
  if (!Array.isArray(value)) throw new Error(shape);
  return value.map(entry => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(shape);
    const boundary = {
      send: side(entry as Record<string, unknown>, 'send'),
      handle: side(entry as Record<string, unknown>, 'handle'),
    };
    if (boundary.send.length === 0 || boundary.handle.length === 0) throw new Error(shape);
    return boundary;
  });

  function side(entry: Record<string, unknown>, key: string): string[] {
    const raw = entry[key];
    if (typeof raw === 'string') return [raw];
    if (Array.isArray(raw) && raw.every(item => typeof item === 'string')) return raw as string[];
    throw new Error(shape);
  }
}

function readStrings(data: Record<string, unknown>, key: string): string[] {
  const value = data[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${CONFIG_FILE} "${key}" must be an array of strings`);
  }
  return value as string[];
}
