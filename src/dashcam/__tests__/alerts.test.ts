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

test('while a DashPal item is in the player nothing else is due: a waiting first play or a past-due repeat never asks for a zero-delay wake; the settle hands them over', async () => {
  let now = 0;
  const delivered: AlertDecision[] = [];
  let hold: (() => void) | null = null;
  let holding = false;
  const player: AlertPlayer = {
    deliver: async (d) => {
      delivered.push(d);
      if (holding) await new Promise<void>((resolve) => (hold = resolve));
    },
    stopCurrent: async () => {},
    announce: async () => {},
  };
  const c = createDashcamAlerts({ player, now: () => now, sendAck: () => {}, canPlay: () => true });
  // A continuous glance plays once; its repeat is due 2.5 s after it started.
  c.onAlert({ type: 'ALERT', alertId: 1, sound: 1, tier: 2, level: 0, mode: 1, route: 1, uptimeMs: 0 });
  await c.settled();
  expect(delivered).toHaveLength(1);
  expect(c.nextDueAt()).toBe(2500);
  // A one-shot arrives and its first play is held in the player.
  holding = true;
  now = 1000;
  c.onAlert({ type: 'ALERT', alertId: 2, sound: 5, tier: 1, level: 0, mode: 0, route: 1, uptimeMs: 0 });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  expect(delivered.map((d) => d.id)).toEqual(['dashpal:1:1', 'dashpal:2:2']);
  // A level change on alert 3 (visual only) owes a haptic while 2 is still in the player.
  c.onAlert({ type: 'ALERT', alertId: 3, sound: 1, tier: 2, level: 0, mode: 1, route: 0, uptimeMs: 0 });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  c.onAlert({ type: 'ALERT', alertId: 3, sound: 1, tier: 2, level: 1, mode: 1, route: 0, uptimeMs: 0 });
  c.tick(now);
  // The future repeat is still due; nothing is due "now".
  expect(c.nextDueAt()).toBe(2500);
  now = 3000;
  c.tick(now);
  // The repeat is past due, but it cannot start until 2 settles: no wake.
  expect(c.nextDueAt()).toBeNull();
  holding = false;
  const release = hold as (() => void) | null;
  release?.();
  await c.settled();
  // 2 settled: alert 3's haptic (a first play wins), then 1's repeat.
  expect(delivered.map((d) => d.id)).toEqual(['dashpal:1:1', 'dashpal:2:2', 'dashpal:3:3', 'dashpal:1:4']);
});

test('every alert start or level change gets a visual key of its own, even when a rebooted dashcam reuses the alert id (ids restart at 1 each boot) or a new runtime starts', () => {
  const player: AlertPlayer = { deliver: async () => {}, stopCurrent: async () => {}, announce: async () => {} };
  const keys: string[] = [];
  const make = () => createDashcamAlerts({ player, now: () => 0, sendAck: () => {}, canPlay: () => true, onVisual: (v) => keys.push(v.key) });
  const a = make();
  a.onAlert({ type: 'ALERT', alertId: 1, sound: 1, tier: 2, level: 0, mode: 0, route: 0, uptimeMs: 0 });
  a.onAlert({ type: 'ALERT', alertId: 1, sound: 1, tier: 2, level: 1, mode: 0, route: 0, uptimeMs: 0 });
  // The dashcam reboots: a new connection clears the table, and its first alert is id 1 again.
  a.clear();
  a.onAlert({ type: 'ALERT', alertId: 1, sound: 1, tier: 2, level: 0, mode: 0, route: 0, uptimeMs: 0 });
  // A handover builds a new runtime (and link); the root banner outlives it.
  make().onAlert({ type: 'ALERT', alertId: 1, sound: 1, tier: 2, level: 0, mode: 0, route: 0, uptimeMs: 0 });
  expect(keys).toHaveLength(4);
  expect(new Set(keys).size).toBe(4);
});
