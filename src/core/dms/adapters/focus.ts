// The scoring seam (plan §M10): DMS glances and drowsiness → M1's CameraFocusSample. The existing focus
// detector applies its own ≥ 10 mph gate; this only decides what is a sample.
// - A Tier 0 non-driving glance longer than scoring.focusGlanceS (2.0 s; never a mirror, the cluster or a
//   shoulder check, C-18) → kind 'glance', q = its TRACKING share × (1 calibrated, else 0.7), and
//   correctedWithinGrace when it ended within GLANCE_GRACE_S (1.5 s) of a DMS alert start.
// - Each drowsiness episode (F1–F3, one per episode) and each minute at fatigue ≥ drowsy → kind
//   'drowsiness'.
// - At most one sample per row, oldest first. The queue is bounded at scoring.focusQueueCap (32): it drops
//   the oldest GLANCE, never a drowsiness sample.
import { CONSTANTS } from '@scoring';
import type { CameraFocusSample } from '@/core/engine/types';
import type { DmsConfig, ZoneId } from '../engine/config';
import { zoneClass } from '../engine/zones';

/** M1's own GLANCE_GRACE_S (1.5 s): a glance ended this soon after an alert start was corrected. */
const GLANCE_GRACE_S = CONSTANTS.GLANCE_GRACE_S;

export interface FocusGlance {
  endT: number;
  durS: number;
  zone: ZoneId;
  shoulderCheck: boolean;
}

export interface FocusInfo {
  /** the share of the glance's frames in TRACKING */
  trackingShare: number;
  calibrated: boolean;
  /** the latest DMS alert start (epoch ms), or null */
  lastAlertStartT: number | null;
}

export function createFocusQueue(cfg: Pick<DmsConfig, 'scoring' | 'zones'>) {
  const queue: CameraFocusSample[] = [];
  const cap = cfg.scoring.focusQueueCap;

  function push(s: CameraFocusSample): void {
    if (queue.length >= cap) {
      const i = queue.findIndex((x) => x.kind === 'glance');
      if (i >= 0) queue.splice(i, 1);
      else if (s.kind === 'glance') return; // all drowsiness: the new glance is the one dropped
    }
    queue.push(s);
  }

  return {
    glance(g: FocusGlance, info: FocusInfo): void {
      if (g.shoulderCheck || zoneClass(g.zone, cfg) !== 'non_driving' || !(g.durS > cfg.scoring.focusGlanceS)) return;
      const since = info.lastAlertStartT === null ? null : g.endT - info.lastAlertStartT;
      push({
        kind: 'glance',
        glanceS: g.durS,
        q: Math.max(0, Math.min(1, info.trackingShare)) * (info.calibrated ? 1 : 0.7),
        correctedWithinGrace: since !== null && since >= 0 && since <= GLANCE_GRACE_S * 1000,
      });
    },
    drowsiness(glanceS: number): void {
      push({ kind: 'drowsiness', glanceS, q: 1 });
    },
    /** The oldest sample, or null: at most one per row. */
    take(): CameraFocusSample | null {
      return queue.shift() ?? null;
    },
    size: () => queue.length,
  };
}
