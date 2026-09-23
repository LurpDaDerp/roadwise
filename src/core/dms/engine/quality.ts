// Per-frame quality (plan §M2, C-22). This file holds the ONE definition of a reliable eye and of the
// near eye (rev2 R1-I1): the geometric gaze, openness and closure all use it; native decides neither.
import type { DmsConfig } from './config';
import type { EngineFrame, EyeFeatures } from './types';

export type Quality = 'tracking' | 'head_only' | 'lost';

export type QualityReason =
  /** LOST */
  | 'no_face'
  | 'small_face'
  | 'dark_face'
  | 'low_light'
  /** HEAD_ONLY */
  | 'head_yaw'
  | 'eyes_unreliable'
  | 'blur'
  | 'dim_face'
  | 'pose_missing';

export interface QualityResult {
  quality: Quality;
  reasons: QualityReason[];
  reliableR: boolean;
  reliableL: boolean;
}

type Cfg = Pick<DmsConfig, 'quality'>;

/** Unreliable: dark, low iris contrast, glare, too narrow, the iris outside the contour, or clipped (null). */
export function eyeReliable(e: EyeFeatures | null, cfg: Cfg): boolean {
  if (e === null) return false;
  const q = cfg.quality;
  return e.luma >= q.eyeMinLuma && e.irisContrast >= q.eyeMinIrisContrast && e.sat <= q.eyeMaxSat && e.widthPx >= q.eyeMinWidthPx && e.irisIn;
}

/** The eye nearer the camera: the one with the larger corner width (a present eye beats a clipped one). */
export function nearEye(f: Pick<EngineFrame, 'eyeR' | 'eyeL'>): 'r' | 'l' | null {
  if (f.eyeR === null && f.eyeL === null) return null;
  if (f.eyeR === null) return 'l';
  if (f.eyeL === null) return 'r';
  return f.eyeR.widthPx >= f.eyeL.widthPx ? 'r' : 'l';
}

export function classifyQuality(f: EngineFrame, cfg: Cfg): QualityResult {
  const q = cfg.quality;
  if (!f.face || f.box === null) {
    const reasons: QualityReason[] = ['no_face'];
    if (f.frameLuma < q.lowLightFrameLuma) reasons.push('low_light');
    return { quality: 'lost', reasons, reliableR: false, reliableL: false };
  }
  const lost: QualityReason[] = [];
  if (f.box.w * f.box.h < q.lostMinBoxArea) lost.push('small_face');
  if (f.faceLuma !== null && f.faceLuma < q.lostMaxFaceLuma) lost.push('dark_face');
  if (lost.length > 0) return { quality: 'lost', reasons: lost, reliableR: false, reliableL: false };

  const reliableR = eyeReliable(f.eyeR, cfg);
  const reliableL = eyeReliable(f.eyeL, cfg);
  const reasons: QualityReason[] = [];
  if (f.head === null) reasons.push('pose_missing');
  else if (Math.abs(f.head.yaw) > q.headOnlyYawDeg) reasons.push('head_yaw');
  if (!reliableR && !reliableL) reasons.push('eyes_unreliable');
  if (f.blur !== null && f.blur < q.headOnlyMinBlur) reasons.push('blur');
  if (f.faceLuma !== null && f.faceLuma < q.headOnlyMinFaceLuma) reasons.push('dim_face');
  return { quality: reasons.length > 0 ? 'head_only' : 'tracking', reasons, reliableR, reliableL };
}
