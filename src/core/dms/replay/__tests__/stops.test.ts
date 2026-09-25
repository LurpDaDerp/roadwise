// Task C2 (calib-parked design rev4 §2.1.3, §2.1.7–§2.1.9, §2.3.6; rev5 §2, §4.4; amendment W4): the engine
// at stops. The sleep family runs at every speed and no stop ends a sleep-origin Critical; a D4-origin
// Critical ends after 5 s STOPPED; stop-time sleep events sound and are marked, and what they feed is
// `fatigue.stopEventsFeed` (U-14). Every drive runs through the engine façade with motion evidence on its
// rows (the host's `RowExtras.motion`). The looking-down latch is tested in fastRules.test.ts; the reading
// drives with the synth lid coupling (S-STOP-READ-EYEMOVER-40/-45, S-READING-40/-45) are T7's (rev5 §5).
import { DEFAULT_DMS_CONFIG, resolveDmsConfig, type DmsConfig } from '../../engine/config';
import type { DmsAlertCommand } from '../../engine/alerts';
import { feedsDrowsinessScore, type DmsEvent } from '../../engine/engine';
import { DEFAULT_INIT, replayItems, type ReplayResult } from '../run';
import { blinkOpenness, onRoad, rel, synthDrive, type DriverFn, type DriverState } from '../synth';

const C = DEFAULT_DMS_CONFIG as DmsConfig;
const feed = (v: 'none' | 'long_and_nod' | 'all') => resolveDmsConfig({ fatigue: { stopEventsFeed: v } });

/** Attentive at 60 km/h with natural blinks (200 ms every 4 s at 0.7 + 4k s), with `over` on top. */
function drv(over: (t: number, r: () => number) => Partial<DriverState> | null): DriverFn {
  return (t, r) => {
    const base: DriverState = { gaze: onRoad(r), openness: blinkOpenness(t), speedKmh: 60 };
    const o = over(t, r);
    return o === null ? base : { ...base, ...o };
  };
}

function play(driver: DriverFn, seconds: number, o: { fps?: number; cfg?: DmsConfig; lidGaze?: boolean; seed?: number } = {}): ReplayResult {
  // C7 round 3 (review-C7 R2-S): the eye's per-frame EAR noise (σ 0.03 openness), so the deep threshold meets a noisy lid.
  const items = synthDrive({ fps: o.fps ?? 15, seconds, seed: o.seed ?? 1, source: 'geometric', driver, motion: true, lidGaze: o.lidGaze, lidNoise: 0.03 });
  return replayItems(items, o.cfg ?? C, DEFAULT_INIT, { keepOpen: true });
}

const tier3 = (r: { commands: DmsAlertCommand[] }) => r.commands.filter((c) => c.tier === 3);
const sig3 = (r: { commands: DmsAlertCommand[] }) => tier3(r).map((c) => `${c.action}:${c.kind}`);
/** Is a Critical sounding at `tMs` (the last tier-3 command at or before it was a start)? */
function critRunning(cmds: readonly DmsAlertCommand[], tMs: number): boolean {
  let on = false;
  for (const c of cmds) {
    if (c.tMs > tMs) break;
    if (c.tier === 3) on = c.action === 'start';
  }
  return on;
}
const within = (t: number, a: number, b: number) => t >= a && t < b;
const GNSS: Partial<DriverState> = { speedKmh: 0 };
const SENSOR: Partial<DriverState> = { speedKmh: null, motion: { stop: 'sensor', quiet: true } };
const fEvents = (r: ReplayResult) => r.events.filter((e) => e.kind === 'microsleep' || e.kind === 'sleep' || e.kind === 'microsleep_nod');

describe('S-SLEEP-AT-LIGHT: the sleep family sounds at a light, and open eyes looking anywhere clear it', () => {
  // Stopped from 95 s; eyes shut 109.5–113.0 s (F1 at about 111.0: C7 round 2, at a stop every closure counts deep-only,
  // F1 at 1.5 s; F2 at 112.5); then awake, looking around.
  const atLight = (stop: Partial<DriverState>) =>
    drv((t) => (t < 95 ? null : within(t, 109.5, 113) ? { ...stop, openness: 0.1 } : t >= 113 ? { ...stop, gaze: rel(40, 0) } : { ...stop }));
  test.each([
    ['a GNSS stop', GNSS],
    ['a sensor stop', SENSOR],
  ])('%s: F1 then F2 sound; eyes open 1 s off the road ends it (NC-E1, NC-E3)', (_, stop) => {
    const r = play(atLight(stop), 120);
    expect(sig3(r)).toEqual(['start:microsleep', 'stop:microsleep', 'start:sleep', 'stop:sleep']);
    const [f1, , f2, end] = tier3(r);
    expect(f1!.tMs).toBeGreaterThanOrEqual(110_900);
    expect(f1!.tMs).toBeLessThanOrEqual(111_200);
    expect(f2!.tMs).toBeGreaterThanOrEqual(112_400);
    expect(f2!.tMs).toBeLessThanOrEqual(112_700);
    expect(end!.tMs - 113_000).toBeGreaterThanOrEqual(900);
    expect(end!.tMs - 113_000).toBeLessThanOrEqual(1300);
    const fs = fEvents(r);
    expect(fs.length).toBeGreaterThanOrEqual(2);
    for (const e of fs) expect(e).toMatchObject({ stopped: true });
    expect(r.invariantViolations).toBe(0);
  });
});

describe('S-CRIT-STOP-SLEEP: no stop ends a sleep Critical', () => {
  // Eyes shut from 101 s at 60 km/h; the car stops at 103 s; the eyes open at 117 s.
  const drive = (stop: Partial<DriverState>) => drv((t) => ({ ...(t >= 103 ? stop : {}), ...(within(t, 101, 117) ? { openness: 0.1 } : {}) }));
  test.each([
    ['a GNSS stop', GNSS],
    ['a sensor stop', SENSOR],
  ])('%s (NC-E2): the Critical sounds from F1 to the eyes opening, then ends on the clear', (_, stop) => {
    const r = play(drive(stop), 125);
    const first = tier3(r)[0]!;
    expect(first).toMatchObject({ action: 'start', kind: 'microsleep' });
    for (let t = first.tMs; t < 117_000; t += 250) expect({ t, running: critRunning(r.commands, t) }).toEqual({ t, running: true });
    expect(critRunning(r.commands, 119_000)).toBe(false);
    expect(tier3(r).at(-1)!.tMs).toBeGreaterThanOrEqual(117_000);
  });
});

describe('S-CREEP-ASLEEP: F2 at 7 km/h with a fix is STOPPED: it sounds, and it is stop-time (rev5 §4.4)', () => {
  test('sleep sounds; the F2 event and its episode_end are stop-time, at level f2', () => {
    const r = play(
      drv((t) => (t < 95 ? null : { speedKmh: 7, ...(within(t, 109.5, 113.3) ? { openness: 0.1 } : {}) })),
      118
    );
    expect(sig3(r)).toContain('start:sleep');
    expect(r.events.find((e) => e.kind === 'sleep')).toMatchObject({ stopped: true });
    expect(r.events.find((e) => e.kind === 'episode_end')).toMatchObject({ stopped: true, level: 'f2' });
  });
});

describe('S-NOD-STOP-5FPS: a nod-off at a light at 5 fps, through the Median3 smoothing', () => {
  // A 0.4 s drop of 25°, a 0.4 s hold, a 0.3 s recovery; the lids deep (0.05) for 0.8 s of it: no F1.
  const nod: DriverFn = drv((t) => {
    if (t < 95) return null;
    const k = t - 100;
    if (k < 0 || k >= 1.2) return { speedKmh: 0 };
    const pitch = k < 0.4 ? (-25 * k) / 0.4 : k < 0.8 ? -25 : k < 1.1 ? -25 + (25 * (k - 0.8)) / 0.3 : 0;
    return { speedKmh: 0, head: { yaw: 0.8, pitch: -1.2 + pitch }, gaze: rel(0, pitch), openness: k >= 0.35 && k < 1.15 ? 0.05 : 0.4 };
  });
  test('microsleep_nod fires at 0 km/h, marked stop-time; no F1', () => {
    const r = play(nod, 106, { fps: 5 });
    const n = r.events.filter((e) => e.kind === 'microsleep_nod');
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ stopped: true });
    expect(r.events.map((e) => e.kind)).not.toContain('microsleep');
    expect(sig3(r)).toEqual(['start:microsleep_nod', 'stop:microsleep_nod']); // cleared by the eyes open (stopped)
  });
});

describe('S-D4-STOP: a D4-origin Critical ends after 5 s STOPPED', () => {
  // A lap glance from 100 s (D1 at 2.4 s, D4 3 s later); the car stops at 107 s, still looking down.
  const drive = (stop: Partial<DriverState>) => drv((t) => ({ ...(t >= 107 ? stop : {}), ...(within(t, 100, 115) ? { gaze: rel(0, -40) } : {}) }));
  test.each([
    ['a GNSS stop', GNSS],
    ['a sensor stop', SENSOR],
  ])('%s: it ends 5 s into the stop', (_, stop) => {
    const r = play(drive(stop), 118);
    expect(sig3(r)).toEqual(['start:unresponsive', 'stop:unresponsive']);
    const end = tier3(r)[1]!;
    expect(end.tMs).toBeGreaterThanOrEqual(111_900);
    expect(end.tMs).toBeLessThanOrEqual(112_200);
  });
});

describe('rev4 §2.1.10: while STOPPED the accounting is frozen (D4 does not count stop time)', () => {
  // A lap glance from 100 s gives D1 at about 102.4 s at 60 km/h; the car stops at 103 s with the driver
  // still looking down. Moving, D4 would fire 3 s after the warning; stopped, its time does not count, and the
  // pending D4 clears after 5 s of the stop.
  const drive = drv((t) => ({ ...(t >= 103 ? { speedKmh: 0 } : {}), ...(within(t, 100, 115) ? { gaze: rel(0, -40) } : {}) }));
  test('D1 sounds; no D4 and no Critical at the stop', () => {
    const r = play(drive, 118);
    expect(r.commands.map((c) => `${c.action}:${c.kind}`)).toContain('start:distraction');
    expect(r.events.map((e) => e.kind)).not.toContain('d4_unresponsive');
    expect(tier3(r)).toEqual([]);
  });
});

describe('S-D4-THEN-SLEEP-STOP: a D4 Critical, then the eyes shut: the stop does not end it', () => {
  // The lap glance (D4 at about 105.4 s), the eyes shut at 105.6 s until 121 s; the car stops at 108 s.
  const drive = drv((t) => ({ ...(t >= 108 ? { speedKmh: 0 } : {}), ...(within(t, 100, 121) ? { gaze: rel(0, -40) } : {}), ...(within(t, 105.6, 121) ? { openness: 0.1 } : {}) }));
  test('the Critical sounds from D4 to the eyes opening', () => {
    const r = play(drive, 128);
    const first = tier3(r)[0]!;
    expect(first).toMatchObject({ action: 'start', kind: 'unresponsive' });
    for (let t = first.tMs; t < 121_000; t += 250) expect({ t, running: critRunning(r.commands, t) }).toEqual({ t, running: true });
    expect(critRunning(r.commands, 124_000)).toBe(false);
  });
});

describe('S-STOP-REST-TWICE (U-14): F1 at two lights sounds both times; what it feeds is stopEventsFeed', () => {
  // Stopped 100–130 s and 200–230 s; the eyes shut 2 s at each light (C7 round 2: a stop's F1 needs 1.5 s deep).
  const drive = drv((t) => ({ ...(within(t, 100, 130) || within(t, 200, 230) ? { speedKmh: 0 } : {}), ...(within(t, 109.5, 111.5) || within(t, 209.5, 211.5) ? { openness: 0.1 } : {}) }));
  const levelsAfter = (r: ReplayResult, tMs: number) => r.events.filter((e) => e.kind === 'fatigue_minute' && e.tMs > tMs).map((e) => (e as { level: string }).level);
  test("'none' (the default): both sound; the fatigue level stays none (NC-S3)", () => {
    const r = play(drive, 250);
    expect(sig3(r)).toEqual(['start:microsleep', 'stop:microsleep', 'start:microsleep', 'stop:microsleep']);
    expect(fEvents(r).map((e) => (e as { stopped?: boolean }).stopped)).toEqual([true, true]);
    expect(levelsAfter(r, 211_000).length).toBeGreaterThan(0);
    expect(levelsAfter(r, 111_000).every((l) => l === 'none')).toBe(true);
    expect(r.summary.stopSleepEvents).toBe(2);
  });
  test("'long_and_nod': an eye rest of 2 s feeds nothing either", () => {
    const r = play(drive, 250, { cfg: feed('long_and_nod') });
    expect(sig3(r)).toHaveLength(4);
    expect(levelsAfter(r, 111_000).every((l) => l === 'none')).toBe(true);
  });
  test("'all': they feed F4 as moving F1s do: Severe after the second", () => {
    const r = play(drive, 250, { cfg: feed('all') });
    expect(sig3(r)).toHaveLength(4);
    expect(levelsAfter(r, 211_000)).toContain('severe');
  });
});

describe('S-STOP-LOOKAROUND: F1 at a light, then looking around: cleared in 1 s, and never F3', () => {
  // C7 round 2: the eyes shut 1.7 s (a stop's F1 needs 1.5 s deep).
  const drive = drv((t) => (t < 95 ? null : within(t, 109.5, 111.2) ? { speedKmh: 0, openness: 0.1 } : t >= 111.2 ? { speedKmh: 0, gaze: rel(t % 6 < 3 ? 45 : -45, t % 4 < 2 ? 0 : -25) } : { speedKmh: 0 }));
  test('one microsleep, cleared about 1 s after the eyes open; no unresponsive', () => {
    const r = play(drive, 140);
    expect(sig3(r)).toEqual(['start:microsleep', 'stop:microsleep']);
    expect(tier3(r)[1]!.tMs).toBeLessThanOrEqual(112_500);
    expect(r.events.map((e) => e.kind)).not.toContain('unresponsive');
  });
});

describe('AMBIGUOUS_STILL (U-7): distraction frozen, the sleep family at the normal tier', () => {
  // No fix from 100 s; quiet rows, ambiguous from 110 s (no stop evidence). A 3 s lap glance at 115 s, then
  // the eyes shut 1.2 s at 129.5 s.
  const drive = (ambiguous: boolean) =>
    drv((t) =>
      t < 100
        ? null
        : { speedKmh: null, motion: { quiet: true, ambiguousStill: ambiguous && t >= 110 }, ...(within(t, 115, 118) ? { gaze: rel(0, -40) } : {}), ...(within(t, 129.5, 130.7) ? { openness: 0.1 } : {}) }
    );
  test('ambiguous: no distraction warning, and the microsleep sounds', () => {
    const r = play(drive(true), 135);
    expect(r.commands.map((c) => c.kind)).not.toContain('distraction');
    expect(sig3(r)).toContain('start:microsleep');
  });
  test('the same drive held (not ambiguous): the lap glance warns', () => {
    const r = play(drive(false), 135);
    expect(r.commands.map((c) => `${c.action}:${c.kind}`)).toContain('start:distraction');
  });
});

describe('feedsDrowsinessScore (U-14; rev5 §4.4): what a stop-time event feeds the trip score', () => {
  const nod = (stopped: boolean): DmsEvent => ({ kind: 'microsleep_nod', tMs: 0, deepMaxS: 0.6, stopped });
  const end = (stopped: boolean, level: 'f1' | 'f2' | 'f3'): DmsEvent => ({ kind: 'episode_end', tMs: 0, durMs: 1500, bridged: false, stopped, level });
  test.each([
    ['none', [false, false, false, false]],
    ['long_and_nod', [true, false, true, true]],
    ['all', [true, true, true, true]],
  ] as const)("'%s': stop-time [nod, F1 episode, F2 episode, F3 episode]", (v, want) => {
    expect([nod(true), end(true, 'f1'), end(true, 'f2'), end(true, 'f3')].map((e) => feedsDrowsinessScore(e, v))).toEqual(want);
  });
  test('moving-time events always feed', () => {
    for (const v of ['none', 'long_and_nod', 'all'] as const) {
      expect([nod(false), end(false, 'f1'), end(false, 'f2')].map((e) => feedsDrowsinessScore(e, v))).toEqual([true, true, true]);
    }
  });
});

describe('S-STOP-NOISY-LID (review-C7 R2-S; NC-C7-8): real sleep at a light with a noisy closed lid alarms on schedule', () => {
  // Stopped from 120 s; the eyes shut from 140 s for 10 s at openness base ± σ per frame (a device's EAR noise on a
  // closed eye). At a stop every closure counts deep-only (< 0.15); the bridged run keeps a lid that flickers over it
  // as one closure.
  const cases: [number, number, number][] = [];
  for (const base of [0.1, 0.12]) for (const sd of [0.03, 0.04]) for (const fps of [8, 15]) cases.push([base, sd, fps]);
  test.each(cases)('closed at %f ± %f, %i fps: F1 ≤ 1.8 s, F2 ≤ 3.6 s, F3 ≤ 7.2 s', (base, sd, fps) => {
    const driver = drv((t) => (t < 120 ? null : within(t, 140, 150) ? { ...GNSS, openness: base } : { ...GNSS }));
    const items = synthDrive({ fps, seconds: 155, seed: 1, source: 'geometric', driver, motion: true, lidNoise: sd });
    const r = replayItems(items, C, DEFAULT_INIT, { keepOpen: true });
    const first = (k: string) => r.events.find((e) => e.kind === k && e.tMs >= 140_000)?.tMs ?? null;
    expect(first('microsleep')).not.toBeNull();
    expect(first('microsleep')! - 140_000).toBeLessThanOrEqual(1800);
    expect(first('sleep')! - 140_000).toBeLessThanOrEqual(3600);
    expect(first('unresponsive')! - 140_000).toBeLessThanOrEqual(7200);
  });
});
