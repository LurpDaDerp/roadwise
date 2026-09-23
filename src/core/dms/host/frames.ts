// A decoded wire record (FrameFeatures) → the engine's EngineFrame (plan Task 14). The flags pick the
// nulls (no face, a clipped eye, a missing pose, the net not run, a clipped mouth), and the record clock
// moves onto the epoch by the native session's anchor offset (anchorEpochMs − anchorTMs), so frames and
// the 1 Hz rows share one clock.
import { FLAG } from '../../../../modules/dms-vision/src/constants';
import type { FrameFeatures } from '../../../../modules/dms-vision/src/wire';
import type { EngineFrame, EyeFeatures } from '../engine/types';

function eye(f: FrameFeatures, s: 'R' | 'L'): EyeFeatures | null {
  const clipped = s === 'R' ? FLAG.EYE_CLIPPED_R : FLAG.EYE_CLIPPED_L;
  if ((f.flags & clipped) !== 0) return null;
  const n = (v: number | null) => v ?? 0;
  return s === 'R'
    ? { ear: n(f.earR), widthPx: n(f.eyeWR), luma: n(f.eyeLumaR), irisContrast: n(f.irisContrastR), sat: n(f.eyeSatR), ox: n(f.irisOxR), oy: n(f.irisOyR), irisIn: f.irisInR === 1 }
    : { ear: n(f.earL), widthPx: n(f.eyeWL), luma: n(f.eyeLumaL), irisContrast: n(f.irisContrastL), sat: n(f.eyeSatL), ox: n(f.irisOxL), oy: n(f.irisOyL), irisIn: f.irisInL === 1 };
}

export function engineFrame(f: FrameFeatures, epochOffsetMs: number): EngineFrame {
  const base = { tMs: f.tMs + epochOffsetMs, frameLuma: f.frameLuma, rotationDeg: f.rotationDeg, latTotalMs: f.latTotalMs };
  if (!f.face) return { ...base, face: false, box: null, iod: null, head: null, net: null, eyeR: null, eyeL: null, faceLuma: null, blur: null, mouth: null };
  return {
    ...base,
    face: true,
    box: { cx: f.boxCx ?? 0, cy: f.boxCy ?? 0, w: f.boxW ?? 0, h: f.boxH ?? 0 },
    iod: f.iod,
    head: (f.flags & FLAG.POSE_MISSING) !== 0 || f.headYaw === null ? null : { yaw: f.headYaw, pitch: f.headPitch ?? 0, roll: f.headRoll ?? 0 },
    net: (f.flags & FLAG.NET_RAN) !== 0 && f.netYaw !== null && f.netPitch !== null ? { yaw: f.netYaw, pitch: f.netPitch } : null,
    eyeR: eye(f, 'R'),
    eyeL: eye(f, 'L'),
    faceLuma: f.faceLuma,
    blur: f.blur,
    mouth: (f.flags & FLAG.MOUTH_CLIPPED) !== 0 || f.mar === null || f.mouthW === null ? null : { mar: f.mar, widthIod: f.mouthW },
  };
}
