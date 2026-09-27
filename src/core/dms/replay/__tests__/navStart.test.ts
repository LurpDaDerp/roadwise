// Task C9 (T9; review-C9 "Stage 1 robustness", S1-1): a navigation-heavy start never calibrates onto the
// display. 60 km/h straight, mirror checks every 15 s (0.8 s at (27°, 10°) and (−45°, 0°)); for the first 60 s or 120 s
// a display is watched 20, 40, 60 or 85 % of every 10 s (85 %: 8.5 s of every 10 s), then normal driving. No profile.
//
// The synth's setup (stated):
// - Displays at (9°, −6°), (14°, −8°) and (0°, −15°) from the road, and a phone AT THE CAMERA: for that case the
//   phone mount is 25° right of and 15° below the road (mountShift (−25°, 15°), as in S-2H-MANY), so the display is
//   the camera's own direction; with the synth's default mount the camera is 3.6° from the road, inside its circle.
// - The truth is each seed's display-free centre (the geometric gain error is per drive).
// - S-NAV-START-SIDE: after each mirror check the driver looks at the road for 1 s before the display pattern resumes
//   (the default pattern hands the gaze straight back to the display when it is due, so its returns land on the
//   display about as often as its share).
import { angularDistanceDeg } from '../../engine/angles';
import { AT_CAMERA, firstCalS, navDrive, truthOf, worstAfterCal } from '../__fixtures__/navStart';

const DISPLAYS: [string, { yaw: number; pitch: number }, boolean][] = [
  ['(9°, −6°)', { yaw: 9, pitch: -6 }, false],
  ['(14°, −8°)', { yaw: 14, pitch: -8 }, false],
  ['(0°, −15°)', { yaw: 0, pitch: -15 }, false],
  ['the phone at the camera', AT_CAMERA, true],
];

interface Case {
  name: string;
  at: { yaw: number; pitch: number };
  camera: boolean;
  share: number;
  startS: number;
  seed: number;
}

/** the evaluation grid's lag behind each 30 s mark (a frame or two at 15 fps) */
const EVAL_SLACK_S = 0.5;

const cases: Case[] = [];
for (const [name, at, camera] of DISPLAYS) for (const share of [0.2, 0.4, 0.6, 0.85]) for (const startS of [60, 120]) for (const seed of [1, 2, 3]) cases.push({ name, at, camera, share, startS, seed });

describe('S-NAV-START (review-C9 S1-1; NC-S1-1, NC-S1-C): a navigation-heavy start calibrates on the road or not yet', () => {
  // Measured: the first pass 0.0–0.7° from the truth; at ≤ 40 % every pass at 60 s; at 60 % at 90 s (60 s starts) and
  // 90–150 s (120 s starts); at 85 % at 120 s and 180–210 s (after the display share falls), never onto the display.
  test.each(cases)('$name, $share, a $startS s start, seed $seed: correct, in time', (c) => {
    const truth = truthOf(c.seed, c.camera);
    const d = navDrive({ seed: c.seed, share: c.share, at: c.at, camera: c.camera, startS: c.startS, seconds: 240 });
    const t = firstCalS(d);
    if (c.share <= 0.4) expect(t).not.toBeNull();
    if (t !== null) {
      expect(angularDistanceDeg(d.passes[0]!.centre, truth)).toBeLessThanOrEqual(1.5);
      // never a pass onto the screen: the centre stays on the road once calibrated
      expect(worstAfterCal(d, truth)).toBeLessThanOrEqual(1.5);
    }
    // The bounds are the evaluations at 90 s and 150 s: Stage 1 evaluates at 60.1 s and every 30 s after (the frame
    // after each mark), so the 150 s evaluation lands at 150.2 s (a 120 s start at 60 %: the ρ-core exclusion leaves
    // about half the display's frames in the denominator until the road's share has grown).
    if (c.share <= 0.4) expect(t!).toBeLessThanOrEqual(90 + EVAL_SLACK_S);
    else if (c.share <= 0.6) expect(t!).toBeLessThanOrEqual(150 + EVAL_SLACK_S);
  });
});

describe('S-NAV-START-SIDE (review-C9 S1-1 (d)): a display beside the road (the same pitch, 12° to the side) at 40 %', () => {
  const side: [number, number][] = [];
  for (const yaw of [12, -12]) for (const seed of [1, 2, 3]) side.push([yaw, seed]);
  test.each(side)('with mirror checks (returns to the road): yaw %i, seed %i: calibrated at 60 s on the road', (yaw, seed) => {
    const truth = truthOf(seed);
    const d = navDrive({ seed, share: 0.4, at: { yaw, pitch: 0 }, startS: 300, seconds: 200, roadAfterMirrorS: 1 });
    expect(firstCalS(d)).not.toBeNull();
    expect(firstCalS(d)!).toBeLessThanOrEqual(90);
    expect(angularDistanceDeg(d.passes[0]!.centre, truth)).toBeLessThanOrEqual(1.5);
    expect(worstAfterCal(d, truth)).toBeLessThanOrEqual(1.5);
  });
  test.each(side)('no mirror checks (no returns): yaw %i, seed %i: no pass while the display is a cluster; then the road', (yaw, seed) => {
    const truth = truthOf(seed);
    // the display for 300 s: no pass in 400 s (Stage 1 gives up at 180 s as today: uncalibrated, D2 on)
    const held = navDrive({ seed, share: 0.4, at: { yaw, pitch: 0 }, startS: 300, seconds: 400, mirrors: false });
    expect(firstCalS(held)).toBeNull();
    // the display for 120 s: a pass only once its share has fallen out of the window, on the road
    const d = navDrive({ seed, share: 0.4, at: { yaw, pitch: 0 }, startS: 120, seconds: 400, mirrors: false });
    expect(firstCalS(d)).not.toBeNull();
    expect(firstCalS(d)!).toBeGreaterThan(120);
    expect(worstAfterCal(d, truth)).toBeLessThanOrEqual(1.5);
  });
});

describe('S-NAV-START-MIRRORS (review-C9 C9-1; NC-S1-3): a display, frequent mirror checks and the road: three clusters', () => {
  // The review's probe: a display watched 60 or 70 % of every 10 s for the whole drive, one mirror (the rear at
  // (27°, 10°) or the driver's at (−45°, 0°)) checked 0.8 s of every 4 or 5 s (16–20 %), the road for 0.5 s after
  // each check. Before C9 round 1 no pass in 240 s in every run: the display and the mirror were the two highest
  // peaks, and the road, the third, was never a candidate. Measured now: every pass at 60 s or 120 s, 0.1–0.8° off.
  const cases: [number, number, number, number, 'rear' | 'driver', number][] = [];
  for (const [every, share, y, p] of [[5, 0.6, 14, -8], [5, 0.7, 14, -8], [4, 0.7, 9, -6], [5, 0.7, 0, -15]] as const) {
    for (const which of ['rear', 'driver'] as const) for (const seed of [1, 2, 3]) cases.push([every, share, y, p, which, seed]);
  }
  test.each(cases)('every %i s, %f at (%i°, %i°), the %s mirror, seed %i: on the road by 150 s, never on the screen', (every, share, y, p, which, seed) => {
    const truth = truthOf(seed);
    const d = navDrive({ seed, share, at: { yaw: y, pitch: p }, startS: 240, seconds: 200, frequentMirror: { every, which } });
    const t = firstCalS(d);
    expect(t).not.toBeNull();
    expect(t!).toBeLessThanOrEqual(150 + EVAL_SLACK_S);
    expect(angularDistanceDeg(d.passes[0]!.centre, truth)).toBeLessThanOrEqual(1.5);
    expect(worstAfterCal(d, truth)).toBeLessThanOrEqual(1.5);
  });
});

describe('S-NAV-START-RESUME (review-C9 R2-R; NC-S1-H2): a reader who goes back to the display after each mirror check', () => {
  // The review's probe: the display resumed for 2 s after each mirror check (glance at the mirror, back to the phone),
  // a share of 30, 45 or 60 % otherwise, mirror checks every 15 s, 240 s. The returns land on the DISPLAY well beyond
  // its occupancy: returns-before-pitch (C9 round 2) passed onto it in 13 of 18. Pitch before returns (restored):
  // measured, every pass correct (0.1–0.4°) or no pass yet, never onto the display.
  const cases: [number, number, number, number][] = [];
  for (const [y, p] of [[14, -8], [9, -6], [0, -15]] as const) for (const share of [0.3, 0.45, 0.6]) for (const seed of [1, 2]) cases.push([y, p, share, seed]);
  test.each(cases)('(%i°, %i°) at %f, seed %i: correct or not yet; never onto the display', (y, p, share, seed) => {
    const truth = truthOf(seed);
    const d = navDrive({ seed, share, at: { yaw: y, pitch: p }, startS: 240, seconds: 240, displayAfterMirrorS: 2 });
    if (firstCalS(d) !== null) {
      expect(angularDistanceDeg(d.passes[0]!.centre, truth)).toBeLessThanOrEqual(1.5);
      expect(worstAfterCal(d, truth)).toBeLessThanOrEqual(1.5);
    }
  });
});

describe('S-NAV-START-HIGH (review-C9 R2-R, re-cut): a display mounted ABOVE the road line; 40 and 60 % are a KNOWN LIMIT', () => {
  // The review's probe: a display at (6°, 8°), (0°, 9°) or (10°, 7°), watched 20, 40 or 60 % of every 10 s for the whole
  // drive, the usual mirror checks every 15 s and the road for 1.3 s after each. The pitch rule (c) picks the higher
  // cluster, and the returns cannot override it (S-NAV-START-RESUME: their evidence has the same form as a reader's
  // who goes back to a LOW display). So:
  // - 20 %: asserted correct (the display is no cluster of its own at ≥ clusterMinShare beside the road).
  // - 40 and 60 %: the KNOWN LIMIT (README "Known limits: a display above the road"; device pass D-C9-1), recorded as
  //   measured: no pass, a pass on the road (the two merged at frame level), or a pass onto the display (≥ 7° off).
  //   A road pass never creeps onto the display (≤ 2°, R2-C's road-side follow).
  type Outcome = 'road' | 'none' | 'display';
  const RECORDED: Record<string, [Outcome, Outcome]> = {
    '6,8,0.4': ['road', 'none'],
    '6,8,0.6': ['none', 'none'],
    '0,9,0.4': ['road', 'none'],
    '0,9,0.6': ['road', 'none'],
    '10,7,0.4': ['none', 'none'],
    '10,7,0.6': ['display', 'display'],
  };
  const cases: [number, number, number, number][] = [];
  for (const [y, p] of [[6, 8], [0, 9], [10, 7]] as const) for (const share of [0.2, 0.4, 0.6]) for (const seed of [1, 2]) cases.push([y, p, share, seed]);
  test.each(cases)('(%i°, %i°) at %f, seed %i', (y, p, share, seed) => {
    const truth = truthOf(seed);
    const d = navDrive({ seed, share, at: { yaw: y, pitch: p }, startS: 240, seconds: 200, roadAfterMirrorS: 1.3 });
    const t = firstCalS(d);
    const off = t === null ? null : angularDistanceDeg(d.passes[0]!.centre, truth);
    const outcome: Outcome = off === null ? 'none' : off <= 1.5 ? 'road' : off >= 7 ? 'display' : ('between' as Outcome);
    if (share === 0.2) {
      expect(outcome).toBe('road');
      expect(worstAfterCal(d, truth)).toBeLessThanOrEqual(1.5);
    } else expect(outcome).toBe(RECORDED[`${y},${p},${share}`]![seed - 1]);
    if (outcome === 'road') expect(worstAfterCal(d, truth)).toBeLessThanOrEqual(2);
  });
});

describe('S-FIRST-CAL (review-C9, the cost pin): 20 normal starts calibrate as before', () => {
  // Before T9 (measured on the parent commit with the same drive): all 20 at 60.1 s, the first evaluation.
  const BEFORE_MEDIAN_S = 60.1;
  const BEFORE_MAX_S = 60.1;
  test('the median time to calibrate within ±5 s of before, none later than before + 10 s', () => {
    const ts: number[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      const d = navDrive({ seed, share: 0, at: { yaw: 0, pitch: 0 }, startS: 0, seconds: 100 });
      ts.push(firstCalS(d) ?? Number.POSITIVE_INFINITY);
    }
    ts.sort((a, b) => a - b);
    const med = (ts[9]! + ts[10]!) / 2;
    expect(Math.abs(med - BEFORE_MEDIAN_S)).toBeLessThanOrEqual(5);
    expect(ts[19]!).toBeLessThanOrEqual(BEFORE_MAX_S + 10);
  });
});
