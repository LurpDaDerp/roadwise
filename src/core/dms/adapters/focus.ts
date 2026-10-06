// The scoring seam (product spec v3 event table: "Eyes off road (DMS)", "Drowsiness (DMS)"): the engine's
// glances and drowsiness signs → `DmsFocusSample`s for the focus detector (src/core/detectors/focus.ts), which
// applies the spec's thresholds (2 s / 4 s above 10 mph, 60 s of closure signs, the 0.85 confidence gate, the
// turn and low-speed suppressions). This only decides what is a sample and how confident the camera is:
// - A non-driving glance of at least scoring.focusGlanceS (2.0 s; never a mirror, the cluster or a shoulder
//   check, which are driving) → kind 'glance'. `q` = the glance's TRACKING share × the calibration factor
//   (1 calibrated, 0.9 seeded from the setup, else 0.7: an unknown road centre never reaches the 0.85 gate).
//   `wideTurn` marks a far-lateral glance (a wide head turn), which the detector forgives at low speed.
// - Each drowsiness episode (F1–F3, one per episode), each nod-off and each minute at fatigue ≥ drowsy →
//   kind 'drowsiness' with its measured seconds and the same `q` over the episode's frames (× 0 while the eye
//   baseline is degraded: glare, a part-occluded eye); `lowLight` says the camera was in the dark (the
//   detector ignores those: no IR on phone cameras).
// - At most one sample per `take`, oldest first. The queue is bounded at scoring.focusQueueCap (32): it
//   drops the oldest GLANCE, never a drowsiness sample.
import type { CameraFocusSample } from '@/core/engine/types';
import type { CalibrationState } from '../engine/calibration';
import type { DmsConfig, ZoneId } from '../engine/config';
import { zoneClass } from '../engine/zones';

/** One camera episode for the focus detector: the engine's seam type plus what the v3 rules need. */
export interface DmsFocusSample extends CameraFocusSample {
  /** epoch ms (the frame clock) the episode ended */
  endT: number;
  /** a glance into the far-lateral zone: a wide head turn, forgiven below 15 mph */
  wideTurn: boolean;
  /** the camera was in the dark when the sign was measured: drowsiness detection is off in low light */
  lowLight: boolean;
}

export interface FocusGlance {
  endT: number;
  durS: number;
  zone: ZoneId;
  shoulderCheck: boolean;
}

export interface FocusInfo {
  /** the share of the episode's frames in TRACKING */
  trackingShare: number;
  calibration: CalibrationState;
  /** the eye baseline is degraded (health H5): closure signs are not to be trusted */
  eyesDegraded?: boolean;
}

/** The camera's confidence for an episode: its TRACKING share × the calibration factor (× 0 with degraded eyes, for closures). */
export function confidenceOf(info: FocusInfo, closure: boolean): number {
  const q = Math.max(0, Math.min(1, info.trackingShare)) * calibrationFactor(info.calibration);
  return closure && info.eyesDegraded === true ? 0 : q;
}

/** The camera's confidence factor for the calibration state the glance was classified under. */
export function calibrationFactor(state: CalibrationState): number {
  if (state === 'calibrated') return 1;
  if (state === 'seeded' || state === 'provisional' || state === 'recalibrating') return 0.9;
  return 0.7;
}

export function createFocusQueue(cfg: Pick<DmsConfig, 'scoring' | 'zones'>) {
  const queue: DmsFocusSample[] = [];
  const cap = cfg.scoring.focusQueueCap;

  function push(s: DmsFocusSample): void {
    if (queue.length >= cap) {
      const i = queue.findIndex((x) => x.kind === 'glance');
      if (i >= 0) queue.splice(i, 1);
      else if (s.kind === 'glance') return; // all drowsiness: the new glance is the one dropped
    }
    queue.push(s);
  }

  return {
    glance(g: FocusGlance, info: FocusInfo): void {
      if (g.shoulderCheck || zoneClass(g.zone, cfg) !== 'non_driving' || !(g.durS >= cfg.scoring.focusGlanceS)) return;
      push({
        kind: 'glance',
        glanceS: g.durS,
        q: confidenceOf(info, false),
        endT: g.endT,
        wideTurn: g.zone === 'far_lateral',
        lowLight: false,
      });
    },
    drowsiness(glanceS: number, endT: number, lowLight: boolean, info: FocusInfo): void {
      push({ kind: 'drowsiness', glanceS, q: confidenceOf(info, true), endT, wideTurn: false, lowLight });
    },
    /** The oldest sample, or null. */
    take(): DmsFocusSample | null {
      return queue.shift() ?? null;
    },
    size: () => queue.length,
  };
}
