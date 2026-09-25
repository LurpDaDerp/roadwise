// Task C7 (review-C2 §3; rev4 §2.3.6; rev5 §2; review-C6 deviation-2 ruling and Round 2): eye-movers reading a lap
// phone, through the engine façade. The synth lid follows the gaze (the floor 0.17, W4) with a lag of 150 ms or
// 50 ms; the head is 20 % of the gaze; in the "blink" variants a blink lands on the saccade down in 25 % of the bouts.
// Every variant runs under both iris models (0.2: C6 round 1's; 0.33: the C2 reviewer's), against the moving-derived
// EAR (a calibrated drive), and at a stop also with no reference at all (C6-2's prior mode).
// Every variant runs the review's 10 min.
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

// A shallow eye-mover (the head at 14 % of the gaze: a dip of about −5.4° at −40°, under the latch's −5° clear pitch
// but above R-b's −6°): at a stop only R-a protects it (NC-T7a). Under the 0.2 iris model the first post-saccade
// frames still show the iris. Under the 0.33 model a fast lid or a blink on the saccade leaves no raw frame, and
// this driver is not protected (reported in task-C7-report.md, a finding for the reviewer).
describe('S-STOP-READ-EYEMOVER-SHALLOW: a head dip between the clear and R-b pitches: R-a alone (NC-T7a)', () => {
  const cases: [number, number][] = [];
  for (const fps of [5, 15]) for (const lag of [0.15, 0.05]) cases.push([fps, lag]);
  test.each(cases)('−40°, head 14 %%, %i fps, lid lag %f s, iris model 0.2, 25 %% blinks on the saccade: 0 sleep Criticals', (fps, lag) => {
    const x = playReading({ pitch: -40, fps, lidLagS: lag, blinkShare: 0.25, speedKmh: 0, calibrated: true, irisMinLid: 0.2, seconds: SECS, headShare: 0.14 });
    expect(x.closures.filter((c) => c > 1200).length).toBeGreaterThanOrEqual(5);
    expect(sleepCriticals(x)).toEqual([]);
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
  // iris model's threshold) leaves no gaze to read, and R-b is stop-only; such a bout may alert. The other bouts
  // must not.
  test.each(cases)('%i°, lid lag %f s, iris model %f, 25 %% blinks on the saccade: F1 only in those bouts (the stated residual)', (pitch, lag, iris) => {
    const x = playReading(base(pitch, lag, iris, 0.25));
    const hit = x.bouts.filter((b) => f1s(x).some((e) => e.tMs >= b.start * 1000 && e.tMs < (b.end + 1) * 1000));
    expect(hit.filter((b) => !b.blink).length).toBeLessThanOrEqual(Math.floor(0.03 * x.bouts.length));
  });
});
