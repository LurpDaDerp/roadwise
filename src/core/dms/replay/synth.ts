// Seeded synthetic drives for the replay suite (plan Task 12, rev1 R-gaze). A scenario describes the
// driver and the car as functions of time; `synthDrive` turns them into EngineFrames at a frame rate and
// 1 Hz drive-sense rows. Test tooling only: nothing here ships in the app.
//
// The two gaze sources get different noise (rev1 R-gaze): geometric σ 4° per frame with a per-drive gain
// error of up to 15 %; the net σ 2.5°. The true gaze is in the DRIVER frame (+yaw toward the passenger for
// a left-hand drive) and converted to the camera frame.
import type { FeatureRowLike, RowExtras } from '../engine/context';
import type { AnglePair, EngineFrame, GazeSource } from '../engine/types';
import { drvToCam, frame, gauss, rng } from '../engine/__fixtures__/synth';

/** What the driver and the car do at time t (seconds). Everything but `gaze` has a default. */
export interface DriverState {
  /** true gaze, driver frame, degrees */
  gaze: AnglePair;
  /**
   * head direction, driver frame; default: 40 % of the gaze through a first-order lag (τ 200 ms), as real
   * heads trail the eyes (T12 review m1). An explicit head is used as given (nods, shoulder checks).
   */
  head?: AnglePair;
  /** eye openness 0–1 (1 = open; the EAR is 0.3 × openness); default 1 */
  openness?: number;
  /** mouth aspect ratio; default 0.08 */
  mar?: number;
  /** mouth width ÷ IOD; default 0.9 */
  mouthW?: number;
  /** false: no face in the frame */
  face?: boolean;
  /** sunglasses: the irises are never found (T6 r2 carry: a lens → HEAD_ONLY) */
  lens?: boolean;
  /** the phone moved: every camera angle shifts by this and the face box moves (a camera bump) */
  mountShift?: AnglePair;
  /** a different driver: a different face box and IOD */
  otherDriver?: boolean;
  /** km/h; null = no GNSS fix */
  speedKmh: number | null;
  /** the car's turn rate, °/s (+ right); drives the course and the gyro */
  turnDegS?: number;
  handling?: boolean;
  /** the IMU says the car moves (final review m8: a tunnel is `speedKmh: null` with this true); default speed > 1 */
  imuMoving?: boolean;
}

export type DriverFn = (t: number, r: () => number) => DriverState;

export interface SynthItem {
  frame: EngineFrame;
  /** a drive-sense row applied just before this frame */
  row?: { row: FeatureRowLike; ex: RowExtras };
}

export interface SynthOpts {
  fps: number;
  seconds: number;
  seed: number;
  source: GazeSource;
  driver: DriverFn;
  /** epoch ms of t = 0 */
  epoch0?: number;
  /** local minutes since midnight (null = unknown) */
  localMinutes?: number | null;
  /** the gaze net runs on every n-th frame only (the policy's gazeNetEvery); default 1 */
  netEvery?: number;
}

const DEG = Math.PI / 180;
/** the head's first-order lag behind the eyes (T12 review m1) */
const HEAD_LAG_S = 0.2;
export const EPOCH0 = 1_760_000_000_000;

/** Frames and rows for one drive. Deterministic in `seed`. */
export function synthDrive(o: SynthOpts): SynthItem[] {
  const r = rng(o.seed);
  const noise = rng(o.seed * 7919 + (o.source === 'net' ? 1 : 2));
  // A per-drive gain error on the geometric path: up to ±15 %.
  const gain = 1 + (noise() * 2 - 1) * 0.15;
  const out: SynthItem[] = [];
  const n = Math.round(o.fps * o.seconds);
  let course = 90;
  let nextRowT = 0;
  let head: AnglePair | null = null;
  const lag = 1 - Math.exp(-1 / o.fps / HEAD_LAG_S);
  for (let i = 0; i < n; i++) {
    const t = i / o.fps;
    const raw = o.driver(t, r);
    // The head: explicit, or trailing 40 % of the gaze.
    const target = raw.head ?? { yaw: 0.4 * raw.gaze.yaw, pitch: 0.4 * raw.gaze.pitch };
    head = raw.head !== undefined || head === null ? target : { yaw: head.yaw + (target.yaw - head.yaw) * lag, pitch: head.pitch + (target.pitch - head.pitch) * lag };
    const s: DriverState = { ...raw, head };
    const netThis = i % (o.netEvery ?? 1) === 0;
    const item: SynthItem = { frame: toFrame(t, s, netThis ? o.source : 'geometric', gain, noise) };
    if (t >= nextRowT - 1e-9) {
      course = (course + (s.turnDegS ?? 0) + 360) % 360;
      item.row = { row: toRow(t, s, course, o.epoch0 ?? EPOCH0), ex: { imuMoving: s.imuMoving ?? (s.speedKmh ?? 0) > 1, localMinutes: o.localMinutes === undefined ? 720 : o.localMinutes, tripElapsedS: t } };
      nextRowT += 1;
    }
    out.push(item);
  }
  return out;
}

function toFrame(t: number, s: DriverState, source: GazeSource, gain: number, noise: () => number): EngineFrame {
  const tMs = t * 1000;
  if (s.face === false) return frame({ tMs, face: false });
  const shift = s.mountShift ?? { yaw: 0, pitch: 0 };
  const head = s.head ?? { yaw: 0.4 * s.gaze.yaw, pitch: 0.4 * s.gaze.pitch };
  const headCam = drvToCam({ yaw: head.yaw + shift.yaw, pitch: head.pitch + shift.pitch }, 'left');
  const trueCam = drvToCam({ yaw: s.gaze.yaw + shift.yaw, pitch: s.gaze.pitch + shift.pitch }, 'left');
  // The geometric path decodes the irises: gain error and σ 4°. The net's own estimate: σ 2.5°.
  const geo = { yaw: headCam.yaw + (trueCam.yaw - headCam.yaw) * gain + 4 * gauss(noise), pitch: headCam.pitch + (trueCam.pitch - headCam.pitch) * gain + 4 * gauss(noise) };
  const net = source === 'net' ? { yaw: trueCam.yaw + 2.5 * gauss(noise), pitch: trueCam.pitch + 2.5 * gauss(noise) } : null;
  const o = Math.max(0, s.openness ?? 1);
  const ear = 0.3 * o;
  const lens = s.lens === true ? { irisContrast: 3, irisIn: false } : {};
  return frame({
    tMs,
    head: { yaw: headCam.yaw, pitch: headCam.pitch, roll: 0 },
    gaze: geo,
    net,
    ear: [ear, ear],
    eyeR: lens,
    eyeL: lens,
    mar: s.mar ?? 0.08,
    mouthW: s.mouthW ?? 0.9,
    ...(s.otherDriver === true ? { box: { cx: 0.42, cy: 0.52, w: 0.36, h: 0.46 }, iod: 0.25 } : s.mountShift !== undefined ? { box: { cx: 0.62, cy: 0.5 } } : {}),
  });
}

function toRow(t: number, s: DriverState, course: number, epoch0: number): FeatureRowLike {
  const gyro = Math.abs(s.turnDegS ?? 0) * DEG + 0.005;
  return {
    ts: epoch0 + t * 1000,
    speed: s.speedKmh === null ? -1 : s.speedKmh / 3.6,
    course,
    gnssValid: s.speedKmh !== null,
    aLonMax: 0.3,
    aLonMin: -0.3,
    aLatMax: 0.2,
    aLatMin: -0.2,
    yawRateMax: gyro,
    jerkMax: 0.5,
    gravityStability: 0.98,
    orientationDelta: 0.01,
    handlingScore: s.handling === true ? 0.9 : 0.05,
  };
}

// ---------------------------------------------------------------------------------------------
// Building blocks for drivers.
// ---------------------------------------------------------------------------------------------

/** Where an attentive driver looks: the road centre (driver frame) with natural scanning. */
export const ROAD: AnglePair = { yaw: 2, pitch: -3 };

/** The road with natural scanning (σ 1.5°), seeded. */
export function onRoad(r: () => number): AnglePair {
  return { yaw: ROAD.yaw + 1.5 * gauss(r), pitch: ROAD.pitch + 1.5 * gauss(r) };
}

/** A blink every `everyS` seconds lasting `durMs`: openness at time t. */
export function blinkOpenness(t: number, everyS = 4, durMs = 200, phaseS = 0.7): number {
  const k = (t - phaseS) % everyS;
  return k >= 0 && k * 1000 < durMs ? 0.1 : 1;
}

/** A point in the driver frame relative to the road centre (zones are relative to the centre). */
export const rel = (yaw: number, pitch: number): AnglePair => ({ yaw: ROAD.yaw + yaw, pitch: ROAD.pitch + pitch });
