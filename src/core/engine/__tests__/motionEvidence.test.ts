/** @jest-environment node */
// Task C1: the shared motion evidence (calib-parked design rev4 §2.1.2, rev2 §2.1.2 C–F, rev5 §4).
// Rows are simulated from a true speed and acceleration profile, with the IMU fields a real
// extractor would give: aLonMean = true acceleration + bias + noise (aligned rows only).
import {
  createMotionEvidence,
  KMH_PER_G_S,
  MOTION_CONSTANTS,
  validateMotionConstants,
  type MotionEvidence,
} from '@/core/engine/motionEvidence';
import type { FeatureRow } from '@/core/engine/types';

const T0 = 1_800_000_000_000;
const G = 9.80665;

/** Deterministic noise (mulberry32), so every scenario is reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r: () => number): number {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/** One second of the simulated world. */
interface Sec {
  /** true acceleration over the second, g (positive = speeding up) */
  a: number;
  fix: boolean;
  aligned: boolean;
  /** accelerometer bias the sensor adds to aLonMean, g */
  bias: number;
  handling: number;
  /** extra spread of the second's extremes (road noise, a door slam) */
  extreme: number;
  accRms: number;
  /** the phone's gravity vector (device frame) */
  grav: [number, number, number] | null;
  /** row timestamp offset (a row gap) */
  skipMs: number;
  speedAcc: number;
  course: number;
}

const DEFAULT_SEC: Sec = {
  a: 0,
  fix: true,
  aligned: true,
  bias: 0,
  handling: 0,
  extreme: 0.015,
  accRms: 0.03,
  grav: [0, -0.7071, -0.7071],
  skipMs: 0,
  speedAcc: 0.5,
  course: 90,
};

interface SimRow {
  row: FeatureRow;
  /** the true speed at the row's end, km/h */
  trueKmh: number;
}

/**
 * A drive: `segments` of `n` seconds each with a spec. The true speed integrates `a` (never below 0);
 * aLonMean is the second's TRUE mean acceleration (Δv / g, so a stop mid-second reads less) plus the
 * bias plus N(0, noise) per row, with a quieter N(0, 0.002) for a car standing still. Extremes straddle
 * aLonMean by `extreme`.
 */
function simulate(v0Kmh: number, segments: [number, Partial<Sec>][], opts: { seed?: number; noise?: number } = {}): SimRow[] {
  const r = prng(opts.seed ?? 1);
  const noise = opts.noise ?? 0.01;
  let v = v0Kmh / 3.6;
  let t = T0;
  const out: SimRow[] = [];
  for (const [n, spec] of segments) {
    const s = { ...DEFAULT_SEC, ...spec };
    for (let i = 0; i < n; i++) {
      t += 1000 + s.skipMs;
      const vOld = v;
      v = Math.max(0, v + s.a * G);
      const aTrue = (v - vOld) / G;
      const still = v === 0 && vOld === 0;
      const aMean = s.aligned ? aTrue + s.bias + (still ? 0.002 : noise) * gauss(r) : 0;
      out.push({
        trueKmh: v * 3.6,
        row: {
          ts: t,
          lat: 47.6,
          lng: -122.3,
          hAcc: s.fix ? 5 : 9999,
          speed: s.fix ? Math.round(v * 100) / 100 : -1,
          speedAcc: s.fix ? s.speedAcc : -1,
          course: s.fix ? s.course : -1,
          alt: 10,
          gnssValid: s.fix,
          aLonMax: s.aligned ? aMean + s.extreme : 0,
          aLonMin: s.aligned ? aMean - s.extreme : 0,
          aLatMax: s.aligned ? 0.01 : 0,
          aLatMin: s.aligned ? -0.01 : 0,
          yawRateMax: 0.005,
          jerkMax: s.aligned ? 0.05 : 0,
          gravityStability: 0.99,
          orientationDelta: 0.01,
          handlingScore: s.handling,
          locked: true,
          screenOn: false,
          appForeground: true,
          frameAligned: s.aligned,
          aLonMean: Math.round(aMean * 1000) / 1000,
          accRms: s.accRms,
          gravX: s.grav?.[0] ?? null,
          gravY: s.grav?.[1] ?? null,
          gravZ: s.grav?.[2] ?? null,
        },
      });
    }
  }
  return out;
}

/**
 * The standard warm-up: 60 s aligned GNSS cruise at 50 km/h (the bias estimate), a GNSS brake from
 * 50 to about 28 km/h at 0.2 g over 3 s (the sign check), then 20 s of cruise.
 */
const WARMUP: [number, Partial<Sec>][] = [
  [60, {}],
  [3, { a: -0.2 }],
  [20, {}],
];

function run(rows: readonly SimRow[], c = MOTION_CONSTANTS, mounted = true) {
  const m = createMotionEvidence(c);
  return rows.map((s) => ({ ...s, ev: m.onRow(s.row, { mounted }) }));
}

type Ran = ReturnType<typeof run>;
const stops = (ran: Ran, kind: MotionEvidence['stop'] = 'sensor') => ran.filter((x) => x.ev.stop === kind);

describe('constants', () => {
  test('are valid as shipped, with their ordering constraints', () => {
    expect(validateMotionConstants()).toEqual([]);
    expect(KMH_PER_G_S).toBeCloseTo(G * 3.6, 9);
  });
  test.each([
    ['BIAS_G + 0.03 > BRAKE_EVIDENCE_G', { BIAS_G: 0.04 }],
    ['BRAKE_EVIDENCE_G at the documented residual', { BRAKE_EVIDENCE_G: 0.047 }],
    ['QUIET_MEAN_G ≥ BIAS_G', { QUIET_MEAN_G: 0.02 }],
    ['a horizon short enough that the proof could still pass', { INFERRED_MAX_HORIZON_S: 5 }],
    ['MOUNT_MATCH_RAD ≥ MOUNT_LOST_RAD', { MOUNT_MATCH_RAD: 0.4 }],
  ])('refuses %s', (_name, patch) => {
    expect(validateMotionConstants({ ...MOTION_CONSTANTS, ...patch }).length).toBeGreaterThan(0);
  });
});

describe('the GNSS stop and the moving evidence', () => {
  test('a known speed below 10 km/h is a GNSS stop on that row, and never latched', () => {
    const ran = run(simulate(30, [[5, {}], [4, { a: -0.25 }], [3, {}], [3, { a: 0.1 }]]));
    const first = ran.findIndex((x) => x.row.speed * 3.6 < 10);
    expect(ran[first]!.ev.stop).toBe('gnss');
    for (const x of ran) expect(x.ev.stop === 'gnss').toBe(x.row.speed >= 0 && x.row.speed * 3.6 < 10);
  });

  test('strong: a known speed ≥ 10 km/h, or aligned aLonMean − b̂ ≥ 0.08 g; weak: any other non-quiet row', () => {
    const ran = run(simulate(50, [...WARMUP, [2, { fix: false, a: 0.1 }], [2, { fix: false, extreme: 0.2 }]]));
    const n = ran.length;
    expect(ran[n - 5]!.ev.moving).toBe('strong'); // a known 50 km/h
    expect(ran[n - 4]!.ev.moving).toBe('strong'); // no fix, 0.1 g forward
    expect(ran[n - 4]!.ev.vehicleMotion).toBe(true);
    expect(ran[n - 1]!.ev.moving).toBe('weak'); // no fix, rough extremes, no forward acceleration
    expect(ran[n - 1]!.ev.vehicleMotion).toBe(false);
  });

  test('a handling row is never moving (NC-M5)', () => {
    const ran = run(simulate(50, [...WARMUP, [3, { fix: false, a: 0.1, handling: 0.8 }]]));
    for (const x of ran.slice(-3)) expect(x.ev.moving).toBeNull();
  });
});

describe('bias and trust (C-1, C-2)', () => {
  test('trust needs ≥ 30 cruise rows and a passed GNSS sign check', () => {
    const ran = run(simulate(50, WARMUP));
    expect(ran[40]!.ev.trust).toBe(false); // bias estimate ready, no sign check yet
    expect(ran[40]!.ev.bias?.n).toBeGreaterThanOrEqual(30);
    expect(ran[ran.length - 1]!.ev.trust).toBe(true);
  });

  test('a measured bias above BIAS_G refuses trust', () => {
    const ran = run(simulate(50, [[60, { bias: -0.03 }], [3, { a: -0.2, bias: -0.03 }], [20, { bias: -0.03 }]]));
    expect(ran[ran.length - 1]!.ev.bias!.bHat).toBeCloseTo(-0.03, 2);
    expect(ran[ran.length - 1]!.ev.trust).toBe(false);
  });

  test('S-AXIS: an inverted longitudinal sign fails the sign check, so there is never trust', () => {
    const rows = simulate(50, WARMUP);
    for (const s of rows) s.row.aLonMean = -(s.row.aLonMean ?? 0);
    const ran = run(rows);
    expect(ran.some((x) => x.ev.trust)).toBe(false);
  });

  test('an alignment reset ends the epoch: trust is lost until a new epoch earns it', () => {
    const ran = run(simulate(50, [...WARMUP, [1, { aligned: false }], [5, {}]]));
    expect(ran[WARMUP.reduce((n, [k]) => n + k, 0) - 1]!.ev.trust).toBe(true);
    expect(ran[ran.length - 1]!.ev.trust).toBe(false);
  });
});

/** Warm-up (ends at ~29 km/h), then the fix lost `lostBeforeS` seconds before a 0.25 g stop, then stopped. */
function canyon(lostBeforeS: number, stoppedS: number, opts: { seed?: number; noise?: number } = {}) {
  const brakeS = 4; // ~29 km/h at 0.25 g stops in 3.3 s; the 4th second ends at a standstill
  return simulate(
    50,
    [
      ...WARMUP,
      [Math.max(0, lostBeforeS - brakeS), { fix: false }],
      [brakeS, { fix: false, a: -0.25 }],
      [stoppedS, { fix: false, extreme: 0.01, accRms: 0.02 }],
    ],
    opts
  );
}

describe('the sensor stop (R1-2, R1-4a, R1-1)', () => {
  test('S-CANYON: the fix lost 4 s before a braking stop gives a sensor stop within 2 quiet rows of standstill', () => {
    const ran = run(canyon(4, 20));
    const s = stops(ran);
    expect(s.length).toBeGreaterThan(0);
    const firstStill = ran.findIndex((x, i) => i > 0 && x.trueKmh === 0);
    const firstStop = ran.indexOf(s[0]!);
    expect(firstStop - firstStill).toBeLessThanOrEqual(2);
    for (const x of s) expect(x.trueKmh).toBeLessThan(MOTION_CONSTANTS.STOP_KMH);
  });

  test('S-CANYON-90: once entered, the sensor stop holds for a 90 s light (the latch, NC-M4)', () => {
    const ran = run(canyon(4, 90));
    const first = ran.findIndex((x) => x.ev.stop === 'sensor');
    expect(first).toBeGreaterThan(0);
    for (const x of ran.slice(first)) expect(x.ev.stop).toBe('sensor');
  });

  test('S-CANYON-LATE: the fix lost 25 s before the stop cannot prove it (u has grown), so no sensor stop', () => {
    const ran = run(canyon(25, 30));
    expect(stops(ran)).toEqual([]);
    // …and the quiet no-fix run becomes ambiguous stillness after 10 s instead
    expect(ran[ran.length - 1]!.ev.ambiguousStill).toBe(true);
  });

  test('the horizon (NC-M3): even a near-perfect accelerometer cannot prove a stop 75 s after the fix', () => {
    // With no bias margin and a tiny noise, u stays small, so only the 60 s horizon refuses the proof.
    const c = { ...MOTION_CONSTANTS, BIAS_MARGIN_G: 0 };
    const segs: [number, Partial<Sec>][] = [...WARMUP, [71, { fix: false, speedAcc: 0.2 }], [4, { fix: false, a: -0.25, speedAcc: 0.2 }], [20, { fix: false, extreme: 0.01 }]];
    const late = run(simulate(50, segs, { noise: 0.0005 }), c);
    expect(stops(late)).toEqual([]);
    // …and the same stop 5 s after the fix is proven, so it is the horizon doing the refusing
    const early = run(simulate(50, [...WARMUP, [1, { fix: false }], [4, { fix: false, a: -0.25 }], [20, { fix: false, extreme: 0.01 }]], { noise: 0.0005 }), c);
    expect(stops(early).length).toBeGreaterThan(0);
  });

  test('the bound is STOP_KMH (10), not 5 km/h (NC-M7)', () => {
    expect(MOTION_CONSTANTS.STOP_KMH).toBe(10);
  });

  test('no trust, no sensor stop: the same canyon without the sign check', () => {
    const ran = run(simulate(35, [[60, {}], [4, { fix: false, a: -0.25 }], [20, { fix: false, extreme: 0.01 }]]));
    expect(stops(ran)).toEqual([]);
  });

  test('handling at the stop is not quiet: the stop waits for two quiet rows', () => {
    const rows = canyon(4, 20);
    const n = rows.length;
    for (let i = n - 20; i < n - 15; i++) rows[i]!.row.handlingScore = 0.7;
    const ran = run(rows);
    const first = ran.findIndex((x) => x.ev.stop === 'sensor');
    expect(first).toBeGreaterThanOrEqual(n - 15 + 1);
  });
});

describe('the latch exits', () => {
  const stoppedThen = (tail: [number, Partial<Sec>][]) => run(simulate(50, [...WARMUP, [4, { fix: false, a: -0.25 }], [10, { fix: false, extreme: 0.01 }], ...tail]));

  test('S-PULL: one strong row (0.08 g no-fix pull-away) ends it, and vLowKmh then grows from 0', () => {
    const ran = stoppedThen([[6, { fix: false, a: 0.1 }]]);
    const tail = ran.slice(-6);
    expect(tail[0]!.ev.stop).toBeNull();
    const lows = tail.map((x) => x.ev.vLowKmh ?? -1);
    expect(lows[5]!).toBeGreaterThan(lows[1]!);
    for (const x of tail) if (x.ev.vLowKmh !== null) expect(x.ev.vLowKmh).toBeLessThanOrEqual(x.trueKmh + 1e-9);
  });

  test('vLowKmh stays a lower bound when an unmeasured +0.05 g residual appears at the pull-away (NC-M8)', () => {
    const ran = stoppedThen([[8, { fix: false, a: 0.12, bias: 0.05 }], [20, { fix: false, bias: 0.05 }]]);
    const tail = ran.slice(-28);
    expect(tail.some((x) => (x.ev.vLowKmh ?? 0) > 0)).toBe(true);
    for (const x of tail) if (x.ev.vLowKmh !== null) expect(x.ev.vLowKmh).toBeLessThanOrEqual(x.trueKmh + 1e-6);
  });

  test('S-DOOR: one rough row (a door slam) is weak and does not end it; two weak rows do', () => {
    const one = stoppedThen([[1, { fix: false, extreme: 0.3, accRms: 0.3 }], [5, { fix: false, extreme: 0.01 }]]);
    for (const x of one.slice(-6)) expect(x.ev.stop).toBe('sensor');
    const two = stoppedThen([[2, { fix: false, extreme: 0.3, accRms: 0.3 }]]);
    expect(two[two.length - 1]!.ev.stop).toBeNull();
  });

  test('S-UNMOUNT: handling rows keep the stop (handling is never motion)', () => {
    const ran = stoppedThen([[10, { fix: false, extreme: 0.3, handling: 0.9 }]]);
    for (const x of ran.slice(-10)) expect(x.ev.stop).toBe('sensor');
  });

  test('S-IDLE: idle vibration (extremes ±0.04 g) for 10 min keeps it', () => {
    const ran = stoppedThen([[600, { fix: false, extreme: 0.04, accRms: 0.04 }]]);
    for (const x of ran.slice(-600)) expect(x.ev.stop).toBe('sensor');
  });

  test('a fix ends it: the GNSS rules take over', () => {
    const ran = stoppedThen([[3, { fix: true }]]);
    expect(ran[ran.length - 1]!.ev.stop).toBe('gnss');
  });

  test('a row gap ends it (judged by row.ts, M-4)', () => {
    const ran = stoppedThen([[1, { fix: false, extreme: 0.01, skipMs: 2000 }]]);
    expect(ran[ran.length - 1]!.ev.stop).toBeNull();
    expect(ran[ran.length - 1]!.ev.gap).toBe(true);
  });

  test('an alignment reset ends it (the evidence is gone)', () => {
    const ran = stoppedThen([[1, { fix: false, aligned: false }]]);
    expect(ran[ran.length - 1]!.ev.stop).toBeNull();
  });
});

describe('never a stop while moving', () => {
  test('S-TUN-BIAS: a 20 min smooth tunnel at 90 km/h with a constant bias, both signs, gives 0 stops', () => {
    const plain: [number, Partial<Sec>][] = [...WARMUP, [2, { a: 0.05 }], [1200, { fix: false, extreme: 0.01 }]];
    const withBias = (bias: number): [number, Partial<Sec>][] => plain.map(([n, spec]) => [n, { ...spec, bias }]);
    for (const bias of [-0.06, -0.045, -0.03, 0.03, 0.045, 0.06]) {
      const ran = run(simulate(90, withBias(bias)));
      expect(stops(ran)).toEqual([]);
    }
  });

  test('S-TUN-STEP (R1-2): braking 50 → 35 km/h after the fix is lost, then a post-brake bias step, gives 0 stops', () => {
    for (const bias of [-0.05, -0.03, -0.02, 0.02, 0.05]) {
      const ran = run(
        simulate(50, [...WARMUP, [10, { a: 0.03 }], [2, { fix: false }], [3, { fix: false, a: -0.15 }], [120, { fix: false, bias, extreme: 0.01 }]])
      );
      for (const x of ran) if (x.ev.stop === 'sensor') expect(x.trueKmh).toBeLessThan(10);
      expect(stops(ran)).toEqual([]);
    }
  });

  // The two residual shapes the quiet test alone does not stop: one that fades (the rows turn quiet
  // afterwards) and one just past the braking evidence. A good bias estimate (noise 0.003) keeps u small,
  // so only the braking-only rule (NC-M1) and the braking-peak rule (NC-M9) stand between them and a stop
  // at ~23 km/h.
  const afterBrake = (residual: [number, Partial<Sec>]) =>
    run(simulate(50, [...WARMUP, [10, { a: 0.03 }], [1, { fix: false }], [3, { fix: false, a: -0.15 }], [1, { fix: false }], residual, [12, { fix: false, extreme: 0.01 }]], { noise: 0.003 }));

  test('S-TUN-DECAY (NC-M1): a −0.047 g residual for 22 s after braking, then quiet cruise at ~23 km/h: 0 stops', () => {
    const ran = afterBrake([22, { fix: false, bias: -0.047, extreme: 0.06 }]);
    expect(ran[ran.length - 1]!.trueKmh).toBeGreaterThan(20); // ~23.5 km/h throughout: far above STOP_KMH
    expect(stops(ran)).toEqual([]);
  });

  test('S-TUN-TILT (NC-M9): 16 s at −0.065 g (past the evidence, short of the peak) after braking: 0 stops', () => {
    const ran = afterBrake([16, { fix: false, bias: -0.065, extreme: 0.06 }]);
    expect(ran[ran.length - 1]!.trueKmh).toBeGreaterThan(20); // ~23.5 km/h throughout: far above STOP_KMH
    expect(stops(ran)).toEqual([]);
  });

  // C1 round 1 (review-C1 m3): a −0.05 g residual starting on the row right after a real brake, so its
  // noisy rows at or below −0.06 g can chain onto the proven braking run. 200 seeds, 20–40 km/h after it.
  test('S-TUN-CHAINED (m3): a −0.05 g residual right after a real 0.15–0.3 g brake never gives a stop at speed (200 seeds)', () => {
    let chained = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const r = prng(seed * 104729);
      const brakeG = 0.15 + r() * 0.15;
      const brakeS = 1 + Math.floor(r() * 2); // 1–2 s
      const warmupDropKmh = 3 * 0.2 * KMH_PER_G_S; // the warm-up's GNSS brake
      const v0 = 25 + r() * 15 + brakeS * brakeG * KMH_PER_G_S + warmupDropKmh; // lands at 25–40 km/h after the brake
      // the residual for 20–25 s, then it fades and the cruise turns quiet (the rows a stop entry needs)
      const residualS = 20 + Math.floor(r() * 6);
      const ran = run(
        simulate(v0, [...WARMUP, [2, {}], [1, { fix: false }], [brakeS, { fix: false, a: -brakeG }], [residualS, { fix: false, bias: -0.05, extreme: 0.06 }], [12, { fix: false, extreme: 0.01 }]], { seed, noise: 0.01 })
      );
      const firstResidual = ran.length - 12 - residualS;
      if ((ran[firstResidual]!.row.aLonMean ?? 0) <= -0.06) chained++;
      for (const x of ran) if (x.ev.stop === 'sensor') expect({ seed, trueKmh: x.trueKmh < MOTION_CONSTANTS.STOP_KMH }).toEqual({ seed, trueKmh: true });
      expect(ran[ran.length - 1]!.trueKmh).toBeGreaterThanOrEqual(20);
    }
    expect(chained).toBeGreaterThan(0); // the chaining case actually occurs in the sweep
  });

  test('S-TUN-UNALIGNED (C-2): a nudge resets alignment, then a smooth no-fix tunnel at 70 km/h gives 0 stops', () => {
    const ran = run(simulate(6, [...WARMUP.map(([n, s]) => [n, { ...s }] as [number, Partial<Sec>]), [1, { aligned: false }], [120, { fix: false, aligned: false }]]));
    expect(stops(ran)).toEqual([]);
  });

  test('S-OLDROW: rows without the motion fields never give a sensor stop, and never throw', () => {
    const rows = canyon(4, 20);
    for (const s of rows) {
      const r = s.row as Partial<FeatureRow>;
      delete r.frameAligned;
      delete r.aLonMean;
      delete r.accRms;
      delete r.gravX;
      delete r.gravY;
      delete r.gravZ;
    }
    const ran = run(rows);
    expect(stops(ran)).toEqual([]);
    expect(ran.every((x) => x.ev.mountMatch === null)).toBe(true);
  });

  // The property (DMS_FULL runs the long sweep): random drives with constant biases and post-brake
  // bias steps, fix losses, stops and tunnels. No sensor stop while the true speed is ≥ STOP_KMH, and
  // vLowKmh never above the true speed.
  const SEEDS = process.env.DMS_FULL === '1' ? 400 : 40;
  test(`property over ${SEEDS} random drives: no stop at speed; vLowKmh ≤ the true speed`, () => {
    let sensorRows = 0;
    let vLowRows = 0;
    let atSpeedNoFixQuiet = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = prng(seed * 7919);
      const segs: [number, Partial<Sec>][] = [...WARMUP];
      let bias = (r() - 0.5) * 0.02;
      for (let k = 0; k < 12; k++) {
        const kind = r();
        const fix = r() < 0.5;
        const len = 2 + Math.floor(r() * 30);
        if (kind < 0.12) {
          // a no-fix stop the evidence should prove: the fix lost shortly before braking to a standstill
          segs.push([1 + Math.floor(r() * 4), { fix: false, bias }]);
          segs.push([6, { fix: false, bias, a: -(0.2 + r() * 0.15) }]);
          segs.push([10 + Math.floor(r() * 30), { fix: false, bias, extreme: 0.01 }]);
          segs.push([4, { fix: false, bias, a: 0.1 + r() * 0.1 }]); // pull away without a fix
          segs.push([3 + Math.floor(r() * 10), { fix: false, bias }]);
          segs.push([2, { bias }]); // the fix returns
        } else if (kind < 0.25) segs.push([len, { fix, bias, a: -(0.06 + r() * 0.25) * (r() < 0.5 ? 1 : 0.3) }]);
        else if (kind < 0.5) segs.push([len, { fix, bias, a: r() * 0.15 }]);
        else if (kind < 0.7) {
          bias = (r() - 0.5) * 0.1; // a post-brake bias step of up to ±0.05 g
          segs.push([len, { fix, bias, extreme: 0.01 }]);
        } else segs.push([len, { fix, bias, extreme: r() * 0.05 }]);
      }
      const ran = run(simulate(20 + r() * 80, segs, { seed }));
      for (const x of ran) {
        if (x.ev.stop === 'sensor') expect({ seed, ts: x.row.ts, trueKmh: x.trueKmh }).toEqual({ seed, ts: x.row.ts, trueKmh: expect.any(Number) });
        if (x.ev.stop === 'sensor') expect(x.trueKmh).toBeLessThan(MOTION_CONSTANTS.STOP_KMH);
        if (x.ev.vLowKmh !== null) expect(x.ev.vLowKmh).toBeLessThanOrEqual(x.trueKmh + 1e-6);
        if (x.ev.stop === 'sensor') sensorRows++;
        if (x.ev.vLowKmh !== null && x.ev.vLowKmh > 0) vLowRows++;
        if (!x.row.gnssValid && x.ev.quiet && x.trueKmh >= MOTION_CONSTANTS.STOP_KMH) atSpeedNoFixQuiet++;
      }
    }
    // Not vacuous: the drives do produce sensor stops, positive lower bounds, and quiet no-fix rows at
    // speed (the rows a false stop would need).
    expect({ sensorRows: sensorRows > 0, vLowRows: vLowRows > 0, atSpeedNoFixQuiet: atSpeedNoFixQuiet > 0 }).toEqual({ sensorRows: true, vLowRows: true, atSpeedNoFixQuiet: true });
    expect(sensorRows).toBeGreaterThan(0);
    expect(vLowRows).toBeGreaterThan(0);
    expect(atSpeedNoFixQuiet).toBeGreaterThan(0);
  });
});

describe('ambiguous stillness', () => {
  test('no fix, 10 s of continuous quiet rows and no stop evidence (R1-4b)', () => {
    // a smooth tunnel: per-second aLonMean noise 0.004 g
    const ran = run(simulate(80, [...WARMUP, [15, { fix: false, extreme: 0.01 }]], { noise: 0.004 }));
    const tail = ran.slice(-15);
    expect(tail[8]!.ev.ambiguousStill).toBe(false);
    expect(tail[10]!.ev.ambiguousStill).toBe(true);
    expect(tail.every((x) => x.ev.stop === null)).toBe(true);
  });

  test('one rough row restarts the 10 s', () => {
    const ran = run(simulate(80, [...WARMUP, [8, { fix: false, extreme: 0.01 }], [1, { fix: false, extreme: 0.2 }], [8, { fix: false, extreme: 0.01 }]], { noise: 0.004 }));
    expect(ran[ran.length - 1]!.ev.ambiguousStill).toBe(false);
  });
});

describe('the mount reference', () => {
  test('after 60 mounted rows, mountMatch holds on the mount and fails 0.3 rad off it', () => {
    const tilted: [number, number, number] = [0, -Math.sin(Math.PI / 4 + 0.3), -Math.cos(Math.PI / 4 + 0.3)];
    const ran = run(simulate(50, [[70, {}], [3, { grav: tilted }]]));
    expect(ran[30]!.ev.mountMatch).toBeNull(); // no reference yet
    expect(ran[65]!.ev.mountMatch).toBe(true);
    expect(ran[ran.length - 1]!.ev.mountMatch).toBe(false);
    expect(ran[ran.length - 1]!.ev.mountAngleRad).toBeCloseTo(0.3, 2);
  });

  test('mountLostS counts continuous seconds beyond 0.35 rad; handling breaks mountMatch; mountQuiet reads accRms', () => {
    const off: [number, number, number] = [0, -Math.sin(Math.PI / 4 + 0.5), -Math.cos(Math.PI / 4 + 0.5)];
    const ran = run(simulate(50, [[70, {}], [5, { grav: off, accRms: 0.2 }], [1, { handling: 0.5 }]]));
    expect(ran[74]!.ev.mountLostS).toBe(5);
    expect(ran[74]!.ev.mountQuiet).toBe(false);
    expect(ran[75]!.ev.mountMatch).toBe(false);
    expect(ran[75]!.ev.mountLostS).toBe(0);
    expect(ran[60]!.ev.mountQuiet).toBe(true);
  });

  test('unmounted rows never build the reference', () => {
    const ran = run(simulate(50, [[80, {}]]), MOTION_CONSTANTS, false);
    expect(ran[ran.length - 1]!.ev.mountMatch).toBeNull();
  });

  test('resetMountReference re-takes it from the next 60 rows', () => {
    const m = createMotionEvidence();
    const rows = simulate(50, [[70, {}]]);
    for (const s of rows) m.onRow(s.row, { mounted: true });
    m.resetMountReference();
    const next = simulate(50, [[1, {}]])[0]!.row;
    expect(m.onRow({ ...next, ts: rows[rows.length - 1]!.row.ts + 1000 }, { mounted: true }).mountMatch).toBeNull();
  });
});

describe('purity and cost', () => {
  test('C1 round 1 (m1): the evidence carries its row ts', () => {
    const m = createMotionEvidence();
    const rows = simulate(50, [[2, {}]]);
    expect(m.onRow(rows[0]!.row).ts).toBe(rows[0]!.row.ts);
    expect(m.onRow(rows[1]!.row).ts).toBe(rows[1]!.row.ts);
  });

  test('a stale or repeated row returns the previous evidence and changes nothing', () => {
    const m = createMotionEvidence();
    const rows = simulate(50, [[3, {}]]);
    const a = m.onRow(rows[0]!.row);
    const b = m.onRow(rows[1]!.row);
    expect(m.onRow(rows[0]!.row)).toEqual(b);
    expect(a).not.toBe(b);
  });

  test('reset() forgets everything (a new trip)', () => {
    const m = createMotionEvidence();
    for (const s of simulate(50, WARMUP)) m.onRow(s.row);
    m.reset();
    const r = simulate(50, [[1, {}]])[0]!.row;
    expect(m.onRow(r).trust).toBe(false);
    expect(m.onRow({ ...r, ts: r.ts + 1000 }).bias?.n ?? 0).toBe(0);
  });
});
