/** @jest-environment node */
import { row } from '@/core/detectors/__fixtures__/rows';
import { runTrace } from '@/core/replay/runTrace';
import { ROW_DEFAULTS, TRACE_BUILDERS, serializeTrace } from '@/core/replay/synth';
import { parseTrace } from '@/core/replay/trace';

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

const DIR = join(__dirname, '..', '..', '__fixtures__', 'traces');
const names = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .sort();
const text = (name: string): string => readFileSync(join(DIR, `${name}.json`), 'utf8');
const load = (name: string) => parseTrace(JSON.parse(text(name)));

test('the seven traces of the brief are on disk, one builder each', () => {
  expect(names).toEqual([
    'clean-commute',
    'hard-brake-agreeing',
    'mounted-app-switch',
    'phone-pickup',
    'phone-slide-false-positive',
    'speeding-corrected',
    'stopped-phone-use',
  ]);
  expect(Object.keys(TRACE_BUILDERS).sort()).toEqual(names);
});

test.each(names)('%s replays to the events it expects', (name) => {
  const result = runTrace(load(name));
  expect(result.failures).toEqual([]);
  expect(result.passes).toBe(true);
});

test.each(names)('%s on disk is exactly what the generator writes', (name) => {
  // `npm run traces:make` regenerates these files from the same builders; if this fails, either
  // the fixture was hand-edited or the generator changed and the fixtures were not regenerated.
  expect(text(name)).toBe(serializeTrace(TRACE_BUILDERS[name]!()));
});

test.each(names)('%s is a named 1 Hz drive of at least 120 rows that asserts something', (name) => {
  const trace = load(name);
  expect(trace.name).toBe(name);
  expect(trace.rows.length).toBeGreaterThanOrEqual(120);
  expect(trace.expected.length).toBeGreaterThan(0);
  const gaps = new Set(trace.rows.slice(1).map((r, i) => r.ts - trace.rows[i]!.ts));
  expect([...gaps]).toEqual([1000]);
});

test.each(names)('%s drives a straight line away from Seattle', (name) => {
  const trace = load(name);
  const first = trace.rows[0]!;
  const last = trace.rows[trace.rows.length - 1]!;
  expect(first.lat).toBeCloseTo(47.6062, 4);
  expect(new Set(trace.rows.map((r) => r.lat)).size).toBe(1);
  expect(last.lng).toBeGreaterThan(first.lng);
  expect(trace.rows.every((r) => r.speed >= 0 && r.speed < 40)).toBe(true);
});

test('the synthetic rows carry the same sensor defaults as the detector fixtures', () => {
  // The traces are only a regression suite if a quiet second looks exactly like the quiet second
  // the detector unit tests use.
  const quiet = row();
  const shared = Object.fromEntries(
    Object.keys(ROW_DEFAULTS).map((k) => [k, quiet[k as keyof typeof quiet]])
  );
  expect(ROW_DEFAULTS).toEqual(shared);
});
