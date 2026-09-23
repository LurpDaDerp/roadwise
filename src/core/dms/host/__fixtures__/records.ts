// Test tooling: an EngineFrame → the wire's FrameFeatures (the inverse of host/frames.ts), so host tests
// can drive the fake native module with the engine's synthetic frames.
import { FLAG } from '../../../../../modules/dms-vision/src/constants';
import type { FrameFeatures } from '../../../../../modules/dms-vision/src/wire';
import type { EngineFrame } from '../../engine/types';

export function featuresFromFrame(f: EngineFrame): FrameFeatures {
  const none = {
    boxCx: null,
    boxCy: null,
    boxW: null,
    boxH: null,
    iod: null,
    headYaw: null,
    headPitch: null,
    headRoll: null,
    netYaw: null,
    netPitch: null,
    earR: null,
    earL: null,
    eyeWR: null,
    eyeWL: null,
    eyeLumaR: null,
    eyeLumaL: null,
    irisContrastR: null,
    irisContrastL: null,
    eyeSatR: null,
    eyeSatL: null,
    irisOxR: null,
    irisOyR: null,
    irisOxL: null,
    irisOyL: null,
    irisInR: null,
    irisInL: null,
    faceLuma: null,
    blur: null,
    mar: null,
    mouthW: null,
  };
  const base = { tMs: f.tMs, frameLuma: f.frameLuma, rotationDeg: f.rotationDeg, latLandmarkMs: 0, latTotalMs: f.latTotalMs };
  if (!f.face) return { ...none, ...base, face: false, flags: 0 };
  const flags = (f.net !== null ? FLAG.NET_RAN : 0) | (f.eyeR === null ? FLAG.EYE_CLIPPED_R : 0) | (f.eyeL === null ? FLAG.EYE_CLIPPED_L : 0) | (f.mouth === null ? FLAG.MOUTH_CLIPPED : 0) | (f.head === null ? FLAG.POSE_MISSING : 0);
  const eye = (e: EngineFrame['eyeR'], s: 'R' | 'L') =>
    e === null
      ? { [`irisIn${s}`]: 0 }
      : { [`ear${s}`]: e.ear, [`eyeW${s}`]: e.widthPx, [`eyeLuma${s}`]: e.luma, [`irisContrast${s}`]: e.irisContrast, [`eyeSat${s}`]: e.sat, [`irisOx${s}`]: e.ox, [`irisOy${s}`]: e.oy, [`irisIn${s}`]: e.irisIn ? 1 : 0 };
  return {
    ...none,
    ...base,
    face: true,
    flags,
    boxCx: f.box!.cx,
    boxCy: f.box!.cy,
    boxW: f.box!.w,
    boxH: f.box!.h,
    iod: f.iod,
    ...(f.head !== null ? { headYaw: f.head.yaw, headPitch: f.head.pitch, headRoll: f.head.roll } : {}),
    ...(f.net !== null ? { netYaw: f.net.yaw, netPitch: f.net.pitch } : {}),
    ...eye(f.eyeR, 'R'),
    ...eye(f.eyeL, 'L'),
    faceLuma: f.faceLuma,
    blur: f.blur,
    ...(f.mouth !== null ? { mar: f.mouth.mar, mouthW: f.mouth.widthIod } : {}),
  } as FrameFeatures;
}
