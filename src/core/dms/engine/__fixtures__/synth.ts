// Synthetic EngineFrames and vehicle contexts for the engine tests. Deterministic (a seeded PRNG).
// Angles are given in the CAMERA frame unless a helper says otherwise; `drvToCam` converts a
// driver-frame direction for a given driver side (LHD: yawCam = −yawDrv; roll 0).
import { DEFAULT_DMS_CONFIG } from '../config';
import type { AnglePair, DriverSide, EngineFrame, EyeFeatures, HeadAngles, Rotation, VehicleContext } from '../types';

const RAD = Math.PI / 180;

/** mulberry32 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A standard normal draw (Box–Muller). */
export function gauss(r: () => number): number {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

export function drvToCam(a: AnglePair, side: DriverSide): AnglePair {
  return { yaw: side === 'left' ? -a.yaw : a.yaw, pitch: a.pitch };
}

export function eye(over: Partial<EyeFeatures> = {}): EyeFeatures {
  return { ear: 0.3, widthPx: 30, luma: 1, irisContrast: 40, sat: 0, ox: 0, oy: 0, irisIn: true, ...over };
}

export interface FrameSpec {
  tMs: number;
  head?: HeadAngles;
  /** the geometric gaze the irises encode (camera frame); default: the head direction */
  gaze?: AnglePair;
  /** the net's angles (NET_RAN) */
  net?: AnglePair | null;
  ear?: [number, number];
  box?: { cx: number; cy: number; w?: number; h?: number };
  iod?: number;
  rotationDeg?: Rotation;
  face?: boolean;
  faceLuma?: number;
  frameLuma?: number;
  blur?: number;
  mar?: number;
  mouthW?: number;
  eyeR?: Partial<EyeFeatures> | null;
  eyeL?: Partial<EyeFeatures> | null;
  poseMissing?: boolean;
}

/** One frame; the irises are placed so that the geometric gaze is exactly `gaze` (both eyes). */
export function frame(s: FrameSpec): EngineFrame {
  const face = s.face ?? true;
  const head = s.head ?? { yaw: 0, pitch: 0, roll: 0 };
  const gaze = s.gaze ?? { yaw: head.yaw, pitch: head.pitch };
  const { kEye, gPitch } = DEFAULT_DMS_CONFIG.geometric;
  const ox = kEye * Math.sin((gaze.yaw - head.yaw) * RAD);
  const oy = kEye * Math.sin(((gaze.pitch - head.pitch) / gPitch) * RAD);
  const [earR, earL] = s.ear ?? [0.3, 0.3];
  const mk = (over: Partial<EyeFeatures> | null | undefined, ear: number): EyeFeatures | null =>
    over === null ? null : eye({ ear, ox, oy, ...(over ?? {}) });
  if (!face) {
    return {
      tMs: s.tMs,
      face: false,
      box: null,
      iod: null,
      head: null,
      net: null,
      eyeR: null,
      eyeL: null,
      faceLuma: null,
      blur: null,
      mouth: null,
      frameLuma: s.frameLuma ?? 100,
      rotationDeg: s.rotationDeg ?? 90,
      latTotalMs: 40,
    };
  }
  return {
    tMs: s.tMs,
    face: true,
    box: { cx: s.box?.cx ?? 0.5, cy: s.box?.cy ?? 0.45, w: s.box?.w ?? 0.3, h: s.box?.h ?? 0.4 },
    iod: s.iod ?? 0.2,
    head: s.poseMissing ? null : head,
    net: s.net ?? null,
    eyeR: mk(s.eyeR, earR),
    eyeL: mk(s.eyeL, earL),
    faceLuma: s.faceLuma ?? 120,
    blur: s.blur ?? 60,
    mouth: { mar: s.mar ?? 0.08, widthIod: s.mouthW ?? 0.9 },
    frameLuma: s.frameLuma ?? 110,
    rotationDeg: s.rotationDeg ?? 90,
    latTotalMs: 40,
  };
}

export function ctx(over: Partial<VehicleContext> & { tMs: number }): VehicleContext {
  return {
    speedKmh: 60,
    yawRateDegS: 0.5,
    courseRateDegS: 0,
    turnSign: 0,
    straight: true,
    handling: false,
    imuPresent: true,
    imuMoving: true,
    localMinutes: 720,
    tripElapsedS: over.tMs / 1000,
    ...over,
  };
}
