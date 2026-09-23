// Zone learning (plan §M4): fixations, DBSCAN, mirror candidates, and promotion across drives on one
// mount (the profile carries the learned zones; profiles are per mount signature).
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../config';
import type { LearnedZone } from '../profile';
import { createZoneLearner, dbscan } from '../zoneLearning';
import { gauss, rng } from '../__fixtures__/synth';

const C = DEFAULT_DMS_CONFIG as DmsConfig;

describe('DBSCAN (ε 3°, minPts 5)', () => {
  test('three seeded clusters and scattered noise', () => {
    const r = rng(3);
    const pts: { yaw: number; pitch: number }[] = [];
    const centres = [
      { yaw: 27, pitch: 9 },
      { yaw: -45, pitch: 0 },
      { yaw: 0, pitch: -18 },
    ];
    for (const c of centres) for (let i = 0; i < 20; i++) pts.push({ yaw: c.yaw + gauss(r) * 0.8, pitch: c.pitch + gauss(r) * 0.8 });
    const noise = [
      { yaw: 60, pitch: 30 },
      { yaw: -70, pitch: -40 },
      { yaw: 10, pitch: 40 },
    ];
    pts.push(...noise);
    const labels = dbscan(pts, 3, 5);
    const byCluster = (k: number) => labels.slice(k * 20, k * 20 + 20);
    for (let k = 0; k < 3; k++) {
      const ls = byCluster(k);
      expect(new Set(ls).size).toBe(1);
      expect(ls[0]).toBeGreaterThanOrEqual(0);
    }
    expect(new Set([byCluster(0)[0], byCluster(1)[0], byCluster(2)[0]]).size).toBe(3);
    expect(labels.slice(60)).toEqual([-1, -1, -1]);
  });
  test('fewer than minPts neighbours is noise', () => {
    expect(dbscan([{ yaw: 0, pitch: 0 }, { yaw: 1, pitch: 0 }, { yaw: 0, pitch: 1 }, { yaw: 1, pitch: 1 }], 3, 5)).toEqual([-1, -1, -1, -1]);
  });
});

/** One drive: `glances` fixations of `durMs` at `at` (off-road, calibrated), 15 fps, 1.5 s apart. */
function drive(prior: LearnedZone[], at: { yaw: number; pitch: number }, glances: number, durMs: number, seed = 1): LearnedZone[] {
  const learner = createZoneLearner(C, prior);
  const r = rng(seed);
  let t = 0;
  for (let g = 0; g < glances; g++) {
    const y = at.yaw + gauss(r) * 1.2;
    const p = at.pitch + gauss(r) * 1.2;
    for (let s = 0; s < durMs; s += 66.67) {
      learner.observe(t, { yaw: y + gauss(r) * 0.2, pitch: p + gauss(r) * 0.2 }, 'other', true);
      t += 66.67;
    }
    learner.observe(t, { yaw: 0, pitch: 0 }, 'road_centre', true); // back on the road
    t += 1500;
  }
  learner.cluster();
  return learner.endDrive();
}

describe('fixations', () => {
  test('≥ 200 ms within 2° while off-road and calibrated; not on-road; not before calibration', () => {
    const l = createZoneLearner(C, []);
    const at = (t: number, yaw: number, zone: 'other' | 'road_centre' = 'other', cal = true) => l.observe(t, { yaw, pitch: 0 }, zone, cal);
    for (let t = 0; t <= 266; t += 66.67) at(t, 30); // 5 samples, 266 ms
    at(300, 0, 'road_centre');
    expect(l.fixationCount()).toBe(1);
    for (let t = 400; t <= 520; t += 66.67) at(t, 30); // 133 ms: too short
    at(600, 0, 'road_centre');
    expect(l.fixationCount()).toBe(1);
    for (let t = 700; t <= 1000; t += 66.67) at(t, 30, 'other', false); // not calibrated
    at(1100, 0, 'road_centre');
    expect(l.fixationCount()).toBe(1);
  });
  test('a sweep wider than 2° is not a fixation', () => {
    const l = createZoneLearner(C, []);
    for (let i = 0; i < 10; i++) l.observe(i * 66.67, { yaw: 30 + i * 1.0, pitch: 0 }, 'other', true); // 15°/s
    l.observe(700, { yaw: 0, pitch: 0 }, 'road_centre', true);
    expect(l.fixationCount()).toBe(0);
  });
  test('capped at 600 per drive', () => {
    const l = createZoneLearner(C, []);
    let t = 0;
    for (let g = 0; g < 650; g++) {
      for (let s = 0; s < 4; s++) l.observe((t += 66.67), { yaw: 30, pitch: 0 }, 'other', true);
      l.observe((t += 66.67), { yaw: 0, pitch: 0 }, 'road_centre', true);
    }
    expect(l.fixationCount()).toBe(600);
  });
});

describe('mirror candidates and promotion', () => {
  const NEAR_REAR = { yaw: 36, pitch: 17 }; // ~2° outside the default rear-mirror rectangle: within 10°
  test('brief glances near a default mirror are a candidate; the learned zone is promoted only at the third drive', () => {
    let zones = drive([], NEAR_REAR, 20, 500, 1);
    expect(zones).toHaveLength(1);
    expect(zones[0]).toMatchObject({ id: 'rear_mirror', drives: 1 });
    expect(createZoneLearner(C, zones).promoted()).toEqual({});
    zones = drive(zones, NEAR_REAR, 20, 500, 2);
    expect(zones[0]!.drives).toBe(2);
    expect(createZoneLearner(C, zones).promoted()).toEqual({});
    zones = drive(zones, NEAR_REAR, 20, 500, 3);
    expect(zones[0]!.drives).toBe(3);
    const promoted = createZoneLearner(C, zones).promoted();
    expect(Object.keys(promoted)).toEqual(['rear_mirror']);
    const rear = promoted.rear_mirror!;
    expect(Math.abs(rear.yawDeg - NEAR_REAR.yaw)).toBeLessThan(1);
    expect(Math.abs(rear.pitchDeg - NEAR_REAR.pitch)).toBeLessThan(1);
    expect(rear.halfYawDeg).toBeGreaterThanOrEqual(4); // ±2σ, at least 4°
    expect(rear.halfPitchDeg).toBeGreaterThanOrEqual(4);
  });
  test('a cluster far from every default mirror is never a candidate', () => {
    expect(drive([], { yaw: 0, pitch: -40 }, 20, 500)).toEqual([]);
  });
  test('long fixations (median ≥ 1 s) near a mirror are not a mirror', () => {
    expect(drive([], NEAR_REAR, 20, 1500)).toEqual([]);
  });
  test('a drive without the candidate keeps the prior as it was', () => {
    const prior: LearnedZone[] = [{ id: 'driver_mirror', yawDeg: -45, pitchDeg: 0, halfYawDeg: 5, halfPitchDeg: 4, drives: 2 }];
    expect(drive(prior, { yaw: 0, pitch: -40 }, 20, 500)).toEqual(prior);
  });
});

test('clustering runs every 5 min of driving', () => {
  const l = createZoneLearner(C, []);
  expect(l.maybeCluster(299)).toBe(false);
  expect(l.maybeCluster(300)).toBe(true);
  expect(l.maybeCluster(599)).toBe(false);
  expect(l.maybeCluster(600)).toBe(true);
});
