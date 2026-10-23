// The driving screen's words (modes plan §3.18): short while moving, nothing about points, no em
// dashes or exclamation marks.
import { spotsCopy } from '@/features/spots/copy';

import { hudCopy } from '../hudCopy';

const words = (s: string) => s.trim().split(/\s+/).length;

/** Every string in the copy, functions called with a sample value. */
function strings(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (typeof v === 'function') return [...strings((v as (x: unknown) => unknown)(3)), ...strings((v as (x: unknown) => unknown)('km'))];
  if (v !== null && typeof v === 'object') return Object.values(v).flatMap(strings);
  return [];
}

test('an alert chip for each of the seven event types, three words at most; a phone pickup says "Phone down"', () => {
  expect(Object.keys(hudCopy.alert).sort()).toEqual(['drowsy', 'eyes_off', 'hard_accel', 'hard_brake', 'hard_corner', 'phone_pickup', 'speeding']);
  expect(hudCopy.alert.phone_pickup).toBe('Phone down');
  expect(hudCopy.alert.speeding).toBe('Slow down');
  for (const w of Object.values(hudCopy.alert)) expect(words(w)).toBeLessThanOrEqual(3);
});

test("a spot's nudge is four words at most, one per kind, the spot sheet's own line", () => {
  expect(hudCopy.spot).toBe(spotsCopy.nudge);
  expect(Object.keys(hudCopy.spot).sort()).toEqual(['hard_accel', 'hard_brake', 'hard_corner', 'speeding']);
  for (const w of Object.values(hudCopy.spot)) expect(words(w)).toBeLessThanOrEqual(4);
  expect(hudCopy.spot.speeding).toBe('Watch your speed here');
});

test('what shows while moving is three words at most: End, its failure, the link', () => {
  for (const w of [hudCopy.end, hudCopy.ending, hudCopy.endFailed, hudCopy.notDriving, hudCopy.cancel]) expect(words(w)).toBeLessThanOrEqual(3);
});

test('End names where it comes back, in the driver units', () => {
  expect(hudCopy.endLockedHint('mi')).toBe('Available below 10 mph.');
  expect(hudCopy.endLockedHint('km')).toBe('Available below 16 km/h.');
});

test('the words of the waiting screen', () => {
  expect(hudCopy.waiting).toEqual({ title: 'Ready to roll', line: 'Saved once you drive', spoken: "Ready to roll. Recording now; the drive is saved once you're driving." });
  expect(hudCopy.ask.title).toBe('Still planning to drive?');
  expect(hudCopy.ask.body(3)).toBe("We'll stop waiting in 3 min.");
  expect(hudCopy.countdown.spoken(27)).toBe('Stopping in 27 seconds. Touch the screen to keep waiting.');
});

test('nothing about points, no em dash, no exclamation mark; the phone only in the pickup chip', () => {
  const all = strings(hudCopy);
  expect(all.length).toBeGreaterThan(30);
  for (const s of all) {
    expect({ s, bad: /\bpoints?\b|\bpts\b|streak|leaderboard/i.test(s) }).toEqual({ s, bad: false });
    expect({ s, bad: /phone/i.test(s) && s !== hudCopy.alert.phone_pickup }).toEqual({ s, bad: false });
    expect(s).not.toMatch(/[—!]/);
  }
});
