// One processed frame → its wire record, in absolute form (field 0 = tMs; `buildFrameBatch` makes the
// offsets). This is the whole native per-frame feature pass, ported verbatim to Swift and Kotlin:
// 1. rotate MediaPipe's buffer-frame landmarks upright (`landmarksToUpright`);
// 2. compute the geometry on the upright landmarks (`geometry`);
// 3. compute the luma statistics in the buffer frame (`roi.ts`);
// 4. compute head pose from the matrix (`headPoseFromMatrix`), or set POSE_MISSING;
// 5. convert the net's vector if it ran (`gazeAngles`), and set NET_RAN.
import { FLAG, FRAME_FIELDS, type FrameField } from '../constants';
import { faceAbsentRecord } from '../wire';
import { geometry } from './features';
import { gazeAngles, headPoseFromMatrix } from './headPose';
import { landmarksToUpright, uprightSize, type Rotation } from './landmarks';
import { blurScore, eyeLuma, faceLuma, faceRect, frameLuma } from './roi';

export interface FrameInput {
  /** record clock, ms */
  tMs: number;
  /** delivered (unrotated) buffer size, px */
  bufferW: number;
  bufferH: number;
  /** buffer → upright clockwise rotation, including `rotationOffsetDegrees` */
  rotationDeg: Rotation;
  /** the buffer's luma plane (`lumaPlane`), `bufferW × bufferH` */
  luma: Uint8Array;
  /** MediaPipe's landmarks in the BUFFER frame (478 × 3), or null when no face was found */
  landmarks: ArrayLike<number> | null;
  /** the facial transformation matrix (column-major 4×4, buffer frame), or null */
  matrix: ArrayLike<number> | null;
  /** the gaze network's output vector when it ran on this frame, else null */
  netGaze: ArrayLike<number> | null;
  latLandmarkMs: number;
  latTotalMs: number;
}

const I = Object.fromEntries(FRAME_FIELDS.map((f, i) => [f, i])) as Record<FrameField, number>;

export function buildRecord(f: FrameInput): number[] {
  const fl = frameLuma(f.luma, f.bufferW, f.bufferH);
  if (f.landmarks === null) return faceAbsentRecord(f.tMs, fl, f.rotationDeg, f.latLandmarkMs, f.latTotalMs);

  const { w: uw, h: uh } = uprightSize(f.bufferW, f.bufferH, f.rotationDeg);
  const upright = landmarksToUpright(f.landmarks, f.rotationDeg);
  const g = geometry(upright, uw, uh);
  const rect = faceRect(f.landmarks, f.bufferW, f.bufferH);
  const face = faceLuma(f.luma, f.bufferW, rect);

  const r: number[] = new Array<number>(FRAME_FIELDS.length).fill(NaN);
  let flags = 0;
  r[I.tOffMs] = f.tMs;
  r[I.face] = 1;
  r[I.boxCx] = g.boxCx;
  r[I.boxCy] = g.boxCy;
  r[I.boxW] = g.boxW;
  r[I.boxH] = g.boxH;
  r[I.iod] = g.iod;

  if (f.matrix !== null) {
    const pose = headPoseFromMatrix(f.matrix, f.rotationDeg);
    r[I.headYaw] = pose.yawDeg;
    r[I.headPitch] = pose.pitchDeg;
    r[I.headRoll] = pose.rollDeg;
  } else {
    flags |= FLAG.POSE_MISSING;
  }

  if (f.netGaze !== null) {
    const a = gazeAngles(f.netGaze);
    r[I.netYaw] = a.yawDeg;
    r[I.netPitch] = a.pitchDeg;
    flags |= FLAG.NET_RAN;
  }

  const eyes = [
    ['R', g.right, FLAG.EYE_CLIPPED_R] as const,
    ['L', g.left, FLAG.EYE_CLIPPED_L] as const,
  ];
  for (const [side, eye, clipFlag] of eyes) {
    const k = (name: string) => I[`${name}${side}` as FrameField];
    if (eye === null) {
      flags |= clipFlag;
      r[k('irisIn')] = 0;
      continue;
    }
    const stats = eyeLuma(f.luma, f.bufferW, f.bufferH, f.landmarks, side, face);
    r[k('ear')] = eye.ear;
    r[k('eyeW')] = eye.widthPx;
    r[k('eyeLuma')] = stats.eyeLuma;
    r[k('irisContrast')] = stats.irisContrast;
    r[k('eyeSat')] = stats.eyeSat;
    r[k('irisOx')] = eye.iris.ox;
    r[k('irisOy')] = eye.iris.oy;
    r[k('irisIn')] = eye.irisIn ? 1 : 0;
  }

  r[I.faceLuma] = face;
  r[I.blur] = blurScore(f.luma, f.bufferW, rect);
  if (g.mouth !== null) {
    r[I.mar] = g.mouth.mar;
    r[I.mouthW] = g.mouth.mouthW;
  } else {
    flags |= FLAG.MOUTH_CLIPPED;
  }
  r[I.frameLuma] = fl;
  r[I.rotationDeg] = f.rotationDeg;
  r[I.latLandmarkMs] = f.latLandmarkMs;
  r[I.latTotalMs] = f.latTotalMs;
  r[I.flags] = flags;
  r[I.reserved] = 0;
  return r;
}
