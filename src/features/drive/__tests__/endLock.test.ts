// End drive's lock at speed (modes plan §3.6): locked at 15 mph and over, back under 10, an unknown
// speed holds.
import { AUTO_TRIGGER, MANUAL_TRIGGER } from '@drive-sense';

import { END_LOCK_MPH, END_UNLOCK_MPH, nextEndLock } from '../endLock';

test('the numbers are the two triggers: locked from the automatic one (15 mph), free under the manual one (10 mph)', () => {
  expect(END_LOCK_MPH).toBe(15);
  expect(END_UNLOCK_MPH).toBe(10);
  expect(END_LOCK_MPH).toBe(AUTO_TRIGGER.mph);
  expect(END_UNLOCK_MPH).toBe(MANUAL_TRIGGER.mph);
});

test('free, it locks at 15 mph and over, never under', () => {
  expect(nextEndLock(false, 0)).toBe(false);
  expect(nextEndLock(false, 14.9)).toBe(false);
  expect(nextEndLock(false, 15)).toBe(true);
  expect(nextEndLock(false, 70)).toBe(true);
});

test('locked, it stays so down to 10 mph and comes back under 10', () => {
  expect(nextEndLock(true, 14)).toBe(true);
  expect(nextEndLock(true, 10)).toBe(true);
  expect(nextEndLock(true, 9.9)).toBe(false);
  expect(nextEndLock(true, 0)).toBe(false);
});

test('an unknown speed holds the last answer', () => {
  expect(nextEndLock(true, null)).toBe(true);
  expect(nextEndLock(false, null)).toBe(false);
  expect(nextEndLock(true, Number.NaN)).toBe(true);
});

test('a car hovering between 10 and 15 never flickers it', () => {
  let locked = false;
  const seen: boolean[] = [];
  for (const mph of [5, 12, 16, 14, 11, 13, 10.5, 9.5, 12, 14.9]) {
    locked = nextEndLock(locked, mph);
    seen.push(locked);
  }
  expect(seen).toEqual([false, false, true, true, true, true, true, false, false, false]);
});
