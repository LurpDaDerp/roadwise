// The HUD's `monitoring` literal (Task C3; design rev3 §2.5, rev4 §2.5): what each rule family is doing, and
// why, on every status branch. Pure. The HUD copy (U-5, M4) maps the reason to its words:
//   stopped        "Stopped: watching for sleep only"
//   heat           "Camera paused: phone too hot; sleep alerts off"
//   dark           "Too dark to see you; sleep alerts limited"
//   absent         "No one in the driver's seat"
//   speed_unknown  "Speed unknown: distraction alerts paused"
// `recalibrating`, `posture` and `seed_check` are set by the calibration tasks (T4, T6); the type holds them.
import type { SpeedState } from '../engine/context';

export type MonitoringReason = 'stopped' | 'heat' | 'dark' | 'absent' | 'app_inactive' | 'recalibrating' | 'posture' | 'seed_check' | 'eyes' | 'speed_unknown' | null;

export interface DmsMonitoring {
  /** D1–D3: counting as specified, counting with widened zones, or not counting */
  distraction: 'full' | 'widened' | 'off';
  /** the sleep family: every rule, some (no eyes: nods and the C-26 bridge only), or none */
  drowsiness: 'full' | 'limited' | 'off';
  reason: MonitoringReason;
}

export interface MonitoringInput {
  camera: 'off' | 'starting' | 'active' | 'limited' | 'paused';
  /** the HUD status reason */
  reason: string | null;
  /** the engine's view at its last frame; null with no engine */
  engine: { speedState: SpeedState; distraction: 'full' | 'widened' | 'off' } | null;
}

const OFF: DmsMonitoring = { distraction: 'off', drowsiness: 'off', reason: null };

export function monitoringOf(x: MonitoringInput): DmsMonitoring {
  switch (x.camera) {
    case 'off':
      return { ...OFF, reason: x.reason === 'app_inactive' ? 'app_inactive' : null };
    case 'starting':
      return OFF;
    case 'paused':
      if (x.reason === 'thermal') return { ...OFF, reason: 'heat' };
      if (x.reason === 'low_light') return { distraction: 'off', drowsiness: 'limited', reason: 'dark' };
      if (x.reason === 'absent') return { distraction: 'off', drowsiness: 'limited', reason: 'absent' };
      return OFF;
    case 'limited':
      if (x.reason === 'low_light') return { distraction: 'off', drowsiness: 'limited', reason: 'dark' };
      if (x.reason === 'eyes_not_visible') return { distraction: x.engine?.distraction ?? 'off', drowsiness: 'limited', reason: 'eyes' };
      if (x.reason === 'face_lost') return { distraction: 'off', drowsiness: 'limited', reason: 'eyes' };
      return OFF;
    case 'active': {
      if (x.engine === null) return OFF;
      if (x.engine.speedState === 'stopped') return { distraction: 'off', drowsiness: 'full', reason: 'stopped' };
      if (x.engine.speedState === 'ambiguous') return { distraction: 'off', drowsiness: 'full', reason: 'speed_unknown' };
      return { distraction: x.engine.distraction, drowsiness: 'full', reason: null };
    }
  }
}
