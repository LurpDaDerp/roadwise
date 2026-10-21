import { LIMIT_HOLD_MS, nextDisplayLimit, NO_DISPLAY_LIMIT, type DisplayLimit } from '@/core/engine/displayLimit';

/** One row a second from t = 0: each the row's own limit (null: none); the sign after each. */
function run(limits: (number | null)[]): (number | null)[] {
  let d: DisplayLimit = NO_DISPLAY_LIMIT;
  return limits.map((mph, i) => {
    d = nextDisplayLimit(d, i * 1000, mph);
    return d.mph;
  });
}

test('a limit shows at once; a new one replaces it at once', () => {
  expect(LIMIT_HOLD_MS).toBe(10_000);
  expect(run([35, 35, 45, 25])).toEqual([35, 35, 45, 25]);
});

test('a row without one keeps the last limit up for 10 s, then "-"', () => {
  const out = run([35, ...Array<null>(11).fill(null)]);
  expect(out.slice(0, 11)).toEqual(Array<number>(11).fill(35));
  expect(out[11]).toBeNull();
});

test('a new limit during the hold shows at once and starts the hold again', () => {
  const out = run([35, null, null, 45, ...Array<null>(10).fill(null), null]);
  expect(out[3]).toBe(45);
  expect(out[13]).toBe(45);
  expect(out[14]).toBeNull();
});

test('nothing before the first limit; an unchanged value is the same object', () => {
  expect(run([null, null])).toEqual([null, null]);
  const a = nextDisplayLimit(NO_DISPLAY_LIMIT, 0, null);
  expect(a).toBe(NO_DISPLAY_LIMIT);
});
