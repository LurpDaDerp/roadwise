// Seeded synthetic drives for the replay suite (plan Task 12, rev1 R-gaze). A scenario describes the
// driver and the car as functions of time; `synthDrive` turns them into EngineFrames at a frame rate and
// 1 Hz drive-sense rows. Test tooling only: nothing here ships in the app.
//
// The two gaze sources get different noise (rev1 R-gaze): geometric σ 4° per frame with a per-drive gain
// error of up to 15 %; the net σ 2.5°. The true gaze is in the DRIVER frame (+yaw toward the passenger for
// a left-hand drive) and converted to the camera frame.
import type { FeatureRowLike, RowExtras } from '../engine/context';
import type { AnglePair, EngineFrame, GazeSource, RowMotion } from '../engine/types';
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
  /**
   * Task C4: the driver moved in the seat (a translation). The camera then sees the face from another angle:
   * every head and gaze angle shifts by `shift` (driver frame, degrees), the face box moves by `box` (image
   * fraction) and the IOD scales by `iodScale` (closer > 1).
   */
  posture?: { shift?: AnglePair; box?: { dx: number; dy: number }; iodScale?: number };
  /** Task C4: this face's open-eye EAR relative to the default 0.3 (a different driver, or a lean) */
  earScale?: number;
  /** Task C6: the eye and face luma relative to the default (dusk, a tunnel, night): 1 = the default 120 */
  eyeLuma?: number;
  /** km/h; null = no GNSS fix */
  speedKmh: number | null;
  /** the car's turn rate, °/s (+ right); drives the course and the gyro */
  turnDegS?: number;
  handling?: boolean;
  /** the IMU says the car moves (final review m8: a tunnel is `speedKmh: null` with this true); default speed > 1 */
  imuMoving?: boolean;
  /**
   * Task C2: the row's motion evidence, over the default (SynthOpts.motion): a GNSS stop below 10 km/h,
   * `strong` moving at ≥ 10 km/h, nothing else. A sensor stop is `{ stop: 'sensor' }` with `speedKmh: null`.
   */
  motion?: Partial<RowMotion>;
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
  /** Task C2: attach motion evidence to every row (the host's, as `RowExtras.motion`); default off */
  motion?: boolean;
  /**
   * Task C4: the face's geometry follows the head: the box centre moves FACE_BOX_PER_DEG per degree of head
   * yaw and pitch (camera frame), the IOD is projected (× cos yaw · cos pitch), and a mount shift moves the
   * box by CAMERA_BOX_PER_DEG per degree (the field-of-view prediction W3 compares against). Default ON (Task C4):
   * a face box that stays put while the head turns is unphysical, and the posture detector's compensation prior
   * reads it as a translation. `false` opts out (the pre-C4 geometry: a fixed box and IOD).
   */
  faceGeometry?: boolean;
  /**
   * C4 round 1 (review-C4 C4-2): the TRUE box-on-head relation of this face (per degree), default FACE_BOX_PER_DEG,
   * so a test can put the truth at 0.5×, 2× or 0 of the engine's prior (`calibration.posture.boxPerDegPrior`).
   */
  boxPerDeg?: number;
  /**
   * Task C2 (rev4 §2.3.6, rev5 V1, amendment W4): the measured lid follows the gaze down, openness ×
   * clamp(1 − 0.025·max(0, −gazePitch − 10), LID_GAZE_FLOOR, 1), the gaze pitch relative to the road centre.
   * The lid follows the eye with a first-order lag (LID_LAG_S): a lid never drops on the frame the eye
   * arrives (K12 measures it on both platforms).
   */
  lidGaze?: boolean;
}

/** The synth lid–gaze coupling's floor (amendment W4: 0.17, so no test sits on the 0.15 deep threshold). */
export const LID_GAZE_FLOOR = 0.17;
/** The lid's first-order lag behind the gaze pitch, seconds (Task C2; K12 checks it on device). */
export const LID_LAG_S = 0.15;

/** The lid factor for a gaze pitch relative to the road centre (degrees; down is negative). */
export function lidFactor(relPitchDeg: number): number {
  return Math.min(1, Math.max(LID_GAZE_FLOOR, 1 - 0.025 * Math.max(0, -relPitchDeg - 10)));
}

/** The default motion evidence of a synth row (Task C2), with the driver's override. */
export function synthMotion(s: Pick<DriverState, 'speedKmh' | 'motion'>): RowMotion {
  const v = s.speedKmh;
  return {
    stop: v !== null && v < 10 ? 'gnss' : null,
    moving: v !== null && v >= 10 ? 'strong' : null,
    quiet: v !== null && v < 1,
    vehicleMotion: false,
    ambiguousStill: false,
    quietNoFixS: 0,
    vLowKmh: null,
    trust: true,
    gap: false,
    ...s.motion,
  };
}

const DEG = Math.PI / 180;
/** the head's first-order lag behind the eyes (T12 review m1) */
const HEAD_LAG_S = 0.2;
export const EPOCH0 = 1_760_000_000_000;
/** Task C4: how far the face box moves per degree of head rotation (faceGeometry) */
export const FACE_BOX_PER_DEG = 0.003;
/** Task C4: how far the face box moves per degree of a camera rotation (faceGeometry; W3's prediction) */
export const CAMERA_BOX_PER_DEG = 0.015;

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
  const lidLag = 1 - Math.exp(-1 / o.fps / LID_LAG_S);
  /** the gaze pitch (relative to the road centre) the lid is following */
  let lidPitch: number | null = null;
  for (let i = 0; i < n; i++) {
    const t = i / o.fps;
    const raw = o.driver(t, r);
    // The head: explicit, or trailing 40 % of the gaze.
    const target = raw.head ?? { yaw: 0.4 * raw.gaze.yaw, pitch: 0.4 * raw.gaze.pitch };
    head = raw.head !== undefined || head === null ? target : { yaw: head.yaw + (target.yaw - head.yaw) * lag, pitch: head.pitch + (target.pitch - head.pitch) * lag };
    const s: DriverState = { ...raw, head };
    const netThis = i % (o.netEvery ?? 1) === 0;
    const gazeRelPitch = s.gaze.pitch - ROAD.pitch;
    lidPitch = lidPitch === null ? gazeRelPitch : lidPitch + (gazeRelPitch - lidPitch) * lidLag;
    const lid = o.lidGaze === true ? lidFactor(lidPitch) : 1;
    const item: SynthItem = { frame: toFrame(t, lid === 1 ? s : { ...s, openness: (s.openness ?? 1) * lid }, netThis ? o.source : 'geometric', gain, noise, o.faceGeometry !== false, o.boxPerDeg ?? FACE_BOX_PER_DEG) };
    if (t >= nextRowT - 1e-9) {
      course = (course + (s.turnDegS ?? 0) + 360) % 360;
      item.row = {
        row: toRow(t, s, course, o.epoch0 ?? EPOCH0),
        ex: { imuMoving: s.imuMoving ?? (s.speedKmh ?? 0) > 1, localMinutes: o.localMinutes === undefined ? 720 : o.localMinutes, tripElapsedS: t, ...(o.motion === true ? { motion: synthMotion(s) } : {}) },
      };
      nextRowT += 1;
    }
    out.push(item);
  }
  return out;
}

function toFrame(t: number, s: DriverState, source: GazeSource, gain: number, noise: () => number, geometry = false, boxPerDeg = FACE_BOX_PER_DEG): EngineFrame {
  const tMs = t * 1000;
  if (s.face === false) return frame({ tMs, face: false });
  const mount = s.mountShift ?? { yaw: 0, pitch: 0 };
  const pose = s.posture?.shift ?? { yaw: 0, pitch: 0 };
  const shift = { yaw: mount.yaw + pose.yaw, pitch: mount.pitch + pose.pitch };
  const head = s.head ?? { yaw: 0.4 * s.gaze.yaw, pitch: 0.4 * s.gaze.pitch };
  const headCam = drvToCam({ yaw: head.yaw + shift.yaw, pitch: head.pitch + shift.pitch }, 'left');
  const trueCam = drvToCam({ yaw: s.gaze.yaw + shift.yaw, pitch: s.gaze.pitch + shift.pitch }, 'left');
  // The geometric path decodes the irises: gain error and σ 4°. The net's own estimate: σ 2.5°.
  const geo = { yaw: headCam.yaw + (trueCam.yaw - headCam.yaw) * gain + 4 * gauss(noise), pitch: headCam.pitch + (trueCam.pitch - headCam.pitch) * gain + 4 * gauss(noise) };
  const net = source === 'net' ? { yaw: trueCam.yaw + 2.5 * gauss(noise), pitch: trueCam.pitch + 2.5 * gauss(noise) } : null;
  const o = Math.max(0, s.openness ?? 1);
  const ear = 0.3 * (s.earScale ?? 1) * o;
  // Task C4: the face box and the IOD (faceGeometry, posture, another driver, a mount shift).
  let box: { cx: number; cy: number; w?: number; h?: number } | undefined;
  let iod: number | undefined;
  if (geometry) {
    const base = s.otherDriver === true ? { cx: 0.42, cy: 0.52 } : { cx: 0.5, cy: 0.45 };
    const camShift = drvToCam(mount, 'left');
    box = {
      cx: base.cx + boxPerDeg * headCam.yaw + CAMERA_BOX_PER_DEG * camShift.yaw + (s.posture?.box?.dx ?? 0),
      cy: base.cy - boxPerDeg * headCam.pitch - CAMERA_BOX_PER_DEG * camShift.pitch + (s.posture?.box?.dy ?? 0),
      ...(s.otherDriver === true ? { w: 0.36, h: 0.46 } : {}),
    };
    iod = (s.otherDriver === true ? 0.25 : 0.2) * (s.posture?.iodScale ?? 1) * Math.cos(headCam.yaw * DEG) * Math.cos(headCam.pitch * DEG);
  } else if (s.otherDriver === true) {
    box = { cx: 0.42, cy: 0.52, w: 0.36, h: 0.46 };
    iod = 0.25;
  } else if (s.mountShift !== undefined) box = { cx: 0.62, cy: 0.5 };
  if (!geometry && s.posture !== undefined) {
    box = { cx: (box?.cx ?? 0.5) + (s.posture.box?.dx ?? 0), cy: (box?.cy ?? 0.45) + (s.posture.box?.dy ?? 0) };
    iod = (iod ?? 0.2) * (s.posture.iodScale ?? 1);
  }
  // C6 round 1 (review-C6 C6-1): the eye ROI follows the lid. As it lowers, the iris contrast falls (∝ √openness)
  // and the ROI luma rises toward the skin's; only the face luma and the IOD are lid-independent. Above a lid of 0.2
  // the iris is seen whatever the absolute EAR (a reading lid at 0.25 of a 0.3 eye, EAR 0.075, is tracked: C6-2's
  // S-PRIOR-READ needs it); at or below it the eye keeps the fixture's closed look (contrast ≈ 0, iris outside).
  const lidOpen = Math.min(1, o);
  const lens =
    s.lens === true ? { irisContrast: 3, irisIn: false } : lidOpen > 0.2 && lidOpen < 1 ? { irisContrast: 40 * Math.sqrt(lidOpen), irisIn: true, luma: 1 + 0.3 * (1 - lidOpen) } : {};
  return frame({
    tMs,
    head: { yaw: headCam.yaw, pitch: headCam.pitch, roll: 0 },
    gaze: geo,
    net,
    ear: [ear, ear],
    eyeR: lens,
    eyeL: lens,
    mar: s.mar ?? 0.08,
    ...(s.eyeLuma !== undefined ? { faceLuma: 120 * s.eyeLuma } : {}),
    mouthW: s.mouthW ?? 0.9,
    ...(box !== undefined ? { box } : {}),
    ...(iod !== undefined ? { iod } : {}),
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
