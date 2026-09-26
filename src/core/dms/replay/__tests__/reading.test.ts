// Task C7 (review-C2 §3; rev4 §2.3.6; rev5 §2; review-C6 deviation-2 ruling and Round 2): eye-movers reading a lap
// phone, through the engine façade. The synth lid follows the gaze with a lag of 150 ms or 50 ms; its floor is 0.20
// since C7 round 4 (the K12 release gate's margin; W4's 0.17 is recorded as the overlap case in S-READING-NOISE), and
// per-frame EAR noise (σ 0.03) lands on every frame. The head is 20 % of the gaze; in the "blink" variants a blink
// lands on the saccade down in 25 % of the bouts.
// Every variant runs under both iris models (0.2: C6 round 1's; 0.33: the C2 reviewer's), against the moving-derived
// EAR (a calibrated drive), and at a stop also with no reference at all (C6-2's prior mode).
// Every variant runs the review's 10 min.
// (Split into four files in T9 so Jest runs them in parallel: reading.test.ts, reading-levelhead.test.ts,
// reading-moving.test.ts and reading-noise.test.ts.)
import { f1s, playReading, sleepCriticals } from '../__fixtures__/reading';

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

// ---------------------------------------------------------------------------------------------------------
// C7 round 5 (review-C7 R4-C; NC-C7-12): deep-only counting in the moving crawl band (rule speed < 20 km/h). The
// capture runs 5 fps there (SLEEP_WATCH); a reader whose lid follows the gaze within 50 ms leaves no gaze frame, and
// before this round got a sleep Critical on every bout (82 of 83, 233 Critical commands in 10 min).
// ---------------------------------------------------------------------------------------------------------
describe('S-READING-CRAWL (review-C7 R4-C; NC-C7-12): reading at 12 and 15 km/h, 5 fps: 0 F1, fatigue none', () => {
  const cases: [number, number, number][] = [];
  for (const speed of [12, 15]) for (const lag of [0.05, 0.15]) for (const iris of IRIS) cases.push([speed, lag, iris]);
  test.each(cases)('%i km/h, lid lag %f s, iris model %f, −45°, the 0.20 floor', (speed, lag, iris) => {
    const x = playReading({ pitch: -45, fps: 5, lidLagS: lag, blinkShare: 0, speedKmh: speed, calibrated: true, irisMinLid: iris, seconds: SECS });
    expect(x.closures.filter((c) => c > 1200).length).toBeGreaterThanOrEqual(5);
    expect(f1s(x)).toEqual([]);
    expect(sleepCriticals(x)).toEqual([]);
    expect(x.maxFatigueLevel).toBe('none');
  });
});
