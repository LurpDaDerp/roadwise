/** @jest-environment node */
// The self-test protocol (README §Self-test): native returns its outputs for the vectors, JS diffs
// them against each vector's `expected` field by field within SELF_TEST_TOLERANCE.
import { SELF_TEST_TOLERANCE } from '../src/extract/constants';
import { runSelfTest, type ExtractVector, type GoldenVector } from '../src/extract/vectors';
import { diffSelfTest, parseVectors } from '../src/selfTest';
import { VECTOR_BUILDERS, VECTOR_NAMES } from '../scripts/scenarios';

const vectors: GoldenVector[] = VECTOR_NAMES.map((n) => VECTOR_BUILDERS[n]());
const clean = () => runSelfTest(vectors, 'ios');

test('the reference against itself is clean', () => {
  const diff = diffSelfTest(vectors, JSON.stringify(clean()));
  expect(diff.ok).toBe(true);
  expect(diff.results).toHaveLength(9);
  expect(diff.results.every((r) => r.ok && r.mismatches.length === 0)).toBe(true);
  expect(diff.platform).toBe('ios');
});

test('a difference within tolerance passes; one beyond it is named by path', () => {
  const out = clean();
  const r = out.results[VECTOR_NAMES.indexOf('hard-brake')]!;
  if (!('rows' in r)) throw new Error('expected rows');
  const row = r.rows[8]!;
  row.aLonMin += SELF_TEST_TOLERANCE / 2;
  expect(diffSelfTest(vectors, JSON.stringify(out)).ok).toBe(true);
  row.aLonMin += SELF_TEST_TOLERANCE * 2;
  const diff = diffSelfTest(vectors, JSON.stringify(out));
  expect(diff.ok).toBe(false);
  const bad = diff.results.find((x) => x.name === 'hard-brake')!;
  expect(bad.mismatches).toEqual([
    { path: 'rows[8].aLonMin', expected: expect.any(Number), actual: expect.any(Number) },
  ]);
});

test('booleans, integers and gravity-filter samples are compared too', () => {
  const out = clean();
  const noImu = out.results[VECTOR_NAMES.indexOf('no-imu')]!;
  const gf = out.results[VECTOR_NAMES.indexOf('gravity-filter')]!;
  if (!('rows' in noImu) || !('batches' in gf)) throw new Error('shape');
  noImu.rows[1]!.gnssValid = false;
  gf.batches[2]![3]!.g = [0, 0, 0];
  const diff = diffSelfTest(vectors, JSON.stringify(out));
  expect(diff.results.find((x) => x.name === 'no-imu')!.mismatches[0]!.path).toBe('rows[1].gnssValid');
  expect(diff.results.find((x) => x.name === 'gravity-filter')!.mismatches.map((m) => m.path)).toEqual([
    'batches[2][3].g[0]',
    'batches[2][3].g[1]',
    'batches[2][3].g[2]',
  ]);
});

test('a missing result, a native error, a length mismatch and a wrong kind all fail', () => {
  const out = clean();
  out.results = out.results.filter((r) => r.name !== 'cruise');
  const idx = out.results.findIndex((r) => r.name === 'corner-left');
  out.results[idx] = { name: 'corner-left', kind: 'extract', error: 'boom' };
  const pick = out.results.findIndex((r) => r.name === 'phone-pickup');
  const p = out.results[pick]!;
  if ('rows' in p) p.rows.pop();
  const gi = out.results.findIndex((r) => r.name === 'gravity-filter');
  out.results[gi] = { name: 'gravity-filter', kind: 'extract', rows: [] };
  const diff = diffSelfTest(vectors, JSON.stringify(out));
  expect(diff.ok).toBe(false);
  const by = (n: string) => diff.results.find((r) => r.name === n)!;
  expect(by('cruise').error).toMatch(/missing/);
  expect(by('corner-left').error).toBe('boom');
  expect(by('phone-pickup').error).toMatch(/length/);
  expect(by('gravity-filter').error).toMatch(/kind/);
});

test('iOS may skip the gravity-filter vector; Android may not, and nothing else may be skipped', () => {
  const skip = (platform: 'ios' | 'android', name: string) => {
    const out = runSelfTest(vectors, platform);
    const i = out.results.findIndex((r) => r.name === name);
    out.results[i] = { name, kind: 'gravityFilter', skipped: 'no gravity filter on iOS' };
    return diffSelfTest(vectors, JSON.stringify(out)).results.find((r) => r.name === name)!;
  };
  expect(skip('ios', 'gravity-filter')).toMatchObject({ ok: true, skipped: 'no gravity filter on iOS' });
  expect(skip('android', 'gravity-filter').ok).toBe(false);
  expect(skip('ios', 'cruise').ok).toBe(false);
});

test('mismatches are capped per vector', () => {
  const out = clean();
  const r = out.results[VECTOR_NAMES.indexOf('cruise')]!;
  if (!('rows' in r)) throw new Error('shape');
  for (const row of r.rows) {
    row.lat += 1;
    row.lng += 1;
    row.alt += 1;
  }
  const res = diffSelfTest(vectors, JSON.stringify(out)).results.find((x) => x.name === 'cruise')!;
  expect(res.ok).toBe(false);
  expect(res.mismatches.length).toBe(20);
  expect(res.mismatchCount).toBe(30);
});

test('unparseable output is a failure, not a throw', () => {
  const diff = diffSelfTest(vectors, 'not json');
  expect(diff.ok).toBe(false);
  expect(diff.error).toMatch(/output/);
  expect(diffSelfTest(vectors, '{"version":2,"results":[]}').error).toMatch(/version/);
});

test('parseVectors validates the vector files', () => {
  const v = vectors[0] as ExtractVector;
  expect(parseVectors(JSON.stringify([v]))).toEqual([v]);
  expect(() => parseVectors('[{"name":"x","kind":"extract"}]')).toThrow(/vector/);
  expect(() => parseVectors('{}')).toThrow(/vector/);
});
