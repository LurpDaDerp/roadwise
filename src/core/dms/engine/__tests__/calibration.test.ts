// Road-centre calibration (plan §M3): admission, the smoothed 2-D histogram mode, radius, confidence,
// per-source centres, the evaluation schedule, the drift-capped EMA, the provisional EAR, the frozen
// Stage 1 EAR, the neutral MAR floor, seeds and warm start, the step-test bump and frame-rate invariance.
import { createCalibrator, seedFromFrames } from '../calibration';
import { angularDistanceDeg } from '../angles';
import { DEFAULT_DMS_CONFIG, resolveDmsConfig, type DmsConfig } from '../config';
import { evaluateCluster } from '../histogram';
import type { DmsProfileV1 } from '../profile';
import { perceive, perceiver, roadSampler, stream, type Item } from '../__fixtures__/harness';
import { gauss, rng } from '../__fixtures__/synth';

const C = DEFAULT_DMS_CONFIG as DmsConfig;
const TRUTH = { yaw: -3, pitch: 2 };
const dist = (a: { yaw: number; pitch: number }, b: { yaw: number; pitch: number }) => angularDistanceDeg(a, b);

function calibrated(fps = 15, seconds = 90, seed = 7) {
  const cal = createCalibrator(C, { driverSide: 'left' });
  const items = stream({ fps, seconds, seed, sample: roadSampler(TRUTH) });
  perceive(C, cal, items);
  return { cal, items };
}

describe('mode, not mean (spec Stage 1 step 4)', () => {
  test('the mode lands within 0.5° of the road centre while the mean is pulled > 3° away', () => {
    const { cal, items } = calibrated();
    expect(cal.state()).toBe('calibrated');
    expect(dist(cal.centre('geometric')!, TRUTH)).toBeLessThan(0.5);
    // The mean of the same gaze stream (driver frame: LHD negates the camera yaw).
    let y = 0;
    let p = 0;
    for (const it of items) {
      const e = it.frame.eyeR!;
      y += -(it.frame.head!.yaw + (Math.asin(e.ox / 0.43) * 180) / Math.PI);
      p += it.frame.head!.pitch + (Math.asin(e.oy / 0.43) * 180) / Math.PI;
    }
    expect(dist({ yaw: y / items.length, pitch: p / items.length }, TRUTH)).toBeGreaterThan(3);
    expect(cal.drainEvents().map((e) => e.kind)).toContain('calibrated');
  });

  test('the head centre is learned too, and the roll offset is the median admitted head roll', () => {
    const cal = createCalibrator(C, { driverSide: 'left' });
    perceive(C, cal, stream({ fps: 15, seconds: 90, seed: 3, sample: (t, r) => ({ ...roadSampler(TRUTH)(t, r), headDrv: { yaw: -1, pitch: 1, roll: 4 + gauss(r) * 0.2 } }) }));
    expect(cal.state()).toBe('calibrated');
    expect(dist(cal.centre('head')!, { yaw: -1, pitch: 1 })).toBeLessThan(0.5);
    expect(cal.rollOffset()).toBeCloseTo(4, 0);
  });
});

describe('the cluster statistics', () => {
  const cluster = (sd: number, n: number, seed: number) => {
    const r = rng(seed);
    return Array.from({ length: n }, () => ({ yaw: gauss(r) * sd, pitch: gauss(r) * sd, w: 0.0667 }));
  };
  test('the radius is clamped to 8° for a tight cluster and to 15° for a broad one', () => {
    expect(evaluateCluster(cluster(1.5, 3000, 1), C)!.radius).toBe(8);
    const wide = resolveDmsConfig({ calibration: { confidenceWithinDeg: 30 } });
    expect(evaluateCluster(cluster(12, 3000, 2), wide)!.radius).toBe(15);
    const mid = evaluateCluster(cluster(5, 3000, 3), C)!.radius;
    expect(mid).toBeGreaterThan(8);
    expect(mid).toBeLessThan(15);
  });
  test('confidence: 71 % of the weight within 15° of the mode passes, 69 % fails', () => {
    const mk = (share: number) => [
      ...cluster(1, 1000, 4).map((s) => ({ ...s, w: share / 1000 })),
      ...Array.from({ length: 100 }, (_, i) => ({ yaw: 40 + (i % 10) * 0.1, pitch: -30, w: (1 - share) / 100 })),
    ];
    expect(evaluateCluster(mk(0.71), C)!.share).toBeGreaterThanOrEqual(0.7);
    expect(evaluateCluster(mk(0.71), C)!.passed).toBe(true);
    expect(evaluateCluster(mk(0.69), C)!.passed).toBe(false);
  });
});

describe('admission (§M3)', () => {
  test.each([
    ['turning (straight flag false)', { straight: false }],
    ['GNSS invalid (straight flag unknown)', { straight: null }],
    ['below 20 km/h', { speedKmh: 19 }],
    ['no context row', null],
  ])('nothing is admitted while %s', (_n, over) => {
    const cal = createCalibrator(C, { driverSide: 'left' });
    perceive(C, cal, stream({ fps: 15, seconds: 120, sample: roadSampler(TRUTH), ctx: () => over }));
    expect(cal.stats().admittedS).toBe(0);
    expect(cal.state()).toBe('none');
  });
  test('nothing is admitted in HEAD_ONLY', () => {
    const cal = createCalibrator(C, { driverSide: 'left' });
    perceive(C, cal, stream({ fps: 15, seconds: 120, sample: (t, r) => ({ ...roadSampler(TRUTH)(t, r), blur: 5 }) }));
    expect(cal.stats().admittedS).toBe(0);
  });
  test('each admitted frame weighs its dt, capped at 0.2 s', () => {
    const cal = createCalibrator(C, { driverSide: 'left' });
    perceive(C, cal, stream({ fps: 2, seconds: 10, sample: roadSampler(TRUTH) }));
    expect(cal.stats().admittedS).toBeCloseTo(19 * 0.2, 9); // the first frame has no dt
  });
});

describe('the evaluation schedule and the outcome states', () => {
  test('no pass before 60 s of driving at ≥ 20 km/h', () => {
    const cal = createCalibrator(C, { driverSide: 'left' });
    perceive(C, cal, stream({ fps: 15, seconds: 59, sample: roadSampler(TRUTH) }));
    expect(cal.state()).toBe('none');
  });
  test('after 180 s without a pass: uncalibrated (no seed), provisional (with a seed)', () => {
    const diffuse = (_t: number, r: () => number) => ({ gazeDrv: { yaw: (r() - 0.5) * 120, pitch: (r() - 0.5) * 80 } });
    const cal = createCalibrator(C, { driverSide: 'left' });
    perceive(C, cal, stream({ fps: 10, seconds: 185, sample: diffuse }));
    expect(cal.state()).toBe('uncalibrated');
    const seed = { gazeCentres: { geometric: { yaw: 0, pitch: 0 }, net: null }, headCentre: { yaw: 0, pitch: 0 }, rollOffsetDeg: 0, mount: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, boxCx: 0.5, boxCy: 0.45, iod: 0.2 }, orientation: 90 as const, openEyeEar: { r: 0.3, l: 0.3 } };
    const seeded = createCalibrator(C, { driverSide: 'left', seed });
    expect(seeded.state()).toBe('seeded');
    perceive(C, seeded, stream({ fps: 10, seconds: 185, sample: diffuse }));
    expect(seeded.state()).toBe('provisional');
  });
});

describe('per-source centres (rev1 R-gaze)', () => {
  test('geometric and net converge within 0.5° of each one\'s own truth over the same stream', () => {
    const cal = createCalibrator(C, { driverSide: 'left' });
    const bias = { yaw: 4, pitch: -2.5 };
    perceive(
      C,
      cal,
      stream({
        fps: 15,
        seconds: 90,
        seed: 11,
        sample: (t, r) => {
          const s = roadSampler(TRUTH)(t, r);
          return { ...s, netDrv: { yaw: s.gazeDrv!.yaw + bias.yaw + gauss(r) * 0.5, pitch: s.gazeDrv!.pitch + bias.pitch + gauss(r) * 0.5 } };
        },
      })
    );
    expect(dist(cal.centre('geometric')!, TRUTH)).toBeLessThan(0.5);
    expect(dist(cal.centre('net')!, { yaw: TRUTH.yaw + bias.yaw, pitch: TRUTH.pitch + bias.pitch })).toBeLessThan(0.5);
    // Calibrated on the net as the configured source, too.
    const netCfg = resolveDmsConfig({ gazeSource: 'net' });
    const cal2 = createCalibrator(netCfg, { driverSide: 'left' });
    perceive(netCfg, cal2, stream({ fps: 15, seconds: 90, seed: 11, sample: (t, r) => {
      const s = roadSampler(TRUTH)(t, r);
      return { ...s, netDrv: { yaw: s.gazeDrv!.yaw + bias.yaw, pitch: s.gazeDrv!.pitch + bias.pitch } };
    } }));
    expect(cal2.state()).toBe('calibrated');
  });
});

describe('staying calibrated: the EMA and its drift cap', () => {
  function stare(cfg: DmsConfig) {
    const cal = createCalibrator(cfg, { driverSide: 'left' });
    const run = perceiver(cfg, cal);
    run(stream({ fps: 15, seconds: 90, seed: 5, sample: roadSampler(TRUTH) }));
    const before = cal.centre('geometric')!;
    // 10 min of staring 12° below the centre: inside radius + 5°, admitted, straight road.
    run(stream({ fps: 10, seconds: 600, fromMs: 90_000, seed: 6, sample: (_t, r) => ({ gazeDrv: { yaw: TRUTH.yaw + gauss(r) * 0.5, pitch: TRUTH.pitch - 12 + gauss(r) * 0.5 } }) }));
    return dist(cal.centre('geometric')!, before);
  }
  test('10 min of phone-staring moves the centre by at most 5° (0.5°/min)', () => {
    expect(stare(C)).toBeLessThanOrEqual(5.0001);
    expect(stare(C)).toBeGreaterThan(3); // it does move: the EMA is live
  });
});

describe('open-eye EAR', () => {
  test('the provisional EAR exists after 20 s of TRACKING, before any centre (§M3, rev1 m6)', () => {
    const cal = createCalibrator(C, { driverSide: 'left' });
    const run = perceiver(C, cal);
    const r = rng(9);
    const ears = (s: number) => stream({ fps: 15, seconds: s, sample: () => ({ gazeDrv: TRUTH, ear: [0.28 + r() * 0.04, 0.26 + r() * 0.04] }), ctx: () => ({ speedKmh: 15 }) });
    run(ears(19));
    expect(cal.openEyeEar()).toBeNull();
    run(ears(2).map((it) => ({ ...it, frame: { ...it.frame, tMs: it.frame.tMs + 19_000 } })));
    const e = cal.openEyeEar()!;
    expect(cal.centre('geometric')).toBeNull();
    expect(e.r!).toBeGreaterThan(0.31);
    expect(e.r!).toBeLessThanOrEqual(0.32);
    expect(e.l!).toBeGreaterThan(0.29);
  });
  test('at the calibration pass the EAR is the p90 of admitted frames, then frozen for the drive', () => {
    const cal = createCalibrator(C, { driverSide: 'left' });
    const run = perceiver(C, cal);
    run(stream({ fps: 15, seconds: 90, seed: 2, sample: (t, r) => ({ ...roadSampler(TRUTH)(t, r), ear: [0.3, 0.3] }) }));
    expect(cal.state()).toBe('calibrated');
    expect(cal.openEyeEar()).toEqual({ r: 0.3, l: 0.3 });
    run(stream({ fps: 15, seconds: 120, fromMs: 90_000, seed: 3, sample: (t, r) => ({ ...roadSampler(TRUTH)(t, r), ear: [0.4, 0.4] }) }));
    expect(cal.openEyeEar()).toEqual({ r: 0.3, l: 0.3 });
  });
  test('the neutral MAR is floored at 0.05 (rev1 I4, C-23); the neutral mouth width is the median', () => {
    const cal = createCalibrator(C, { driverSide: 'left' });
    perceive(C, cal, stream({ fps: 15, seconds: 90, sample: (t, r) => ({ ...roadSampler(TRUTH)(t, r), mar: 0.02, mouthW: 0.85 }) }));
    expect(cal.neutralMar()).toBe(0.05);
    expect(cal.neutralMouthW()).toBeCloseTo(0.85, 12);
  });
});

test('the pitch reference: the running median head pitch before calibration, the head centre after (rev1 m6)', () => {
  const cal = createCalibrator(C, { driverSide: 'left' });
  const run = perceiver(C, cal);
  run(stream({ fps: 15, seconds: 10, sample: () => ({ gazeDrv: { yaw: 0, pitch: 0 }, headDrv: { yaw: 0, pitch: 7 } }), ctx: () => ({ speedKmh: 5 }) }));
  expect(cal.pitchReference()).toBeCloseTo(7, 9);
});

describe('the step-test bump (rev1 m5)', () => {
  /** Calibrated, then a head-yaw step of 10° and a box shift of 0.1 over `rampS` seconds. */
  function bumpRun(rampS: number, boxShift: number) {
    const cal = createCalibrator(C, { driverSide: 'left' });
    const run = perceiver(C, cal);
    run(stream({ fps: 15, seconds: 90, seed: 4, sample: roadSampler(TRUTH) }));
    cal.drainEvents();
    const t0 = 95;
    const k = (t: number) => Math.min(1, Math.max(0, (t - t0) / rampS));
    run(
      stream({
        fps: 15,
        seconds: 20,
        fromMs: 90_000,
        seed: 5,
        sample: (t, r) => ({
          gazeDrv: { yaw: TRUTH.yaw + gauss(r) + 10 * k(t), pitch: TRUTH.pitch + gauss(r) },
          headDrv: { yaw: 10 * k(t) + gauss(r) * 0.1, pitch: gauss(r) * 0.1 },
          box: { cx: 0.5 + boxShift * k(t), cy: 0.45 },
        }),
      })
    );
    return cal;
  }
  test('a step over 1.9 s with the box moving is a camera bump: recalibrating, centres discarded', () => {
    const cal = bumpRun(1.9, 0.1);
    expect(cal.drainEvents().map((e) => e.kind)).toContain('camera_bump');
    expect(cal.state()).toBe('recalibrating');
    expect(cal.centre('geometric')).toBeNull();
    expect(cal.openEyeEar()).not.toBeNull(); // baselines kept
  });
  test('the same step spread over 2.1 s is not', () => {
    expect(bumpRun(2.1, 0.1).drainEvents().map((e) => e.kind)).not.toContain('camera_bump');
  });
  test('a head turn alone (the box does not move) is not', () => {
    expect(bumpRun(0.5, 0).drainEvents().map((e) => e.kind)).not.toContain('camera_bump');
  });
});

describe('seeds and warm start (§M3, C-5, C-6)', () => {
  const trackingItems = (sd: number, seconds: number): Item[] =>
    stream({ fps: 15, seconds, seed: 8, sample: (_t, r) => ({ gazeDrv: { yaw: 2 + gauss(r) * sd, pitch: 1 + gauss(r) * sd } }), ctx: () => ({ speedKmh: 0 }) });
  function seedFrom(items: Item[]) {
    const cal = createCalibrator(C, { driverSide: 'left' });
    const ps = perceive(C, cal, items);
    return seedFromFrames(items.map((it, i) => ({ frame: it.frame, p: ps[i]! })), C, 'left');
  }
  test('the C2 seed needs ≥ 2 s of TRACKING frames and a gaze SD ≤ 3°', () => {
    const ok = seedFrom(trackingItems(1, 3));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(dist(ok.seed.gazeCentres.geometric!, { yaw: 2, pitch: 1 })).toBeLessThan(1);
    expect(seedFrom(trackingItems(1, 1.9))).toEqual({ ok: false, reason: 'too_short' });
    expect(seedFrom(trackingItems(5, 3))).toEqual({ ok: false, reason: 'unsteady' });
  });

  const MOUNT = { yawDeg: 0, pitchDeg: 0, rollDeg: 0, boxCx: 0.5, boxCy: 0.45, iod: 0.2 };
  const profile = (mount = MOUNT): DmsProfileV1 => ({
    v: 1,
    driverSide: 'left',
    orientation: 90,
    mount,
    gazeCentres: { geometric: { yaw: -3, pitch: 2 } },
    headCentre: { yaw: 0, pitch: 0 },
    rollOffsetDeg: 0,
    radiusDeg: 9,
    openEyeEar: [0.31, 0.29],
    neutralMar: 0.06,
    neutralMouthW: 0.9,
    learnedZones: [],
    savedAtMs: 1,
  });
  function warm(mount = MOUNT) {
    const cal = createCalibrator(C, { driverSide: 'left', profile: profile(mount) });
    perceive(C, cal, stream({ fps: 15, seconds: 6, sample: () => ({ gazeDrv: TRUTH, headDrv: { yaw: 0, pitch: 0 } }), ctx: () => ({ speedKmh: 30 }) }));
    return cal;
  }
  test('a matching mount signature warm-starts from the profile', () => {
    const cal = warm();
    expect(cal.state()).toBe('seeded');
    expect(cal.centre('geometric')).toEqual({ yaw: -3, pitch: 2 });
    expect(cal.openEyeEar()).toEqual({ r: 0.31, l: 0.29 });
    expect(cal.drainEvents().map((e) => e.kind)).toContain('warm_start');
  });
  test.each([
    ['head yaw', { yawDeg: 3.9 }, { yawDeg: 4.1 }],
    ['head pitch', { pitchDeg: -3.9 }, { pitchDeg: -4.1 }],
    ['head roll', { rollDeg: 2.9 }, { rollDeg: 3.1 }],
    ['box', { boxCx: 0.549 }, { boxCx: 0.551 }],
    ['IOD', { iod: 0.2 / 1.099 }, { iod: 0.2 / 1.101 }],
  ])('%s: inside the tolerance warm-starts, one step past it does not', (_n, inside, outside) => {
    expect(warm({ ...MOUNT, ...inside }).state()).toBe('seeded');
    const cal = warm({ ...MOUNT, ...outside });
    expect(cal.state()).toBe('none');
    expect(cal.centre('geometric')).toBeNull();
  });
});

describe('frame-rate invariance', () => {
  test('the same stream at 5, 15 and 30 fps gives centres within 0.1°', () => {
    // One continuous signal (not i.i.d. draws), so every rate samples the same thing: a slow wander
    // that dwells near the centre (sin³), with a mirror and a lap glance every 10 s.
    const sample = (t: number) => {
      const ph = t % 10;
      const g =
        ph < 8
          ? { yaw: TRUTH.yaw + 4 * Math.sin(0.3 * t) ** 3, pitch: TRUTH.pitch + 4 * Math.sin(0.21 * t + 1) ** 3 }
          : ph < 9
            ? { yaw: 28, pitch: 9 }
            : { yaw: 18, pitch: -34 };
      return { gazeDrv: g, headDrv: { yaw: 0.4 * g.yaw, pitch: 0.4 * g.pitch } };
    };
    const centres = [5, 15, 30].map((fps) => {
      const cal = createCalibrator(C, { driverSide: 'left' });
      perceive(C, cal, stream({ fps, seconds: 62, sample }));
      expect(cal.state()).toBe('calibrated');
      return cal.centre('geometric')!;
    });
    expect(dist(centres[0]!, centres[1]!)).toBeLessThan(0.1);
    expect(dist(centres[2]!, centres[1]!)).toBeLessThan(0.1);
  });
});
