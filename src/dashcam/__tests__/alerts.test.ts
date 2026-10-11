import type { AlertPlayer } from '@/core/alerts/player';
import type { AlertDecision } from '@/core/alerts/types';

import { cadenceMs, createDashcamAlerts, REPEAT_INTENSITY, SOUND_SPEC, specFor } from '../alerts';

test('levels, tones, voices and first-play strengths per sound (plan §7.8)', () => {
  expect(SOUND_SPEC).toEqual({
    1: { level: 2, tone: 'dp_glance', voice: 'Eyes on the road', firstIntensity: 2 },
    2: { level: 3, tone: 'dp_drowsy', voice: 'Take a break', firstIntensity: 3 },
    3: { level: 3, tone: 'dp_wake', voice: 'Wake up', voiceAlways: true, firstIntensity: 4 },
    4: { level: 3, tone: 'dp_phone', voice: 'Phone down', firstIntensity: 3 },
    5: { level: 1, firstIntensity: 1 },
  });
  expect(REPEAT_INTENSITY).toBe(2);
  expect(specFor(99)).toBe(SOUND_SPEC[5]);
});

test('cadence: glance 2.5 s, drowsy 4 s, wake 1.5 → 1.25 → 1.0 s by level, phone 2.5 s', () => {
  expect(cadenceMs(1, 0)).toBe(2500);
  expect(cadenceMs(2, 3)).toBe(4000);
  expect([0, 1, 2, 3].map((l) => cadenceMs(3, l))).toEqual([1500, 1250, 1000, 1000]);
  expect(cadenceMs(4, 0)).toBe(2500);
});

test('a repeat queued before a stop is dropped unstarted (stillWanted); stop releases the held session', async () => {
  let now = 0;
  const delivered: AlertDecision[] = [];
  let stops = 0;
  const player: AlertPlayer = {
    deliver: async (d) => void delivered.push(d),
    stopCurrent: async () => void (stops += 1),
    announce: async () => {},
  };
  const acks: [number, number][] = [];
  const c = createDashcamAlerts({ player, now: () => now, sendAck: (id, o) => acks.push([id, o]), canPlay: () => true });
  expect(c.onAlert({ type: 'ALERT', alertId: 1, sound: 2, tier: 2, level: 0, mode: 1, route: 1, uptimeMs: 0 })).toBe(1);
  await c.settled();
  expect(delivered).toHaveLength(1);
  const first = delivered[0]!;
  expect(first.stillWanted?.()).toBe(true);
  c.onStop(1);
  expect(first.stillWanted?.()).toBe(false);
  expect(stops).toBe(1);
  now += 10_000;
  c.tick(now);
  await c.settled();
  expect(delivered).toHaveLength(1);
  expect(c.nextDueAt()).toBeNull();
  expect(acks).toEqual([]);
});

test('a stop for an unknown alert, a fallback for an unknown alert and a clear of an empty table are no-ops', () => {
  const player: AlertPlayer = { deliver: async () => {}, stopCurrent: async () => {}, announce: async () => {} };
  const c = createDashcamAlerts({ player, now: () => 0, sendAck: () => {}, canPlay: () => true });
  expect(() => {
    c.onStop(5);
    c.onFallback(5, 1);
    c.clear();
    c.playerUnavailable();
  }).not.toThrow();
  expect(c.continuousActive()).toBe(false);
});

test('the spoken words come from the string table', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the table itself
  const { en } = require('@/i18n/en') as typeof import('@/i18n/en');
  expect([en['dashpal.eyesOnRoad'], en['dashpal.takeABreak'], en['dashpal.wakeUp'], en['dashpal.phoneDown']]).toEqual([
    SOUND_SPEC[1]!.voice,
    SOUND_SPEC[2]!.voice,
    SOUND_SPEC[3]!.voice,
    SOUND_SPEC[4]!.voice,
  ]);
});
