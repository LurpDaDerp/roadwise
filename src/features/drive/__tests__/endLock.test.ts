// End drive's lock at speed (modes plan §3.6): locked at 20 mph and over, back under 10, an unknown
// speed holds.
import { MANUAL_TRIGGER } from '@drive-sense';

import { END_LOCK_MPH, END_UNLOCK_MPH, nextEndLock } from '../endLock';

test('the numbers: locked from 20 mph, free under the Start card trigger (10 mph)', () => {
  expect(END_LOCK_MPH).toBe(20);
  expect(END_UNLOCK_MPH).toBe(10);
  expect(END_UNLOCK_MPH).toBe(MANUAL_TRIGGER.mph);
});

test('free, it locks at 20 mph and over, never under', () => {
  expect(nextEndLock(false, 0)).toBe(false);
  expect(nextEndLock(false, 19.9)).toBe(false);
  expect(nextEndLock(false, 20)).toBe(true);
  expect(nextEndLock(false, 70)).toBe(true);
});

test('locked, it stays so down to 10 mph and comes back under 10', () => {
  expect(nextEndLock(true, 19)).toBe(true);
  expect(nextEndLock(true, 10)).toBe(true);
  expect(nextEndLock(true, 9.9)).toBe(false);
  expect(nextEndLock(true, 0)).toBe(false);
});

test('an unknown speed holds the last answer', () => {
  expect(nextEndLock(true, null)).toBe(true);
  expect(nextEndLock(false, null)).toBe(false);
  expect(nextEndLock(true, Number.NaN)).toBe(true);
});

test('a car hovering between 10 and 20 never flickers it', () => {
  let locked = false;
  const seen: boolean[] = [];
  for (const mph of [5, 12, 21, 19, 11, 18, 10.5, 9.5, 12, 19.9]) {
    locked = nextEndLock(locked, mph);
    seen.push(locked);
  }
  expect(seen).toEqual([false, false, true, true, true, true, true, false, false, false]);
});
