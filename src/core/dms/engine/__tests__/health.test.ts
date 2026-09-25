// Task C7 (rev2 §2.4, rev1 K2): the gaze accuracy monitor, unit level. H1–H4 on on-road frames; degraded on any
// bad metric; recovery after 60 s of every metric good; no evaluation while held (STOPPED, uncalibrated, dual).
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../config';
import { createHealthMonitor, type HealthInput } from '../health';
import { gauss, rng } from '../__fixtures__/synth';
import type { AnglePair } from '../types';

const C = DEFAULT_DMS_CONFIG as DmsConfig;
const FPS = 15;
const CENTRE = { yaw: 2, pitch: -3 };

/** Runs `seconds` of frames; `gaze(t)` is the on-road gaze (null: not an on-road frame). */
function run(m: ReturnType<typeof createHealthMonitor>, seconds: number, gaze: (t: number, r: () => number) => AnglePair | null, o: Partial<HealthInput> & { t0?: number } = {}) {
  const r = rng(5);
  const states: { t: number; degraded: boolean }[] = [];
  for (let i = 0; i < seconds * FPS; i++) {
    const t = (o.t0 ?? 0) + i / FPS;
    // σ̂ 4.3°: as Stage 1 measures these drives (the σ 4° noise with the natural σ 1.5° scanning, √(4² + 1.5²)).
    m.step({ tMs: t * 1000, dtS: 1 / FPS, hold: o.hold ?? false, onRoadGaze: gaze(t, r), centre: o.centre ?? CENTRE, radiusDeg: o.radiusDeg ?? 8, sigmaDeg: o.sigmaDeg ?? 4.3, sourceDiffDeg: o.sourceDiffDeg ?? null });
    if (i % FPS === 0) states.push({ t, degraded: m.gazeDegraded() });
  }
  return states;
}
const around = (c: AnglePair, s: number) => (_: number, r: () => number) => ({ yaw: c.yaw + s * gauss(r), pitch: c.pitch + s * gauss(r) });

describe('the gaze accuracy monitor (H1–H4)', () => {
  test('a well-centred road (σ 4°): every metric good, never degraded', () => {
    const m = createHealthMonitor(C);
    const st = run(m, 600, around(CENTRE, 4));
    expect(st.every((s) => !s.degraded)).toBe(true);
    const x = m.metrics();
    expect(x.h1!).toBeGreaterThan(0.8);
    expect(x.h2!).toBeLessThan(2);
    expect(x.h3!).toBeLessThan(1.5);
  });
  test('H2: the road 9° off the centre: degraded within 50 s (the window’s mode crossing, then two evaluations)', () => {
    const m = createHealthMonitor(C);
    run(m, 60, around(CENTRE, 4));
    const st = run(m, 60, around({ yaw: CENTRE.yaw, pitch: CENTRE.pitch + 9 }, 4), { t0: 60 });
    const at = st.find((s) => s.degraded);
    expect(at).toBeDefined();
    expect(at!.t - 60).toBeLessThanOrEqual(50);
    expect(m.metrics().h2!).toBeGreaterThan(5);
  });
  test('H1 and H3: a road spread far wider than the calibrated radius: degraded', () => {
    const m = createHealthMonitor(C);
    const st = run(m, 120, around(CENTRE, 12));
    expect(st.some((s) => s.degraded)).toBe(true);
    const x = m.metrics();
    expect(x.h1!).toBeLessThan(0.5);
    expect(x.h3!).toBeGreaterThan(1.5);
  });
  test('H4 (net builds): the sources disagreeing by 8° over 30 s: degraded; by 2°: good', () => {
    const bad = createHealthMonitor(C);
    expect(run(bad, 60, around(CENTRE, 3), { sourceDiffDeg: 8 }).some((s) => s.degraded)).toBe(true);
    const good = createHealthMonitor(C);
    expect(run(good, 60, around(CENTRE, 3), { sourceDiffDeg: 2 }).some((s) => s.degraded)).toBe(false);
  });
  test('recovery: after the road returns, 60 s of every metric good ends the degradation (not sooner)', () => {
    const m = createHealthMonitor(C);
    run(m, 60, around({ yaw: CENTRE.yaw, pitch: CENTRE.pitch + 7 }, 4));
    expect(m.gazeDegraded()).toBe(true);
    const st = run(m, 150, around(CENTRE, 4), { t0: 60 });
    const firstGood = st.find((s) => !s.degraded)!;
    expect(firstGood).toBeDefined();
    // the window must first empty of the offset road (≤ 30 s + 2 evaluations), then 60 s good
    expect(firstGood.t - 60).toBeGreaterThanOrEqual(60);
    expect(firstGood.t - 60).toBeLessThanOrEqual(60 + 50);
  });
  test('held (STOPPED, uncalibrated, the dual state): no evaluation, the state stands', () => {
    const m = createHealthMonitor(C);
    const st = run(m, 120, around({ yaw: CENTRE.yaw, pitch: CENTRE.pitch + 10 }, 4), { hold: true });
    expect(st.every((s) => !s.degraded)).toBe(true);
    expect(m.metrics().h2).toBeNull();
  });
  test('C7 round 1 (C7-3): a second on-road cluster watched 70 % (a display 15° off), the road still watched: never degraded', () => {
    const m = createHealthMonitor(C);
    const st = run(m, 600, (t, r) => (t % 3 < 2.1 ? { yaw: CENTRE.yaw + 14 + 3 * gauss(r), pitch: CENTRE.pitch - 5 + 3 * gauss(r) } : { yaw: CENTRE.yaw + 4 * gauss(r), pitch: CENTRE.pitch + 4 * gauss(r) }));
    expect(st.every((s) => !s.degraded)).toBe(true);
    expect(m.metrics().h2!).toBeGreaterThan(10); // the mode is the display; c₀ is not vacated beyond noise
  });
  test('off-road frames never count (K2): 70 % of the frames elsewhere, the on-road ones centred: good', () => {
    const m = createHealthMonitor(C);
    const st = run(m, 300, (t, r) => (t % 10 < 7 ? null : { yaw: CENTRE.yaw + 3 * gauss(r), pitch: CENTRE.pitch + 3 * gauss(r) }));
    expect(st.every((s) => !s.degraded)).toBe(true);
  });
});
