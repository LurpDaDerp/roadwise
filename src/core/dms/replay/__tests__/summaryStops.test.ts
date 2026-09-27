// C-SUM (rev4 §2.5; the summary carries): the trip summary's stop and calibration-honesty numbers, through the
// engine façade. The controller's policy time (`stoppedS`, `sleepWatchS`, `absentS`) is in controller.test.ts.
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../../engine/config';
import { DEFAULT_INIT, replayItems } from '../run';
import { blinkOpenness, onRoad, synthDrive, type DriverFn, type DriverState } from '../synth';

const C = DEFAULT_DMS_CONFIG as DmsConfig;
const drv =
  (over: (t: number) => Partial<DriverState> | null): DriverFn =>
  (t, r) => ({ gaze: onRoad(r), openness: blinkOpenness(t), speedKmh: 60, ...(over(t) ?? {}) });
const play = (driver: DriverFn, seconds: number, init = DEFAULT_INIT, seed = 1) =>
  replayItems(synthDrive({ fps: 15, seconds, seed, source: 'geometric', driver, motion: true }), C, init);

describe('C-SUM: the summary counts the stops honestly', () => {
  test('a moving drive: every stop number 0', () => {
    const r = play(drv(() => null), 300);
    expect(r.summary.stops).toEqual({ seedUnverifiedS: 0, healthDegradedS: 0, stoppedFatigueMinutes: 0, postureStepsAtStops: 0 });
    expect(r.summary.shallowSleepEvents).toBe(0);
  });

  test('stoppedFatigueMinutes: a 4 min stop gives 3–4 minutes more than half STOPPED; none of them scored', () => {
    // 60 km/h to 360 s, stopped (GNSS 0 km/h) 360–600 s, then 60 km/h to 900 s.
    const r = play(drv((t) => (t >= 360 && t < 600 ? { speedKmh: 0 } : null)), 900);
    const n = r.summary.stops.stoppedFatigueMinutes;
    expect(n).toBeGreaterThanOrEqual(3);
    expect(n).toBeLessThanOrEqual(4);
    // the timeline minutes inside the stop are never scored (their statistics are frozen)
    const inStop = r.summary.fatigue.timeline.filter((m) => m.tMs > 400_000 && m.tMs <= 600_000);
    expect(inStop.length).toBeGreaterThanOrEqual(3);
    expect(inStop.every((m) => m.status !== 'scored')).toBe(true);
  });

  test('healthDegradedS is the gaze monitor degraded time, as the snapshot says (a gaze 10° off with no step: > 0)', () => {
    const clean = play(drv(() => null), 200);
    expect(clean.summary.stops.healthDegradedS).toBe(0);
    // every gaze and head angle 10° right from 150 s, the face box unchanged (no step for the posture detector)
    const r = replayItems(synthDrive({ fps: 15, seconds: 400, seed: 3, source: 'geometric', driver: drv((t) => (t >= 150 ? { posture: { shift: { yaw: 10, pitch: 0 } } } : null)), motion: true }), C, DEFAULT_INIT, { keepOpen: true });
    const snap = r.engine.snapshot().health.degradedS;
    expect(snap).toBeGreaterThan(0);
    expect(r.summary.stops.healthDegradedS).toBeCloseTo(snap, 3);
  });

  test('seedUnverifiedS: a profile adopted at the warm start counts until it is verified; a new drive with none, 0', () => {
    const first = replayItems(synthDrive({ fps: 15, seconds: 300, seed: 1, source: 'geometric', driver: drv(() => null), motion: true }), C, DEFAULT_INIT, { keepOpen: true });
    const profile = first.engine.endDrive(300_000).profile;
    expect(first.summary.stops.seedUnverifiedS).toBe(0);
    expect(profile).not.toBeNull();
    const r = play(drv(() => null), 120, { ...DEFAULT_INIT, profile }, 2);
    const warm = r.events.find((e) => e.kind === 'warm_start');
    const verified = r.events.find((e) => e.kind === 'seed_verified');
    expect(warm).toBeDefined();
    expect(verified).toBeDefined();
    const expected = (verified!.tMs - warm!.tMs) / 1000;
    expect(r.summary.stops.seedUnverifiedS).toBeGreaterThanOrEqual(expected - 0.2);
    expect(r.summary.stops.seedUnverifiedS).toBeLessThanOrEqual(expected + 0.2);
  });
});
