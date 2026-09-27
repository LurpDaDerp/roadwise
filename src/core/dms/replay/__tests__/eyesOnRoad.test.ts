// C7 round 6 (review-C7 R4-T, the user's decision): at 20 km/h or more, a shallow closure (never deep, unlatched) is
// eyes off the road, not sleep: a Tier 2 `eyes_on_road` alert of the distraction family. It becomes a sleep Critical
// only if the closure turns deep (the bridged median-3 deep run reaching F1's time) or lasts 6 s (F3), and it feeds
// no fatigue statistic, gate or score. Through the engine façade.
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../../engine/config';
import { DEFAULT_INIT, replayItems } from '../run';
import { blinkOpenness, onRoad, synthDrive, type DriverFn } from '../synth';
import { playReading } from '../__fixtures__/reading';

const C = DEFAULT_DMS_CONFIG as DmsConfig;

describe('S-READING-FASTLID (review-C7 R4-T; NC-C7-14): the 8–10 fps reader with a 50 ms lid under the 0.33 iris model', () => {
  // −45° at 60 km/h, the 0.20 floor, 10 min (83 bouts of 3–8 s; 36 longer than 6 s). Before this round every bout
  // was a sleep Critical (about 230 Critical commands). Measured now: 8 fps, 73 eyes_on_road starts, 33 F3s (the
  // bouts past 6 s: the ruled escalation), 1 F1 and 1 F2 (one bout whose noisy lid made a 1 s deep run); 10 fps
  // alike (74; 37 Criticals).
  test.each([8, 10])('%i fps: Tier 2 eyes_on_road on most bouts; Criticals only at 6 s (F3) and ≤ 2 deep F1/F2', (fps) => {
    const x = playReading({ pitch: -45, fps, lidLagS: 0.05, blinkShare: 0, speedKmh: 60, calibrated: true, irisMinLid: 0.33, seconds: 600 });
    const starts = (k: string) => x.commands.filter((c) => c.kind === k && c.action === 'start').length;
    const long = x.bouts.filter((b) => b.end - b.start > 6).length;
    expect(starts('eyes_on_road')).toBeGreaterThanOrEqual(60);
    expect(x.commands.filter((c) => c.kind === 'eyes_on_road').every((c) => c.tier === 2)).toBe(true);
    expect(starts('microsleep') + starts('sleep')).toBeLessThanOrEqual(2);
    expect(starts('unresponsive')).toBeLessThanOrEqual(long);
    // C7 round 7 (review-C7 R6-1; NC-C7-18): each eyes_on_road RUNS until its bout ends or a Critical replaces
    // it. Measured: stops 0.0–0.39 s after the bout's end (the clear needs the eyes open AND on the road: the
    // gaze's return from −45° takes 2–3 frames at 8 fps), or at the Critical's start.
    for (const s of x.commands.filter((c) => c.kind === 'eyes_on_road' && c.action === 'start')) {
      const stop = x.commands.find((c) => c.kind === 'eyes_on_road' && c.action === 'stop' && c.tMs >= s.tMs);
      expect(stop).toBeDefined();
      const replaced = x.commands.some((c) => c.tier === 3 && c.action === 'start' && c.tMs === stop!.tMs);
      if (replaced) continue;
      const bout = x.bouts.find((b) => b.start * 1000 <= s.tMs && s.tMs <= b.end * 1000);
      expect(bout).toBeDefined();
      expect(stop!.tMs).toBeGreaterThanOrEqual(bout!.end * 1000 - 1000 / fps);
      expect(stop!.tMs).toBeLessThanOrEqual(bout!.end * 1000 + 500);
    }
    // The blips no longer count as heard warnings (they set off repeated_glances before the fix).
    expect(starts('repeated_glances')).toBe(0);
  });
});

describe('S-NODOFF-FAST (review-C7 R4-T): a real nod-off at speed is still a sleep Critical at F1', () => {
  // 60 km/h; the eyes shut from 100 s at openness 0.05 ± 0.03 (deep at once): F1 at 1.0 s (+ 1 frame), a Tier 3
  // microsleep, and no eyes_on_road.
  test.each([8, 15])('%i fps', (fps) => {
    const driver: DriverFn = (t, r) => ({ gaze: onRoad(r), openness: t >= 100 && t < 104 ? 0.05 : blinkOpenness(t), speedKmh: 60 });
    const r = replayItems(synthDrive({ fps, seconds: 110, seed: 3, source: 'geometric', driver, motion: true, lidNoise: 0.03 }), C, DEFAULT_INIT, { keepOpen: true });
    const f1 = r.commands.find((c) => c.kind === 'microsleep' && c.action === 'start' && c.tMs >= 100_000);
    expect(f1).toBeDefined();
    expect(f1!.tier).toBe(3);
    expect(f1!.tMs - 100_000).toBeLessThanOrEqual(1000 + 1000 / fps + 1e-6);
    expect(r.commands.filter((c) => c.kind === 'eyes_on_road' && c.tMs >= 100_000)).toEqual([]);
  });
});

describe('S-EYES-6S (review-C7 R4-T; NC-C7-15): a shallow closure lasting 6 s escalates to the sleep Critical', () => {
  // 60 km/h, the lid at 0.2 (never deep) from 100 s for 7 s, looking ahead (no latch): eyes_on_road at 1.0 s, then
  // F3 (`unresponsive`) at 6 s; it feeds no fatigue gate or score (the episode is shallow).
  test('eyes_on_road at 1 s, the Critical at 6 s', () => {
    const driver: DriverFn = (t, r) => ({ gaze: onRoad(r), openness: t >= 100 && t < 107 ? 0.2 : blinkOpenness(t), speedKmh: 60 });
    const r = replayItems(synthDrive({ fps: 15, seconds: 112, seed: 4, source: 'geometric', driver, motion: true }), C, DEFAULT_INIT, { keepOpen: true });
    const eyes = r.commands.find((c) => c.kind === 'eyes_on_road' && c.action === 'start' && c.tMs >= 100_000)!;
    expect(eyes.tMs - 100_000).toBeLessThanOrEqual(1100);
    const crit = r.commands.filter((c) => c.tier === 3 && c.action === 'start' && c.tMs >= 100_000);
    expect(crit.map((c) => c.kind)).toEqual(['unresponsive']);
    expect(crit[0]!.tMs - 100_000).toBeGreaterThanOrEqual(5900);
    expect(crit[0]!.tMs - 100_000).toBeLessThanOrEqual(6100);
    // C7 round 7 (R6-1; NC-C7-18): the alert RUNS from its start until the Critical replaces it (one stop, at the
    // Critical's start), and F3 is a corroborated escalation.
    const eyeCmds = r.commands.filter((c) => c.kind === 'eyes_on_road' && c.tMs >= 100_000);
    expect(eyeCmds.map((c) => c.action)).toEqual(['start', 'stop']);
    expect(eyeCmds[1]!.tMs).toBe(crit[0]!.tMs);
    expect(r.invariantViolations).toBe(0);
    const end = r.events.find((e) => e.kind === 'episode_end' && e.tMs >= 100_000);
    expect(end).toMatchObject({ shallow: true });
  });
});

describe('S-NODOFF-SLOWDROOP (review-C7 Round 6 pin; NC-C7-18): a lid that droops for d s before closing', () => {
  // 60 km/h: the lid at 0.25 (shallow) for d s from 100 s, then closed at 0.05 ± 0.03 until 108 s. The first alert
  // is always at 1.0 s; the sleep Critical at d + 1.0 s, capped by F3 at 6 s. From 1.0 s the
  // Tier 2 eyes_on_road RUNS until the Critical replaces it. A droop shorter than F1's time is deep by then: F1 at
  // 1.0 s. The deep run is decided by the median of 3 (1–2 frames). Measured (8 / 15 fps): d 0.5 → a Critical at 1.00 s;
  // 1.0 → 2.13 / 2.07; 1.5 → 2.63 / 2.60; 2.5 → 3.63 / 3.60.
  const cases: [number, number][] = [];
  for (const fps of [8, 15]) for (const d of [0.5, 1, 1.5, 2.5]) cases.push([fps, d]);
  test.each(cases)('%i fps, droop %f s', (fps, d) => {
    const driver: DriverFn = (t, r) => ({
      gaze: onRoad(r),
      openness: t >= 100 && t < 100 + d ? 0.25 : t >= 100 + d && t < 108 ? 0.05 : blinkOpenness(t),
      speedKmh: 60,
    });
    const r = replayItems(synthDrive({ fps, seconds: 115, seed: 3, source: 'geometric', driver, motion: true, lidNoise: 0.03 }), C, DEFAULT_INIT, { keepOpen: true });
    const frame = 1000 / fps;
    const after = r.commands.filter((c) => c.tMs >= 100_000 && c.tMs < 110_000);
    const first = after[0]!;
    expect(first.action).toBe('start');
    expect(first.tMs - 100_000).toBeGreaterThanOrEqual(1000 - 1e-6);
    expect(first.tMs - 100_000).toBeLessThanOrEqual(1000 + frame + 1e-6);
    const crit = after.find((c) => c.tier === 3 && c.action === 'start')!;
    expect(crit).toBeDefined();
    // deep before F1's time: F1 at 1.0 s; else the deep run's 1.0 s (+ the median-3 deep decision's 1–2 frames)
    const want = d < 1 ? 1000 : Math.min(6000, (d + 1) * 1000);
    expect(crit.tMs - 100_000).toBeGreaterThanOrEqual(want - 1e-6);
    expect(crit.tMs - 100_000).toBeLessThanOrEqual(want + 2 * frame + 1e-6);
    if (first.kind === 'eyes_on_road') {
      // running from its start to the Critical: its only stop is at the Critical's start
      const eyes = after.filter((c) => c.kind === 'eyes_on_road');
      expect(eyes.map((c) => c.action)).toEqual(['start', 'stop']);
      expect(eyes[1]!.tMs).toBe(crit.tMs);
    } else expect(first.tier).toBe(3);
  });
});
