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
  // C7 round 2 (the coordinator's stop ruling, review-C7 Round 1 §3 (b); NC-C7-7): at a stop every closure counts
  // deep-only, so the reader R-a cannot see (no iris) and R-b cannot see (no dip) is silent too.
  test.each([0, 0.05])('the stop residual: head %f of the gaze, 5 fps, a 50 ms lid, iris model 0.33, stopped: 0 sleep Criticals', (share) => {
    const x = playReading({ pitch: -40, fps: 5, lidLagS: 0.05, blinkShare: 0, speedKmh: 0, calibrated: true, irisMinLid: 0.33, seconds: SECS, headShare: share });
    expect(x.bouts.some((b) => b.sawIris)).toBe(false);
    expect(x.closures.filter((c) => c > 1200).length).toBeGreaterThanOrEqual(5);
    expect(sleepCriticals(x)).toEqual([]);
  });
  test('the variants are not vacuous: R-a sees the iris in every bout except at 5 fps with a 50 ms lid under the 0.33 model', () => {
    const seen = playReading({ pitch: -40, fps: 15, lidLagS: 0.05, blinkShare: 0, speedKmh: 60, calibrated: true, irisMinLid: 0.33, seconds: 120, headShare: 0 });
    expect(seen.bouts.every((b) => b.sawIris)).toBe(true);
    const unseen = playReading({ pitch: -40, fps: 5, lidLagS: 0.05, blinkShare: 0, speedKmh: 60, calibrated: true, irisMinLid: 0.33, seconds: 120, headShare: 0 });
    expect(unseen.bouts.some((b) => b.sawIris)).toBe(false);
  });
});
