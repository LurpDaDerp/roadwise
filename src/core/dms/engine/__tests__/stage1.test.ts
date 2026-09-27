// Task C9 (T9; review-C9 S1-1): the two-cluster road choice, unit level.
import { angularDistanceDeg } from '../angles';
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../config';
import type { WeightedDir } from '../histogram';
import { binomialTail, chooseRoad, fixationMedians, roadConfidence, roadSide, type RoadChoice } from '../stage1';
import type { AnglePair } from '../types';
import { gauss, rng } from '../__fixtures__/synth';

const C = DEFAULT_DMS_CONFIG as DmsConfig;

/** `n` directions around each centre (σ 1.5°, the fixation medians' scale), with weights as given. */
function clusters(spec: [AnglePair, number][], seed = 1, sd = 1.5): WeightedDir[] {
  const r = rng(seed);
  const out: WeightedDir[] = [];
  for (const [c, n] of spec) for (let i = 0; i < n; i++) out.push({ yaw: c.yaw + sd * gauss(r), pitch: c.pitch + sd * gauss(r), w: 0.5 });
  return out;
}
const NONE = { sigma: 4, rho: 4, kernelDeg: 1, camera: null, cameraOffRoad: false, returns: [] as AnglePair[] };
const road = (x: RoadChoice | 'wait' | null) => {
  if (x === null || x === 'wait') throw new Error(`no choice: ${String(x)}`);
  return x;
};
const near = (a: AnglePair, b: AnglePair) => angularDistanceDeg(a, b) <= 1;

describe('chooseRoad (S1-1)', () => {
  const R = { yaw: 2, pitch: -3 };
  test('one cluster (mirror glances below the cluster share): the mode, as before', () => {
    const ch = road(chooseRoad(clusters([[R, 200], [{ yaw: 29, pitch: 7 }, 10]]), NONE, C));
    expect(ch.rule).toBe('single');
    expect(ch.other).toBeNull();
    expect(near(ch.road, R)).toBe(true);
  });
  test('(c) a display watched more than the road, 11° below it: the higher cluster is the road', () => {
    const D = { yaw: 11, pitch: -10 };
    const ch = road(chooseRoad(clusters([[R, 60], [D, 140]]), NONE, C));
    expect(ch.rule).toBe('pitch');
    expect(near(ch.road, R)).toBe(true);
    expect(near(ch.other!, D)).toBe(true);
  });
  test('(a) a cluster at an off-road camera is the phone, even above the road', () => {
    const cam = { yaw: 20, pitch: 2 };
    const ch = road(chooseRoad(clusters([[R, 80], [cam, 120]]), { ...NONE, camera: cam, cameraOffRoad: true }, C));
    expect(ch.rule).toBe('camera');
    expect(near(ch.road, R)).toBe(true);
  });
  test('(a) with the camera ON the road (the head faces it) rule (a) is off, and (c) decides', () => {
    const D = { yaw: 11, pitch: -10 };
    const ch = road(chooseRoad(clusters([[R, 60], [D, 140]]), { ...NONE, camera: R, cameraOffRoad: false }, C));
    expect(ch.rule).toBe('pitch');
    expect(near(ch.road, R)).toBe(true);
  });
  test('(b) a cluster in a default mirror rectangle relative to the other is not the road (the rear mirror is higher)', () => {
    const M = { yaw: R.yaw + 27, pitch: R.pitch + 10 };
    const ch = road(chooseRoad(clusters([[R, 150], [M, 50]]), NONE, C));
    expect(ch.rule).toBe('mirror');
    expect(near(ch.road, R)).toBe(true);
  });
  test('(d) side by side (the same pitch): the returns decide; fewer than returnMinN, or split, wait', () => {
    const D = { yaw: 14, pitch: -3 };
    const dirs = clusters([[R, 90], [D, 110]]);
    const back = (nRoad: number, nDisp: number) => [...Array.from({ length: nRoad }, () => R), ...Array.from({ length: nDisp }, () => D)];
    const ch = road(chooseRoad(dirs, { ...NONE, returns: back(6, 1) }, C));
    expect(ch.rule).toBe('returns');
    expect(near(ch.road, R)).toBe(true);
    expect(chooseRoad(dirs, { ...NONE, returns: back(4, 1) }, C)).toBe('wait');
    expect(chooseRoad(dirs, { ...NONE, returns: back(5, 3) }, C)).toBe('wait');
  });
  test('a single cluster at an off-road camera is the phone screen: wait (no pass)', () => {
    const cam = { yaw: 25, pitch: -15 };
    expect(chooseRoad(clusters([[cam, 200]]), { ...NONE, camera: cam, cameraOffRoad: true }, C)).toBe('wait');
    expect(road(chooseRoad(clusters([[cam, 200]]), { ...NONE, camera: cam, cameraOffRoad: false }, C)).rule).toBe('single');
  });
  // C9 round 1 (C9-1): up to three clusters, mirrors dropped first.
  test('a display, a frequent mirror and the road: the mirror is dropped, the road chosen over the display', () => {
    const D = { yaw: 11, pitch: -10 };
    const M = { yaw: R.yaw + 27, pitch: R.pitch + 10 };
    const ch = road(chooseRoad(clusters([[D, 110], [M, 50], [R, 40]]), NONE, C));
    expect(ch.rule).toBe('pitch');
    expect(near(ch.road, R)).toBe(true);
    expect(near(ch.other!, D)).toBe(true);
    expect(ch.excluded!.some((x) => near(x, M))).toBe(true);
    // the driver's mirror (relative to the road and to the display) is dropped too
    const M2 = { yaw: R.yaw - 45, pitch: R.pitch };
    expect(near(road(chooseRoad(clusters([[D, 110], [M2, 50], [R, 40]]), NONE, C)).road, R)).toBe(true);
  });
  test('the confidence leaves out every non-road core, each to max(ρ, min(2ρ, half its distance to the road))', () => {
    const R0 = { yaw: 0, pitch: 0 };
    const D = { yaw: 16, pitch: -8 };
    const M = { yaw: 27, pitch: 10 };
    const dirs = clusters([[R0, 20], [D, 60], [M, 20]], 3, 0.5);
    const ch: RoadChoice = { road: R0, other: D, rule: 'pitch', excluded: [D, M] };
    expect(roadConfidence(dirs, ch, 15, 5)).toBeCloseTo(1, 5);
    expect(roadConfidence(dirs, { ...ch, excluded: [D] }, 15, 5)).toBeCloseTo(0.5, 5);
  });
  test('a second peak within 2ρ is the first cluster\'s own spread, not a cluster', () => {
    const ch = road(chooseRoad(clusters([[R, 120], [{ yaw: R.yaw + 6, pitch: R.pitch }, 80]]), NONE, C));
    expect(ch.other).toBeNull();
  });
});

describe('C9 round 2 (review-C9 C9r1-1): the returns before the pitch, when beyond the occupancy', () => {
  const R = { yaw: 2, pitch: -3 };
  const HIGH = { yaw: 2, pitch: 6 };
  const back = (nRoad: number, nDisp: number, disp: AnglePair) => [...Array.from({ length: nRoad }, () => R), ...Array.from({ length: nDisp }, () => disp)];
  test('a 60 % display ABOVE the road, the driver back on the road after each check: the returns pick the road', () => {
    const dirs = clusters([[HIGH, 120], [R, 80]]);
    expect(road(chooseRoad(dirs, NONE, C)).road.pitch).toBeGreaterThan(3); // the pitch prior alone: the display
    const ch = road(chooseRoad(dirs, { ...NONE, returns: back(8, 0, HIGH) }, C));
    expect(ch.rule).toBe('returns');
    expect(near(ch.road, R)).toBe(true);
  });
  test('returns that only follow the occupancy (an 85 % display taken straight back) leave it to the pitch', () => {
    const LOW = { yaw: 11, pitch: -10 };
    const dirs = clusters([[LOW, 170], [R, 30]]);
    const ch = road(chooseRoad(dirs, { ...NONE, returns: back(0, 8, LOW) }, C));
    expect(ch.rule).toBe('pitch');
    expect(near(ch.road, R)).toBe(true);
  });
  test('binomialTail', () => {
    expect(binomialTail(8, 8, 0.5)).toBeCloseTo(1 / 256, 10);
    expect(binomialTail(8, 0, 0.3)).toBe(1);
    expect(binomialTail(8, 9, 0.3)).toBe(0);
    expect(binomialTail(10, 3, 0.2)).toBeCloseTo(0.3222004736, 8);
    expect(binomialTail(6, 6, 1)).toBeCloseTo(1, 12);
  });
});

describe('roadConfidence (S1-1): the other cluster\'s core is excluded', () => {
  test('a 60 % display: the road\'s share of the rest', () => {
    const R = { yaw: 0, pitch: 0 };
    const D = { yaw: 16, pitch: -8 };
    const dirs = clusters([[R, 40], [D, 60]], 3, 0.5);
    const ch: RoadChoice = { road: R, other: D, rule: 'pitch' };
    expect(roadConfidence(dirs, ch, 15, 5)).toBeCloseTo(1, 5);
    expect(roadConfidence(dirs, { ...ch, other: null }, 15, 5)).toBeCloseTo(0.4, 5);
    expect(roadSide({ yaw: 7, pitch: -3 }, ch)).toBe(true);
    expect(roadSide({ yaw: 9, pitch: -5 }, ch)).toBe(false);
  });
});

describe('fixationMedians (S1-1, deviation): half-second blocks', () => {
  test('medians of consecutive blocks; a stray frame does not move one; a gap ends a block; single frames drop', () => {
    const xs: { t: number; a: AnglePair | null; w: number }[] = [];
    for (let i = 0; i < 8; i++) xs.push({ t: i * 66, a: { yaw: i === 3 ? 40 : 1, pitch: -2 }, w: 0.066 });
    xs.push({ t: 2000, a: { yaw: 9, pitch: 9 }, w: 0.066 });
    const f = fixationMedians(xs, 500);
    expect(f.dirs).toHaveLength(1);
    expect(f.dirs[0]!.yaw).toBe(1);
    expect(f.dirs[0]!.w).toBeCloseTo(8 * 0.066, 6);
    expect(f.perBlock).toBe(8);
  });
});
