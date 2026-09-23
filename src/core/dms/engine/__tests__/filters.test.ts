// Median3 (plan §M2): a median of the last three values within a quality run, reset on a quality change.
import { Median3 } from '../filters';

test('the median of the last three', () => {
  const m = new Median3();
  expect(m.push(10)).toBe(10); // one value: itself
  expect(m.push(20)).toBe(15); // two: their mean
  expect(m.push(100)).toBe(20); // three: the median, so one outlier is removed
  expect(m.push(21)).toBe(21); // the window slides: [20, 100, 21]
  expect(m.push(-50)).toBe(21); // [100, 21, -50]
  expect(m.push(22)).toBe(21); // [21, -50, 22]
});

test('a one-frame spike never passes; a step passes after two frames (lag ≤ 1 frame)', () => {
  const m = new Median3();
  const out = [0, 0, 0, 30, 0, 0, 30, 30, 30].map((v) => m.push(v));
  expect(out).toEqual([0, 0, 0, 0, 0, 0, 0, 30, 30]);
});

test('reset starts a new run', () => {
  const m = new Median3();
  m.push(5);
  m.push(6);
  m.push(7);
  m.reset();
  expect(m.size).toBe(0);
  expect(m.push(100)).toBe(100);
});

test('a non-finite value resets the run and is returned as is', () => {
  const m = new Median3();
  m.push(1);
  m.push(2);
  expect(m.push(Number.NaN)).toBeNaN();
  expect(m.size).toBe(0);
  expect(m.push(9)).toBe(9);
});
