// Synthetic drives for the golden vectors (R1).
//
// Each builder simulates a car and a phone mounted in it at an arbitrary attitude, produces the
// 25 Hz inputs the native side would hand the extractor (or, for `gravity-filter`, the raw
// Android accelerometer + gyroscope), rounds them the way they are stored, and runs the
// TypeScript reference over them to get `expected`. `make-vectors.ts` writes the result to
// `assets/vectors/*.json`; `__tests__/vectors.test.ts` asserts the committed files are exactly a
// fresh generation.
//
// Pure module: only relative imports, no Node APIs, deterministic (seeded noise), so Jest,
// Node strip-types and any future tooling produce byte-identical output.
import { G_MPS2 } from '../src/extract/constants';
import type {
  FixSample,
  ImuSample,
  PhoneSample,
  RawImuSample,
} from '../src/extract/types';
import { add, dot, normalize, scale, type Vec3 } from '../src/extract/vec';
import {
  runExtractInputs,
  runGravityInputs,
  type ExtractVector,
  type ExtractVectorSecond,
  type GoldenVector,
  type GravityVector,
} from '../src/extract/vectors';

/** Same epoch as the replay traces (`src/core/replay/synth.ts`). */
export const T0 = 1_700_000_000_000;
const SAMPLES_PER_S = 25;
const DT_MS = 1000 / SAMPLES_PER_S;
/** Fixes land this long before the second closes. */
const FIX_LEAD_MS = 200;
/** The drive's origin (Seattle, as in the replay traces). */
const LAT0 = 47.6062;
const LNG0 = -122.3321;

/** Seconds of 0.2 g acceleration every aligned scenario starts with; the frame is aligned in second 7. */
export const ALIGN_PHASE_S = 7;
/** Index (0-based) of the first row that carries an aligned frame in those scenarios. */
export const FIRST_ALIGNED_ROW = 6;

// ——— small numerics ———

const round = (x: number, dp: number): number => {
  const k = 10 ** dp;
  const r = Math.round(x * k) / k;
  return r === 0 ? 0 : r; // no -0 in the JSON
};
const r6 = (v: Vec3): Vec3 => [round(v[0], 6), round(v[1], 6), round(v[2], 6)];

/** mulberry32 — a tiny seeded PRNG so the noise is identical on every run. */
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
/** Approximately normal noise (sum of four uniforms), standard deviation `sd`. */
const gauss = (rnd: () => number, sd: number): number =>
  (rnd() + rnd() + rnd() + rnd() - 2) * sd * Math.sqrt(3);
const noise3 = (rnd: () => number, sd: number): Vec3 => [
  gauss(rnd, sd),
  gauss(rnd, sd),
  gauss(rnd, sd),
];

/** Piecewise-linear profile through `knots` [(t seconds, value)], constant outside them. */
function profile(knots: readonly (readonly [number, number])[]): (t: number) => number {
  return (t) => {
    const first = knots[0];
    const last = knots[knots.length - 1];
    if (!first || !last) return 0;
    if (t <= first[0]) return first[1];
    if (t >= last[0]) return last[1];
    for (let i = 1; i < knots.length; i++) {
      const a = knots[i - 1];
      const b = knots[i];
      if (a && b && t <= b[0]) return a[1] + ((b[1] - a[1]) * (t - a[0])) / (b[0] - a[0]);
    }
    return last[1];
  };
}
const zero = (): number => 0;

// ——— rotations (3×3 as row-major arrays) ———

type Mat3 = readonly [Vec3, Vec3, Vec3];
const mul = (m: Mat3, v: Vec3): Vec3 => [dot(m[0], v), dot(m[1], v), dot(m[2], v)];
const matMul = (a: Mat3, b: Mat3): Mat3 => {
  const col = (j: number): Vec3 => [b[0][j] ?? 0, b[1][j] ?? 0, b[2][j] ?? 0];
  const row = (i: 0 | 1 | 2): Vec3 => [dot(a[i], col(0)), dot(a[i], col(1)), dot(a[i], col(2))];
  return [row(0), row(1), row(2)];
};
/** Rotation by `theta` about the unit axis `n` (Rodrigues). */
function rot(n: Vec3, theta: number): Mat3 {
  const [x, y, z] = normalize(n);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const C = 1 - c;
  return [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ];
}

/**
 * Car frame: x right, y forward, z up. Device frame: x right, y toward the top of the screen,
 * z out of the screen. The base mount is a portrait phone on the dash facing the driver
 * (device x = car right, device y = car up, device z = car backward), tilted back 20° and turned
 * 15° toward the driver, so no device axis lines up with a car axis.
 */
const MOUNT: Mat3 = matMul(
  matMul(rot([1, 0, 0], (-20 * Math.PI) / 180), [
    [1, 0, 0],
    [0, 0, 1],
    [0, -1, 0],
  ]),
  rot([0, 0, 1], (15 * Math.PI) / 180)
);

// ——— the simulator ———

interface PhoneMotion {
  /** device-frame axis the phone turns about relative to the car */
  axis: Vec3;
  /** angle (rad) the phone has turned relative to its mount at time t (seconds) */
  theta: (t: number) => number;
  /** extra device-frame angular rate (rad/s) not captured by `theta` — a hand's tremor */
  jitter?: (t: number) => Vec3;
  /** extra device-frame user acceleration (g, kinematic) — the hand lifting the phone */
  lift?: (t: number) => Vec3;
}

interface Drive {
  seconds: number;
  seed: number;
  v0: number;
  /** longitudinal acceleration, g (positive = speeding up) */
  aLon: (t: number) => number;
  /** lateral acceleration, g (positive = to the left, i.e. a left turn) */
  aLat: (t: number) => number;
  phone?: PhoneMotion;
  /** seconds the reported GNSS course lags the true heading */
  courseLagS?: number;
  accelNoise?: number;
  gyroNoise?: number;
}

interface Truth {
  t: number;
  /** car→device rotation at t */
  R: Mat3;
  /** kinematic acceleration of the phone, device frame, g */
  aKin: Vec3;
  w: Vec3;
}

function simulate(d: Drive) {
  const rnd = prng(d.seed);
  const accelNoise = d.accelNoise ?? 0.01;
  const gyroNoise = d.gyroNoise ?? 0.004;
  const phone = d.phone;
  const H_MS = 1; // integration step, ms
  let v = d.v0;
  let heading = 0; // rad, clockwise from north (course convention)
  let north = 0;
  let east = 0;
  const speedAt = new Map<number, { v: number; heading: number; north: number; east: number }>();
  const headingAt = new Map<number, number>();
  const total = d.seconds * 1000;
  for (let ms = 0; ms <= total; ms += H_MS) {
    speedAt.set(ms, { v, heading, north, east });
    headingAt.set(ms, heading);
    const t = ms / 1000;
    const dt = H_MS / 1000;
    const yaw = v > 0.5 ? (d.aLat(t) * G_MPS2) / v : 0; // CCW positive (left turn)
    v = Math.max(0, v + d.aLon(t) * G_MPS2 * dt);
    heading -= yaw * dt; // a left turn decreases the clockwise heading
    north += v * Math.cos(heading) * dt;
    east += v * Math.sin(heading) * dt;
  }
  const state = (ms: number) => {
    const s = speedAt.get(Math.round(ms));
    if (!s) throw new Error(`no state at ${ms}`);
    return s;
  };
  const truth = (ms: number): Truth => {
    const t = ms / 1000;
    const { v: speed } = state(ms);
    const theta = phone ? phone.theta(t) : 0;
    const R = phone ? matMul(rot(phone.axis, -theta), MOUNT) : MOUNT;
    const yaw = speed > 0.5 ? (d.aLat(t) * G_MPS2) / speed : 0;
    const aCar: Vec3 = [-d.aLat(t), d.aLon(t), 0];
    let aKin = mul(R, aCar);
    if (phone?.lift) aKin = add(aKin, phone.lift(t));
    // θ' by central difference, so the gyro agrees with the attitude the samples report
    const dTheta = phone ? (phone.theta(t + 0.0005) - phone.theta(t - 0.0005)) / 0.001 : 0;
    let w = mul(R, [0, 0, yaw]);
    if (phone) w = add(w, scale(normalize(phone.axis), dTheta));
    if (phone?.jitter) w = add(w, phone.jitter(t));
    return { t, R, aKin, w };
  };
  const sampleTimes = (s: number): number[] =>
    Array.from({ length: SAMPLES_PER_S }, (_, k) => (s - 1) * 1000 + (k + 1) * DT_MS);
  const fixAt = (ms: number): FixSample => {
    const s = state(ms);
    const lagMs = Math.round((d.courseLagS ?? 0) * 1000);
    const lagged = headingAt.get(Math.max(0, Math.round(ms) - lagMs)) ?? s.heading;
    const courseDeg = (((lagged * 180) / Math.PI) % 360 + 360) % 360;
    return {
      t: T0 + Math.round(ms),
      lat: round(LAT0 + s.north / 111_320, 7),
      lng: round(LNG0 + s.east / (111_320 * Math.cos((LAT0 * Math.PI) / 180)), 7),
      hAcc: 5,
      speed: round(s.v, 3),
      speedAcc: 0.5,
      course: round(courseDeg, 2),
      alt: 10,
    };
  };
  const imuAt = (ms: number): ImuSample => {
    const tr = truth(ms);
    const g = mul(tr.R, [0, 0, -1]);
    // CoreMotion sign: a = g + ua, so ua = −(kinematic acceleration)
    const ua = add(scale(tr.aKin, -1), noise3(rnd, accelNoise));
    const w = add(tr.w, noise3(rnd, gyroNoise));
    return { t: T0 + ms, ua: r6(ua), g: r6(g), w: r6(w) };
  };
  const rawAt = (ms: number): RawImuSample => {
    const tr = truth(ms);
    const g = mul(tr.R, [0, 0, -1]);
    const a = add(add(g, scale(tr.aKin, -1)), noise3(rnd, accelNoise));
    const w = add(tr.w, noise3(rnd, gyroNoise));
    return { t: T0 + ms, a: r6(a), w: r6(w) };
  };
  return { sampleTimes, fixAt, imuAt, rawAt };
}

const PHONE_MOUNTED: PhoneSample = { locked: true, screenOn: false, appForeground: true };

/** One row per second: 25 samples, a fix FIX_LEAD_MS before the second closes. */
function extractInputs(d: Drive, phoneState: (s: number) => PhoneSample = () => PHONE_MOUNTED) {
  const sim = simulate(d);
  const seconds: ExtractVectorSecond[] = [];
  for (let s = 1; s <= d.seconds; s++) {
    seconds.push({
      tsMs: T0 + s * 1000,
      imu: sim.sampleTimes(s).map(sim.imuAt),
      fix: sim.fixAt(s * 1000 - FIX_LEAD_MS),
      phone: phoneState(s),
    });
  }
  return { seconds };
}

function extractVector(
  name: string,
  description: string,
  inputs: { seconds: ExtractVectorSecond[] }
): ExtractVector {
  return { name, description, kind: 'extract', inputs, expected: { rows: runExtractInputs(inputs) } };
}

/** 0.2 g from rest-ish (5 m/s) for ALIGN_PHASE_S seconds, then `after` from t = 7 s. */
const alignThen = (after: readonly (readonly [number, number])[]) =>
  profile([[0, 0], [0.3, 0.2], [ALIGN_PHASE_S, 0.2], ...after]);

// ——— the nine vectors ———

function cruise(): GoldenVector {
  const d: Drive = {
    seconds: 10,
    seed: 1,
    v0: 5,
    aLon: alignThen([[7.3, 0]]),
    aLat: zero,
  };
  return extractVector(
    'cruise',
    'Accelerates at 0.2 g for 7 s (the frame aligns in second 7), then cruises at constant speed with road noise: the aligned extremes stay within ±0.05 g and handling is 0.',
    extractInputs(d)
  );
}

function hardBrake(): GoldenVector {
  const d: Drive = {
    seconds: 10,
    seed: 2,
    v0: 5,
    aLon: alignThen([
      [7.3, 0],
      [7.5, 0],
      [7.8, -0.45],
      [9.6, -0.45],
      [9.9, 0],
    ]),
    aLat: zero,
  };
  return extractVector(
    'hard-brake',
    'Aligns during 7 s at 0.2 g, then brakes at 0.45 g from 7.8 s to 9.6 s: aLonMin ≈ −0.45 in seconds 9 and 10.',
    extractInputs(d)
  );
}

function cornerLeft(): GoldenVector {
  const d: Drive = {
    seconds: 10,
    seed: 3,
    v0: 5,
    aLon: alignThen([[7.3, 0]]),
    aLat: profile([
      [7.3, 0],
      [7.6, 0.4],
      [9.5, 0.4],
      [9.8, 0],
    ]),
  };
  return extractVector(
    'corner-left',
    'Aligns during 7 s at 0.2 g, then takes a left corner at 0.40 g and constant speed: aLatMax ≈ +0.40 (left positive) with aLon near 0.',
    extractInputs(d)
  );
}

/** The right turn shared by `turn-lagged-course` and its test's unlagged twin. */
export function turnDrive(courseLagS: number): Drive {
  return {
    seconds: 10,
    seed: 4,
    v0: 5,
    aLon: alignThen([[7.3, 0]]),
    aLat: profile([
      [7.2, 0],
      [7.6, -0.3],
      [9.4, -0.3],
      [9.8, 0],
    ]),
    courseLagS,
  };
}

export const turnInputs = (courseLagS: number) => extractInputs(turnDrive(courseLagS));

function turnLaggedCourse(): GoldenVector {
  return extractVector(
    'turn-lagged-course',
    'Aligns, then turns right at 0.30 g while the reported GNSS course lags the true heading by 1 s. The frame never reads the course, so aLatMin ≈ −0.30 exactly as with an unlagged course.',
    turnInputs(1)
  );
}

function phonePickup(): GoldenVector {
  const d: Drive = {
    seconds: 10,
    seed: 5,
    v0: 5,
    aLon: alignThen([[7.3, 0]]),
    aLat: zero,
    phone: {
      axis: [1, 0, 0],
      theta: profile([
        [7.1, 0],
        [7.9, 1.3],
      ]),
      jitter: (t) =>
        t < 7.9
          ? [0, 0, 0]
          : [0.5 * Math.sin(2 * Math.PI * 2 * t), 0.4 * Math.sin(2 * Math.PI * 1.5 * t + 1), 0.3 * Math.sin(2 * Math.PI * 2.5 * t + 2)],
      lift: (t) => (t >= 7.1 && t < 7.5 ? [0, 0.15, 0.1] : [0, 0, 0]),
    },
  };
  return extractVector(
    'phone-pickup',
    'Aligns, then the phone is lifted out of the mount (1.3 rad in 0.8 s from 7.1 s) and held with hand tremor: handlingScore ≥ 0.6 in the pickup second, the alignment resets (orientationDelta > 0.35) and the frame-dependent fields fall to 0.',
    extractInputs(d, (s) =>
      s >= 8 ? { locked: false, screenOn: true, appForeground: true } : PHONE_MOUNTED
    )
  );
}

function mountShift(): GoldenVector {
  const d: Drive = {
    seconds: 10,
    seed: 6,
    v0: 5,
    aLon: profile([
      [0, 0],
      [0.3, 0.2],
    ]),
    aLat: zero,
    phone: {
      axis: [0, 0, 1],
      theta: profile([
        [7, 0],
        [10, 0.6],
      ]),
    },
  };
  return extractVector(
    'mount-shift',
    'Accelerates at 0.2 g throughout; from 7 s the phone sags in its mount at 0.2 rad/s — too slow for the orientation reset, but its gravity direction leaves the 10 s mean by > 0.2 rad for 2 s, so the alignment resets in second 10 and the frame-dependent fields fall to 0.',
    extractInputs(d)
  );
}

function noImu(): GoldenVector {
  const fix = (s: number, over: Partial<FixSample> = {}): FixSample => ({
    t: T0 + s * 1000 - FIX_LEAD_MS,
    lat: round(LAT0 + s * 0.0001, 7),
    lng: LNG0,
    hAcc: 5,
    speed: 11.2,
    speedAcc: 0.5,
    course: 0,
    alt: 10 + s,
    ...over,
  });
  const nine: ImuSample[] = Array.from({ length: 9 }, (_, k) => ({
    t: T0 + 7000 + (k + 1) * DT_MS,
    ua: [0.01, -0.02, 0.005],
    g: [0, -0.94, -0.34],
    w: [0.01, 0.02, -0.01],
  }));
  const second = (s: number, f: FixSample | null, imu: ImuSample[] = []): ExtractVectorSecond => ({
    tsMs: T0 + s * 1000,
    imu,
    fix: f,
    phone: PHONE_MOUNTED,
  });
  const inputs = {
    seconds: [
      second(1, null),
      second(2, fix(2)),
      second(3, fix(3)),
      second(4, null),
      second(5, fix(5, { hAcc: 80 })),
      second(6, fix(6, { hAcc: -1, speed: -1, speedAcc: -1, course: -1 })),
      second(7, fix(7, { t: T0 + 5000 })),
      second(8, fix(8), nine),
    ],
  };
  return extractVector(
    'no-imu',
    'No IMU (low rate, or fewer than 10 samples in second 8): the nine IMU fields are 0. Also the GNSS encodings — no fix before any (0/0, hAcc 9999, −1s), a missing fix (last position carried), hAcc 80 (invalid), unknown accuracy/speed/course (9999 and −1s) and a 2 s old fix (invalid).',
    inputs
  );
}

function unalignedStart(): GoldenVector {
  const d: Drive = {
    seconds: 5,
    seed: 8,
    v0: 12,
    aLon: zero,
    aLat: profile([
      [0, 0],
      [1, 0.12],
      [4, 0.12],
      [5, 0],
    ]),
    accelNoise: 0.02,
  };
  return extractVector(
    'unaligned-start',
    'Constant speed from the first second, never enough ΔvGNSS to align: the frame-free fields (yawRateMax, gravityStability, orientationDelta, handlingScore) are populated while the frame-dependent extremes and jerk stay 0.',
    extractInputs(d)
  );
}

/** Raw Android-style samples: at rest, accelerating while yawing, then the phone rotating, with a gap. */
export function gravityRawBatches(): RawImuSample[][] {
  const d: Drive = {
    seconds: 7,
    seed: 9,
    v0: 0,
    aLon: profile([
      [2, 0],
      [2.2, 0.2],
      [4, 0.2],
      [4.2, 0],
    ]),
    aLat: profile([
      [2.5, 0],
      [3, 0.05],
      [4, 0.05],
      [4.2, 0],
    ]),
    phone: {
      axis: [1, 0, 0],
      theta: profile([
        [4.2, 0],
        [6, 0.9],
      ]),
    },
  };
  const sim = simulate(d);
  const batches: RawImuSample[][] = [];
  for (let s = 1; s <= d.seconds; s++) {
    // second 6 is lost entirely (a 1.04 s gap between batches), which re-seeds the filter
    if (s === 6) continue;
    batches.push(sim.sampleTimes(s).map(sim.rawAt));
  }
  return batches;
}

function gravityFilterVector(): GoldenVector {
  const inputs = { batches: gravityRawBatches() };
  const v: GravityVector = {
    name: 'gravity-filter',
    description:
      'Raw accelerometer (reference sign, g) + gyroscope in one-second batches: at rest, accelerating at 0.2 g while turning, then the phone rotating 0.9 rad about its x axis, with second 6 missing (a gap longer than GRAVITY_RESET_GAP_S re-seeds gravity from the accelerometer).',
    kind: 'gravityFilter',
    inputs,
    expected: { batches: runGravityInputs(inputs) },
  };
  return v;
}

export const VECTOR_BUILDERS = {
  cruise,
  'hard-brake': hardBrake,
  'corner-left': cornerLeft,
  'turn-lagged-course': turnLaggedCourse,
  'phone-pickup': phonePickup,
  'mount-shift': mountShift,
  'no-imu': noImu,
  'unaligned-start': unalignedStart,
  'gravity-filter': gravityFilterVector,
} as const satisfies Record<string, () => GoldenVector>;

export type VectorName = keyof typeof VECTOR_BUILDERS;
export const VECTOR_NAMES = Object.keys(VECTOR_BUILDERS).sort() as VectorName[];

/** Compact JSON plus a trailing newline — the exact bytes committed under assets/vectors. */
export const serializeVector = (v: GoldenVector): string => `${JSON.stringify(v)}\n`;

export { PHONE_MOUNTED };
