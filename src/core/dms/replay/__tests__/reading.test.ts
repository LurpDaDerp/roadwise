// Task C7 (review-C2 §3; rev4 §2.3.6; rev5 §2; review-C6 deviation-2 ruling and Round 2): eye-movers reading a lap
// phone, through the engine façade. The synth lid follows the gaze (the floor 0.17, W4) with a lag of 150 ms or
// 50 ms; the head is 20 % of the gaze; in the "blink" variants a blink lands on the saccade down in 25 % of the bouts.
// Every variant runs under both iris models (0.2: C6 round 1's; 0.33: the C2 reviewer's), against the moving-derived
// EAR (a calibrated drive), and at a stop also with no reference at all (C6-2's prior mode).
// Every variant runs the review's 10 min.
import { DEFAULT_DMS_CONFIG } from '../../engine/config';
import { feedsDrowsinessScore, type DmsEvent } from '../../engine/engine';
import { boutsWithF1, f1s, playReading, sleepCriticals, type ReadingOpts } from '../__fixtures__/reading';

const SECS = 600;
const IRIS = [0.2, 0.33] as const;
const PITCH = [-40, -45] as const;

describe('S-STOP-READ-EYEMOVER-40/-45: reading at lights, 0 sleep Criticals (R-a, R-b, the latch)', () => {
  const cases: [number, number, number, number][] = [];
  for (const pitch of PITCH) for (const fps of [5, 15]) for (const lag of [0.15, 0.05]) for (const iris of IRIS) cases.push([pitch, fps, lag, iris]);
  test.each(cases)('calibrated: %i°, %i fps, lid lag %f s, iris model %f, 25 %% blinks on the saccade', (pitch, fps, lag, iris) => {
    const x = playReading({ pitch, fps, lidLagS: lag, blinkShare: 0.25, speedKmh: 0, calibrated: true, irisMinLid: iris, seconds: SECS });
    // the precondition (rev5 §2): ≥ 5 closure episodes of > 1.2 s while reading
    expect(x.closures.filter((c) => c > 1200).length).toBeGreaterThanOrEqual(5);
    expect(sleepCriticals(x)).toEqual([]);
  });
  test.each(cases)('no reference (prior mode): %i°, %i fps, lid lag %f s, iris model %f, 25 %% blinks on the saccade', (pitch, fps, lag, iris) => {
    const x = playReading({ pitch, fps, lidLagS: lag, blinkShare: 0.25, speedKmh: 0, calibrated: false, irisMinLid: iris, seconds: SECS });
    expect(x.priorFrames).toBe(x.frames);
    // at −45° the lid sits at its floor (EAR 0.051 < 0.06): the reading is a prior closure, the rule is reached
    if (pitch === -45) expect(x.closures.filter((c) => c > 1200).length).toBeGreaterThanOrEqual(5);
    expect(sleepCriticals(x)).toEqual([]);
  });
});

// C7 round 1 (review-C7 C7-2): a shallow eye-mover at a stop (the head at 10 % or 14 % of the gaze: a dip of about 3°
// or 4.4° below its road pitch). R-b is relative: the head ≥ 3° below its own pre-onset median within 1 s sets it, and
// the clear is the head back within 1.5° of that median. Under both iris models (under 0.33 a fast lid or a blink
// on the saccade leaves R-a no iris frame, and the dip is the only evidence).
describe('S-STOP-READ-EYEMOVER-SHALLOW: a shallow head dip at a stop, R-b relative (NC-C7-2, NC-T7a)', () => {
  const cases: [number, number, number, number][] = [];
  for (const share of [0.1, 0.14]) for (const fps of [5, 15]) for (const lag of [0.15, 0.05]) for (const iris of IRIS) cases.push([share, fps, lag, iris]);
  test.each(cases)('−40°, head %f of the gaze, %i fps, lid lag %f s, iris model %f, 25 %% blinks on the saccade: 0 sleep Criticals', (share, fps, lag, iris) => {
    const x = playReading({ pitch: -40, fps, lidLagS: lag, blinkShare: 0.25, speedKmh: 0, calibrated: true, irisMinLid: iris, seconds: SECS, headShare: share });
    expect(x.closures.filter((c) => c > 1200).length).toBeGreaterThanOrEqual(5);
    expect(sleepCriticals(x)).toEqual([]);
  });
});

// C7 round 1 (review-C7 C7-1): a pure eye-mover (the head at 0 % or 5 % of the gaze). The latch R-a set clears only
// on evidence of its own kind (a reliable raw frame back above −12°, or the head risen 3° above its onset pitch), never
// on the level head. Acceptance: 0 F1 in the bouts where R-a saw a reliable frame (the iris in the first 0.5 s).
describe('S-READING-LEVELHEAD: a gaze-set latch is not cleared by a level head (NC-C7-1)', () => {
  const cases: [number, number, number, number, number][] = [];
  for (const speed of [60, 0]) for (const share of [0, 0.05]) for (const fps of [5, 15]) for (const lag of [0.15, 0.05]) for (const iris of IRIS) cases.push([speed, share, fps, lag, iris]);
  test.each(cases)('%i km/h, head %f of the gaze, %i fps, lid lag %f s, iris model %f, no blink on the saccade', (speed, share, fps, lag, iris) => {
    const x = playReading({ pitch: -40, fps, lidLagS: lag, blinkShare: 0, speedKmh: speed, calibrated: true, irisMinLid: iris, seconds: SECS, headShare: share });
    const hit = x.bouts.filter((b) => b.sawIris && f1s(x).some((e) => e.tMs >= b.start * 1000 && e.tMs < (b.end + 1) * 1000));
    expect(hit).toEqual([]);
  });
  test('the variants are not vacuous: R-a sees the iris in every bout except at 5 fps with a 50 ms lid under the 0.33 model', () => {
    const seen = playReading({ pitch: -40, fps: 15, lidLagS: 0.05, blinkShare: 0, speedKmh: 60, calibrated: true, irisMinLid: 0.33, seconds: 120, headShare: 0 });
    expect(seen.bouts.every((b) => b.sawIris)).toBe(true);
    const unseen = playReading({ pitch: -40, fps: 5, lidLagS: 0.05, blinkShare: 0, speedKmh: 60, calibrated: true, irisMinLid: 0.33, seconds: 120, headShare: 0 });
    expect(unseen.bouts.some((b) => b.sawIris)).toBe(false);
  });
});

describe('S-READING-40/-45: the same at 60 km/h, 15 fps', () => {
  const base = (pitch: number, lag: number, iris: number, blinkShare: number): ReadingOpts => ({ pitch, fps: 15, lidLagS: lag, blinkShare, speedKmh: 60, calibrated: true, irisMinLid: iris, seconds: SECS });
  const cases: [number, number, number][] = [];
  for (const pitch of PITCH) for (const lag of [0.15, 0.05]) for (const iris of IRIS) cases.push([pitch, lag, iris]);
  test.each(cases)('%i°, lid lag %f s, iris model %f, no blink on the saccade: 0 F1 (≤ 3 %% of bouts at 50 ms; NC-T7e)', (pitch, lag, iris) => {
    const x = playReading(base(pitch, lag, iris, 0));
    expect(x.closures.filter((c) => c > 1200).length).toBeGreaterThanOrEqual(5);
    if (lag >= 0.15) expect(f1s(x)).toEqual([]);
    else expect(boutsWithF1(x)).toBeLessThanOrEqual(Math.floor(0.03 * x.bouts.length));
  });
  // The stated residual (review-C2 §3): at speed a blink ON the saccade with no iris after it (a lid at or below the
  // iris model's threshold) leaves no gaze to read, and R-b is stop-only; such a bout may alert. C7 round 1 (review-C7
  // C7-4, S-READING-BLINK): those F events are delivered but `shallow` (the episode was never deep), so they feed no
  // fatigue floor, gate or score: the fatigue level is the blink-free run's, and no episode feeds the score.
  test.each(cases)('S-READING-BLINK %i°, lid lag %f s, iris model %f, 25 %% blinks on the saccade: only in those bouts, all shallow, the level unchanged (NC-C7-4)', (pitch, lag, iris) => {
    const x = playReading(base(pitch, lag, iris, 0.25));
    const hit = x.bouts.filter((b) => f1s(x).some((e) => e.tMs >= b.start * 1000 && e.tMs < (b.end + 1) * 1000));
    expect(hit.filter((b) => !b.blink).length).toBeLessThanOrEqual(Math.floor(0.03 * x.bouts.length));
    const sleepEvents = x.events.filter((e) => (e.kind === 'microsleep' || e.kind === 'sleep' || e.kind === 'unresponsive') && e.tMs >= x.t0 * 1000);
    expect(sleepEvents.filter((e) => (e as { shallow?: boolean }).shallow !== true)).toEqual([]);
    const ends = x.events.filter((e): e is Extract<DmsEvent, { kind: 'episode_end' }> => e.kind === 'episode_end' && e.tMs >= x.t0 * 1000);
    expect(ends.filter((e) => feedsDrowsinessScore(e, DEFAULT_DMS_CONFIG.fatigue.stopEventsFeed))).toEqual([]);
    const clean = playReading(base(pitch, lag, iris, 0));
    expect(x.maxFatigueLevel).toBe(clean.maxFatigueLevel);
  });
});
