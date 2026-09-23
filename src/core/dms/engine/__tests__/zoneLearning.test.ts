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

describe('T7 review round 1', () => {
  /** The rev0 queue (shift, every neighbour pushed): the reference for label equivalence. */
  function naiveDbscan(points: { yaw: number; pitch: number }[], eps: number, minPts: number): number[] {
    const n = points.length;
    const labels = new Array<number>(n).fill(-2);
    const near = (i: number) => points.map((_, j) => j).filter((j) => Math.hypot(points[i]!.yaw - points[j]!.yaw, points[i]!.pitch - points[j]!.pitch) <= eps);
    let c = 0;
    for (let i = 0; i < n; i++) {
      if (labels[i] !== -2) continue;
      const nb = near(i);
      if (nb.length < minPts) {
        labels[i] = -1;
        continue;
      }
      labels[i] = c;
      const q = [...nb];
      while (q.length > 0) {
        const j = q.shift()!;
        if (labels[j] === -1) labels[j] = c;
        if (labels[j] !== -2) continue;
        labels[j] = c;
        const nb2 = near(j);
        if (nb2.length >= minPts) q.push(...nb2);
      }
      c += 1;
    }
    return labels;
  }

  test('I1: 600 fixations in one 2° blob cluster with a queue never longer than n', () => {
    const r = rng(8);
    const pts = Array.from({ length: 600 }, () => ({ yaw: 27 + gauss(r) * 0.6, pitch: 9 + gauss(r) * 0.6 }));
    const stats = { maxQueue: 0 };
    const labels = dbscan(pts, 3, 5, stats);
    expect(new Set(labels)).toEqual(new Set([0]));
    expect(stats.maxQueue).toBeLessThanOrEqual(600);
  });

  test('I1: the labels equal the reference algorithm\'s on seeded clusters', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const r = rng(seed);
      const pts: { yaw: number; pitch: number }[] = [];
      for (let k = 0; k < 4; k++) {
        const c = { yaw: (r() - 0.5) * 80, pitch: (r() - 0.5) * 40 };
        const n = 5 + Math.floor(r() * 25);
        for (let i = 0; i < n; i++) pts.push({ yaw: c.yaw + gauss(r) * 1.5, pitch: c.pitch + gauss(r) * 1.5 });
      }
      for (let i = 0; i < 10; i++) pts.push({ yaw: (r() - 0.5) * 120, pitch: (r() - 0.5) * 80 });
      expect(dbscan(pts, 3, 5)).toEqual(naiveDbscan(pts, 3, 5));
    }
  });

  test('I2: candidates 10° apart over three drives never promote (recurrence in the same place)', () => {
    const A = { yaw: 36, pitch: 17 };
    const B = { yaw: 26, pitch: 17 };
    let zones = drive([], A, 20, 500, 1);
    zones = drive(zones, B, 20, 500, 2);
    expect(zones[0]!.drives).toBe(1); // replaced, not merged
    zones = drive(zones, A, 20, 500, 3);
    expect(zones[0]!.drives).toBe(1);
    expect(createZoneLearner(C, zones).promoted()).toEqual({});
  });

  test('I2: a wide cluster is capped at 10° half-width', () => {
    const learner = createZoneLearner(C, []);
    const r = rng(12);
    let t = 0;
    for (let g = 0; g < 200; g++) {
      const y = 30 + gauss(r) * 6;
      const p = 12 + gauss(r) * 6;
      for (let s = 0; s < 400; s += 66.67) learner.observe((t += 66.67), { yaw: y, pitch: p }, 'other', true);
      learner.observe((t += 66.67), { yaw: 0, pitch: 0 }, 'road_centre', true);
    }
    const zones = learner.endDrive();
    const rear = zones.find((z) => z.id === 'rear_mirror')!;
    expect(rear).toBeDefined();
    expect(rear.halfYawDeg).toBeLessThanOrEqual(10);
    expect(rear.halfPitchDeg).toBeLessThanOrEqual(10);
  });

  test('I2: an ellipse that would reach within 15° of the centre is rejected', () => {
    // Brief glances just right of the forward road, near the rear-mirror default (a windscreen phone mount).
    expect(drive([], { yaw: 18, pitch: 6 }, 20, 500)).toEqual([]);
  });

  test('I2: phone-screen frames are never learned', () => {
    const learner = createZoneLearner(C, []);
    let t = 0;
    for (let g = 0; g < 20; g++) {
      for (let s = 0; s < 500; s += 66.67) learner.observe((t += 66.67), { yaw: 36, pitch: 17 }, 'phone_screen', true);
      learner.observe((t += 66.67), { yaw: 0, pitch: 0 }, 'road_centre', true);
    }
    expect(learner.fixationCount()).toBe(0);
    expect(learner.endDrive()).toEqual([]);
  });

  test('m2: a 120 s steady stare is one fixation (a running window, no per-frame array)', () => {
    const learner = createZoneLearner(C, []);
    let t = 0;
    for (let i = 0; i < 1800; i++) learner.observe((t += 66.67), { yaw: 30, pitch: -40 }, 'lap', true);
    learner.observe((t += 66.67), { yaw: 0, pitch: 0 }, 'road_centre', true);
    expect(learner.fixationCount()).toBe(1);
  });

  test('m4: setPrior (on warm_start) is the only way a prior reaches promoted()', () => {
    const prior: LearnedZone[] = [{ id: 'rear_mirror', yawDeg: 30, pitchDeg: 12, halfYawDeg: 5, halfPitchDeg: 4, drives: 3 }];
    const learner = createZoneLearner(C, []);
    expect(learner.promoted()).toEqual({});
    learner.setPrior(prior);
    expect(Object.keys(learner.promoted())).toEqual(['rear_mirror']);
  });
});
