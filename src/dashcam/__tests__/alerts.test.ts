import type { AlertPlayer } from '@/core/alerts/player';
import type { AlertDecision } from '@/core/alerts/types';

import { cadenceMs, createDashcamAlerts, NO_FACE_VOICE_QUIET_MS, REPEAT_INTENSITY, SOUND_SPEC, specFor } from '../alerts';

test('levels, tones, voices and first-play strengths per sound (plan §7.8)', () => {
  expect(SOUND_SPEC).toEqual({
    1: { level: 2, tone: 'dp_glance', voice: 'Eyes on the road', firstIntensity: 2 },
    2: { level: 3, tone: 'dp_drowsy', voice: 'Take a break', firstIntensity: 3 },
    3: { level: 3, tone: 'dp_wake', voice: 'Wake up', voiceAlways: true, firstIntensity: 4 },
    4: { level: 3, tone: 'dp_phone', voice: 'Phone down', firstIntensity: 3 },
    5: { level: 1, firstIntensity: 1 },
    6: { level: 2, tone: 'dp_glance', voice: 'Driver not visible', firstIntensity: 2 },
  });
  expect(REPEAT_INTENSITY).toBe(2);
  expect(specFor(99)).toBe(SOUND_SPEC[5]);
});

test('cadence: glance 2.5 s, drowsy 4 s, wake 1.5 → 1.25 → 1.0 s by level, phone 2.5 s, no face 5 s', () => {
  expect(cadenceMs(1, 0)).toBe(2500);
  expect(cadenceMs(2, 3)).toBe(4000);
  expect([0, 1, 2, 3].map((l) => cadenceMs(3, l))).toEqual([1500, 1250, 1000, 1000]);
  expect(cadenceMs(4, 0)).toBe(2500);
  expect(cadenceMs(6, 0)).toBe(5000);
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
  expect([en['dashpal.eyesOnRoad'], en['dashpal.takeABreak'], en['dashpal.wakeUp'], en['dashpal.phoneDown'], en['dashpal.driverNotVisible']]).toEqual([
    SOUND_SPEC[1]!.voice,
    SOUND_SPEC[2]!.voice,
    SOUND_SPEC[3]!.voice,
    SOUND_SPEC[4]!.voice,
    SOUND_SPEC[6]!.voice,
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

describe('the no-face alert (sound 6)', () => {
  function rig() {
    const clock = { now: 0 };
    const delivered: { at: number; d: AlertDecision }[] = [];
    const flashed: number[] = [];
    const player: AlertPlayer = {
      deliver: async (d) => void delivered.push({ at: clock.now, d }),
      stopCurrent: async () => {},
      announce: async () => {},
    };
    const c = createDashcamAlerts({ player, now: () => clock.now, sendAck: () => {}, canPlay: () => true, onVisual: (v) => flashed.push(v.alertId) });
    const alert = (alertId: number, sound = 6) => c.onAlert({ type: 'ALERT', alertId, sound, tier: 2, level: 0, mode: 1, route: 1, uptimeMs: 0 });
    /** run the clock to `to` in 100 ms steps, as the link's tick does */
    async function runTo(to: number) {
      while (clock.now < to) {
        clock.now = Math.min(to, clock.now + 100);
        c.tick(clock.now);
        await c.settled();
      }
    }
    return { clock, delivered, flashed, c, alert, runTo };
  }

  test('plays the glance tone, says "Driver not visible" on the first play only, repeats every 5 s, never holds the session, and leaves the phone’s own tones on', async () => {
    const r = rig();
    expect(r.alert(1)).toBe(1);
    await r.c.settled();
    await r.runTo(10_000);
    expect(r.delivered.map((x) => [x.at, x.d.tone, x.d.voice ?? null, x.d.intensity, x.d.holdSession ?? false, x.d.level])).toEqual([
      [0, 'dp_glance', 'Driver not visible', 2, false, 2],
      [5000, 'dp_glance', null, 2, false, 2],
      [10_000, 'dp_glance', null, 2, false, 2],
    ]);
    expect(r.delivered[0]!.d.voiceAlways).toBeUndefined(); // follows the voice setting
    expect(r.c.continuousActive()).toBe(false);
    expect(r.c.playingAny()).toBe(true);
    // A glance warning beside it still counts as continuous (and holds its session).
    r.alert(2, 1);
    await r.c.settled();
    expect(r.c.continuousActive()).toBe(true);
    expect(r.delivered.at(-1)!.d.holdSession).toBe(true);
  });

  test('a no-face alert within 60 s of the last one ending shows without its words; after 60 s it speaks again; a clear (disconnect, new boot) counts as an end', async () => {
    const r = rig();
    r.alert(1);
    await r.c.settled();
    r.clock.now = 7000;
    r.c.onStop(1);
    // 59.9 s after the end: no words, but it still plays and flashes.
    r.clock.now = 7000 + NO_FACE_VOICE_QUIET_MS - 100;
    r.alert(2);
    await r.c.settled();
    expect(r.delivered.at(-1)!.d).toMatchObject({ tone: 'dp_glance', intensity: 2 });
    expect(r.delivered.at(-1)!.d.voice).toBeUndefined();
    expect(r.flashed).toEqual([1, 2]); // the banner still shows
    // A clear ends it too; 60 s after that, the next one speaks.
    r.c.clear();
    // 1 s after the clear (60.9 s after the stop): still no words, so the clear counted as an end.
    r.clock.now += 1000;
    r.alert(30);
    await r.c.settled();
    expect(r.delivered.at(-1)!.d).toMatchObject({ tone: 'dp_glance' });
    expect(r.delivered.at(-1)!.d.voice).toBeUndefined();
    r.c.clear();
    const clearedAt = r.clock.now;
    r.clock.now = clearedAt + NO_FACE_VOICE_QUIET_MS;
    r.alert(3);
    await r.c.settled();
    expect(r.delivered.at(-1)!.d.voice).toBe('Driver not visible');
    // Another sound's end does not quiet it, and its own words are unaffected.
    r.c.onStop(3);
    r.clock.now += NO_FACE_VOICE_QUIET_MS;
    r.alert(4, 1);
    await r.c.settled();
    r.c.onStop(4);
    r.alert(5);
    await r.c.settled();
    expect(r.delivered.at(-1)!.d.voice).toBe('Driver not visible');
  });
});

describe('held and since (the HUD halo, drive-screen design §5.3)', () => {
  const player: AlertPlayer = { deliver: async () => {}, stopCurrent: async () => {}, announce: async () => {} };
  const make = (now: () => number, visuals: import('../alerts').DashcamVisual[] = []) =>
    createDashcamAlerts({ player, now, sendAck: () => {}, canPlay: () => true, onVisual: (v) => visuals.push(v) });
  const frame = (o: { id: number; sound: number; tier: number; level?: number; mode?: 0 | 1; route?: 0 | 1 }) => ({
    type: 'ALERT' as const,
    alertId: o.id,
    sound: o.sound,
    tier: o.tier,
    level: o.level ?? 0,
    mode: o.mode ?? 1,
    route: o.route ?? 1,
    uptimeMs: 0,
  });

  test('a one-shot is never held; a continuous alert is, also on route 0 (the buzzer plays it)', async () => {
    let now = 1000;
    const c = make(() => now);
    c.onAlert(frame({ id: 1, sound: 5, tier: 1, mode: 0 }));
    expect(c.held()).toBeNull();
    expect(c.continuing()).toEqual([]);
    now = 2000;
    c.onAlert(frame({ id: 2, sound: 1, tier: 2, route: 0 }));
    expect(c.held()).toEqual({ sound: 1, tier: 2, level: 0, since: 2000 });
    expect(c.continuing()).toEqual([{ alertId: 2, sound: 1, tier: 2, level: 0, since: 2000 }]);
    await c.settled();
  });

  test('the worst wins: the higher tier, then the higher level, then the earlier since', async () => {
    let now = 1000;
    const c = make(() => now);
    c.onAlert(frame({ id: 1, sound: 1, tier: 2, route: 0 }));
    now = 2000;
    c.onAlert(frame({ id: 2, sound: 6, tier: 2, route: 0 }));
    expect(c.held()).toMatchObject({ sound: 1, since: 1000 }); // same tier and level: the earlier
    c.onAlert(frame({ id: 2, sound: 6, tier: 2, level: 1, route: 0 }));
    expect(c.held()).toMatchObject({ sound: 6, level: 1, since: 2000 }); // a higher level
    now = 3000;
    c.onAlert(frame({ id: 3, sound: 3, tier: 3, route: 0 }));
    expect(c.held()).toEqual({ sound: 3, tier: 3, level: 0, since: 3000 }); // a higher tier
    c.onStop(3);
    expect(c.held()).toMatchObject({ sound: 6 });
    c.clear();
    expect(c.held()).toBeNull();
    await c.settled();
  });

  test('since holds through a level change; a stop empties it', async () => {
    let now = 1000;
    const c = make(() => now);
    c.onAlert(frame({ id: 4, sound: 3, tier: 3 }));
    now = 5000;
    c.onAlert(frame({ id: 4, sound: 3, tier: 3, level: 2 }));
    expect(c.held()).toEqual({ sound: 3, tier: 3, level: 2, since: 1000 });
    c.onStop(4);
    expect(c.held()).toBeNull();
    await c.settled();
  });

  test('the no-face alert is held as sound 6', async () => {
    const c = make(() => 0);
    c.onAlert(frame({ id: 9, sound: 6, tier: 2 }));
    expect(c.held()).toMatchObject({ sound: 6, tier: 2 });
    await c.settled();
  });

  test('inherit keeps since and flashes as a resend; a higher level than the dropped one, or no inherit, is news', async () => {
    const now = 9000;
    const visuals: import('../alerts').DashcamVisual[] = [];
    const c = make(() => now, visuals);
    c.onAlert(frame({ id: 1, sound: 1, tier: 2, route: 0 }), { since: 4000, level: 0 });
    expect(c.held()).toMatchObject({ since: 4000 });
    expect(visuals.at(-1)).toMatchObject({ alertId: 1, resend: true, at: 9000 });
    c.onAlert(frame({ id: 2, sound: 3, tier: 3, level: 2, route: 0 }), { since: 5000, level: 1 });
    expect(visuals.at(-1)).toMatchObject({ alertId: 2, resend: false });
    expect(c.continuing().find((e) => e.alertId === 2)).toMatchObject({ since: 5000 });
    c.onAlert(frame({ id: 3, sound: 2, tier: 3, route: 0 }));
    expect(visuals.at(-1)).toMatchObject({ alertId: 3, resend: false });
    // a level change of a resent alert is news
    c.onAlert(frame({ id: 1, sound: 1, tier: 2, level: 1, route: 0 }));
    expect(visuals.at(-1)).toMatchObject({ alertId: 1, level: 1, resend: false });
    await c.settled();
  });
});
