#!/usr/bin/env node
/**
 * Generate a project built to exercise one shape, so a claim about that shape
 * can be re-run instead of remembered.
 *
 *   node bench/synthetic.mjs <shape> <directory> [files]
 *
 * Shapes:
 *   single-return   one `return { … }` per function — the path that always worked
 *   multi-return    the same volume of keys, split across three `return`s
 *   computed-key    nothing but `rows[i]` indexing, to price the key lookup
 *   relay           every type reaching `Object.keys` through a helper
 *
 * `single-return` and `multi-return` declare the same number of dead keys, so
 * the pair prices the reading of the shape rather than the work it makes.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SHAPES = new Set(['single-return', 'multi-return', 'computed-key', 'relay']);
const [shape, directory, count = '300'] = process.argv.slice(2);

if (!SHAPES.has(shape) || !directory) {
  console.error(`usage: node bench/synthetic.mjs <${[...SHAPES].join('|')}> <directory> [files]`);
  process.exit(2);
}

const files = Number(count);
const source = join(directory, 'src');
rmSync(directory, { recursive: true, force: true });
mkdirSync(source, { recursive: true });

writeFileSync(
  join(directory, 'tsconfig.json'),
  `${JSON.stringify(
    { compilerOptions: { target: 'ES2022', module: 'commonjs', strict: true, skipLibCheck: true }, include: ['src'] },
    null,
    2
  )}\n`
);

/** Twelve keys a run has to answer for, four of them read. */
const singleReturn = i => `export function box${i}() {
  return {
${Array.from({ length: 12 }, (_, k) => `    key${k}: ${k},`).join('\n')}
  };
}

export const read${i} = box${i}().key0 + box${i}().key1 + box${i}().key2 + box${i}().key3;
`;

/** The same twelve keys, split across three branches of one return value. */
const multiReturn = i => `export function box${i}(mode: number) {
  if (mode === 0) {
    return {
${Array.from({ length: 4 }, (_, k) => `      key${k}: ${k},`).join('\n')}
    };
  }
  if (mode === 1) {
    return {
${Array.from({ length: 4 }, (_, k) => `      key${k + 4}: ${k},`).join('\n')}
    };
  }
  return {
${Array.from({ length: 4 }, (_, k) => `    key${k + 8}: ${k},`).join('\n')}
  };
}

export const read${i} = box${i}(0).key0 + box${i}(1).key4 + box${i}(2).key8;
`;

const computedKey = i => `interface Row${i} {
${Array.from({ length: 12 }, (_, k) => `  key${k}: number;`).join('\n')}
}

export function total${i}(rows: Row${i}[], at: number): number {
  let sum = 0;
${Array.from({ length: 12 }, (_, k) => `  sum += rows[at + ${k}].key${k};`).join('\n')}
  return sum;
}
`;

const relay = i => `interface Row${i} {
${Array.from({ length: 12 }, (_, k) => `  key${k}: number;`).join('\n')}
}

function dump${i}<T extends object>(value: T): string[] {
  return Object.keys(value);
}

export function render${i}(row: Row${i}): number {
  return row.key0 + dump${i}(row).length;
}
`;

const bodies = { 'single-return': singleReturn, 'multi-return': multiReturn, 'computed-key': computedKey, relay };
for (let i = 0; i < files; i++) writeFileSync(join(source, `mod${i}.ts`), bodies[shape](i));
writeFileSync(
  join(source, 'index.ts'),
  `${Array.from({ length: files }, (_, i) => `import './mod${i}';`).join('\n')}\n`
);

console.log(`${shape}: ${files} files in ${directory}`);
