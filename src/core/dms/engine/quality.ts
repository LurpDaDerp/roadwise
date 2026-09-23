// Per-frame quality (plan §M2, C-22). This file holds the ONE definition of each eye tier and of the
// near eye (rev2 R1-I1); native decides none of them. Two tiers (T6 review C1): a closed eye collapses
// its contour (irisIn → 0) and its ROI becomes eyelid (irisContrast → ~0), so a gaze-quality test would
// make every closure look like bad data.
// - USABLE (not clipped, wide enough, not dark, not glared) judges openness: TRACKING, openness,
//   closure, the EAR baselines.
// - RELIABLE (usable, plus iris contrast and the iris inside the contour) judges gaze: the geometric gaze.
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
  /** usable for openness and closure */
  usableR: boolean;
  usableL: boolean;
  /** reliable for the geometric gaze */
  reliableR: boolean;
  reliableL: boolean;
}

type Cfg = Pick<DmsConfig, 'quality'>;

/** Usable for openness: not clipped (null), not too narrow, not dark (sunglasses), not glared. */
export function eyeUsable(e: EyeFeatures | null, cfg: Cfg): boolean {
  if (e === null) return false;
  const q = cfg.quality;
  return e.luma >= q.eyeMinLuma && e.sat <= q.eyeMaxSat && e.widthPx >= q.eyeMinWidthPx;
}

/** Reliable for gaze: usable, with iris contrast, and the iris centre inside the eye contour. */
export function eyeReliable(e: EyeFeatures | null, cfg: Cfg): boolean {
  return e !== null && eyeUsable(e, cfg) && e.irisContrast >= cfg.quality.eyeMinIrisContrast && e.irisIn;
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
    return { quality: 'lost', reasons, usableR: false, usableL: false, reliableR: false, reliableL: false };
  }
  const lost: QualityReason[] = [];
  if (f.box.w * f.box.h < q.lostMinBoxArea) lost.push('small_face');
  if (f.faceLuma !== null && f.faceLuma < q.lostMaxFaceLuma) lost.push('dark_face');
  if (lost.length > 0) return { quality: 'lost', reasons: lost, usableR: false, usableL: false, reliableR: false, reliableL: false };

  const usableR = eyeUsable(f.eyeR, cfg);
  const usableL = eyeUsable(f.eyeL, cfg);
  const reliableR = eyeReliable(f.eyeR, cfg);
  const reliableL = eyeReliable(f.eyeL, cfg);
  const reasons: QualityReason[] = [];
  if (f.head === null) reasons.push('pose_missing');
  else if (Math.abs(f.head.yaw) > q.headOnlyYawDeg) reasons.push('head_yaw');
  // TRACKING needs one USABLE eye (C-22 on the first tier); `eyes_unreliable` means no usable eye.
  if (!usableR && !usableL) reasons.push('eyes_unreliable');
  if (f.blur !== null && f.blur < q.headOnlyMinBlur) reasons.push('blur');
  if (f.faceLuma !== null && f.faceLuma < q.headOnlyMinFaceLuma) reasons.push('dim_face');
  return { quality: reasons.length > 0 ? 'head_only' : 'tracking', reasons, usableR, usableL, reliableR, reliableL };
}
