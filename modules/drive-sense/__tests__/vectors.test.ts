/** @jest-environment node */
// The golden vectors the native ports must reproduce (R1). Committed JSON must be byte-for-byte a
// fresh generation, and every vector's `expected` must be what the reference computes from its
// `inputs` — so neither the files nor the reference can drift without this suite failing.
import { runVector, type GoldenVector } from '../src/extract/vectors';
import { parseRow, ROW_DECIMALS } from '../src/rowSchema';
import { parseVectors } from '../src/selfTest';
import type { FeatureRow } from '../src/types';
import { VECTOR_BUILDERS, VECTOR_NAMES, serializeVector } from '../scripts/scenarios';

/**
 * What the bridge must return for a golden row (ruling D2 concern 1), written out rather than
 * calling `roundTo`: each rounded field is `round(x · 10^d) / 10^d` and lies within half a step of
 * the input; every other field is the input exactly.
 */
function bridged(row: FeatureRow): FeatureRow {
  const out = { ...row };
  for (const [key, decimals] of Object.entries(ROW_DECIMALS) as [keyof typeof ROW_DECIMALS, number][]) {
    const value = Math.round(row[key] * 10 ** decimals) / 10 ** decimals;
    expect(Math.abs(value - row[key])).toBeLessThanOrEqual(0.5 * 10 ** -decimals + 1e-12);
    out[key] = value === 0 ? 0 : value;
  }
  return out;
}

// Jest compiles this suite to CommonJS, so `__dirname` and `require` are real at run time. The root
// tsconfig's `types` is ["jest"], so Node's own typings are not in the program — hence the local
// shapes rather than an `import` from 'node:fs'.
declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- see above: `import` would need @types/node
const { readdirSync, readFileSync } = require('node:fs') as {
  readdirSync: (dir: string) => string[];
  readFileSync: (file: string, encoding: 'utf8') => string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const { join } = require('node:path') as { join: (...parts: string[]) => string };

const DIR = join(__dirname, '..', 'assets', 'vectors');
const onDisk = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .sort();
const text = (name: string): string => readFileSync(join(DIR, `${name}.json`), 'utf8');

test('the nine vectors of the brief plus android-raw (review I1) are on disk, one builder each', () => {
  expect(onDisk).toEqual([
    'android-raw',
    'corner-left',
    'cruise',
    'gravity-filter',
    'hard-brake',
    'mount-shift',
    'no-imu',
    'phone-pickup',
    'turn-lagged-course',
    'unaligned-start',
  ]);
  expect(onDisk).toEqual(VECTOR_NAMES);
});

describe.each(VECTOR_NAMES)('%s', (name) => {
  const raw = text(name);
  const vector = parseVectors(`[${raw}]`)[0] as GoldenVector;

  test('the committed file is exactly a fresh generation', () => {
    expect(raw).toBe(serializeVector(VECTOR_BUILDERS[name]()));
  });

  test('expected equals the reference over the inputs', () => {
    const out = runVector(vector);
    if (vector.kind === 'gravityFilter') expect(out).toEqual({ name, kind: 'gravityFilter', batches: vector.expected.batches });
    else expect(out).toEqual({ name, kind: vector.kind, rows: vector.expected.rows });
  });

  test('at most 10 s of 25 Hz input', () => {
    if (vector.kind === 'extract') {
      expect(vector.inputs.seconds.length).toBeLessThanOrEqual(10);
      for (const s of vector.inputs.seconds) expect(s.imu.length).toBeLessThanOrEqual(25);
      for (const row of vector.expected.rows) expect(parseRow(row)).toEqual(bridged(row));
    } else if (vector.kind === 'androidRaw') {
      expect(vector.inputs.seconds.length).toBeLessThanOrEqual(10);
      for (const s of vector.inputs.seconds) expect(s.raw.length).toBeLessThanOrEqual(25);
      for (const row of vector.expected.rows) expect(parseRow(row)).toEqual(bridged(row));
    } else {
      expect(vector.inputs.batches.flat().length).toBeLessThanOrEqual(250);
    }
  });
});

test('the bundle stays small (under 450 KB for all ten)', () => {
  const bytes = VECTOR_NAMES.reduce((n, name) => n + text(name).length, 0);
  expect(bytes).toBeLessThan(450_000);
});
