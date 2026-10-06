/** @jest-environment node */
import { runTrace } from '@/core/replay/runTrace';
import { TRACE_BUILDERS, serializeTrace } from '@/core/replay/synth';
import { parseTrace } from '@/core/replay/trace';

declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the root tsconfig has no Node typings
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

test('every builder has a fixture on disk and vice versa', () => {
  expect(names).toEqual(Object.keys(TRACE_BUILDERS).sort());
  expect(names.length).toBeGreaterThanOrEqual(20);
});

test.each(names)('%s replays to the events it expects', (name) => {
  const result = runTrace(load(name));
  expect(result.failures).toEqual([]);
  expect(result.passes).toBe(true);
});

test.each(names)('%s on disk is exactly what the generator writes', (name) => {
  expect(text(name)).toBe(serializeTrace(TRACE_BUILDERS[name]!()));
});

test.each(names)('%s is a 1 Hz drive that asserts something', (name) => {
  const trace = load(name);
  expect(trace.name).toBe(name);
  expect(trace.rows.length).toBeGreaterThanOrEqual(120);
  expect(trace.expected.length).toBeGreaterThan(0);
  const gaps = new Set(trace.rows.slice(1).map((r, i) => r.ts - trace.rows[i]!.ts));
  expect([...gaps]).toEqual([1000]);
});

test('parseTrace refuses an unknown key and a bad expectation', () => {
  const ok = TRACE_BUILDERS['clean-commute']!();
  expect(() => parseTrace({ ...ok, bogus: 1 })).toThrow(/Invalid trace/);
  expect(() => parseTrace({ ...ok, expected: [{ type: 'speeding', startsNear: 1, status: 'scored' }] })).toThrow(/Invalid trace/);
});
