// The HUD's `monitoring` literal (Task C3; design rev3 §2.5, rev4 §2.5): what each rule family is doing, and
// why, on every status branch. Pure. The HUD copy (U-5, M4) maps the reason to its words:
//   stopped        "Stopped: watching for sleep only"
//   heat           "Camera paused: phone too hot; sleep alerts off"
//   dark           "Too dark to see you; sleep alerts limited"
//   absent         "No one in the driver's seat"
//   speed_unknown  "Speed unknown: distraction alerts paused"
//   face           "Can't see your face" (C3 round 1, review-C3 m3)
//   camera         the camera was interrupted or failed (C3 round 1, m3): never an empty cause
//   learning_eyes  "Learning your eyes: sleep alerts limited" (C6 round 1, C6-2: no EAR reference yet, the
//                  population prior catches deep closures only)
// `recalibrating`, `posture` and `seed_check` are set by the calibration tasks (T4, T6); the type holds them.
// C3 round 1 (m4): each family carries its own cause (`why`); the headline `reason` is the most useful of them,
// in the order below (a stop is more useful than a lost face at it).
import type { SpeedState } from '../engine/context';

export type MonitoringReason =
  | 'stopped'
  | 'heat'
  | 'dark'
  | 'absent'
  | 'app_inactive'
  | 'camera'
  | 'recalibrating'
  | 'posture'
  | 'seed_check'
  | 'face'
  | 'eyes'
  | 'speed_unknown'
  | 'learning_eyes'
  | null;

export interface DmsMonitoring {
  /** D1–D3: counting as specified, counting with widened zones, or not counting */
  distraction: 'full' | 'widened' | 'off';
  /** the sleep family: every rule, some (no eyes: nods and the C-26 bridge only), or none */
  drowsiness: 'full' | 'limited' | 'off';
  /** the headline cause (the HUD line) */
  reason: MonitoringReason;
  /** C3 round 1: each family's own cause */
  why: { distraction: MonitoringReason; drowsiness: MonitoringReason };
}

export interface MonitoringInput {
  camera: 'off' | 'starting' | 'active' | 'limited' | 'paused';
  /** the HUD status reason */
  reason: string | null;
  /** the engine's view at its last frame; null with no engine */
  engine: { speedState: SpeedState; distraction: 'full' | 'widened' | 'off'; calReason?: 'posture' | 'recalibrating' | null; priorMode?: boolean } | null;
}

/** The headline order: the first family cause in this list wins. */
const HEADLINE: readonly MonitoringReason[] = ['heat', 'dark', 'absent', 'camera', 'app_inactive', 'recalibrating', 'posture', 'seed_check', 'stopped', 'speed_unknown', 'face', 'eyes', 'learning_eyes'];

function literal(distraction: DmsMonitoring['distraction'], drowsiness: DmsMonitoring['drowsiness'], whyD: MonitoringReason, whyS: MonitoringReason): DmsMonitoring {
  const reason = HEADLINE.find((r) => r === whyD || r === whyS) ?? null;
  return { distraction, drowsiness, reason, why: { distraction: whyD, drowsiness: whyS } };
}

const both = (d: DmsMonitoring['distraction'], s: DmsMonitoring['drowsiness'], r: MonitoringReason) => literal(d, s, r, r);

/** The distraction side from the engine: off with its cause at a stop or an unknown speed, else the engine's value. */
function distractionOf(engine: MonitoringInput['engine']): { d: DmsMonitoring['distraction']; why: MonitoringReason } {
  if (engine === null) return { d: 'off', why: null };
  if (engine.speedState === 'stopped') return { d: 'off', why: 'stopped' };
  if (engine.speedState === 'ambiguous') return { d: 'off', why: 'speed_unknown' };
  // Task C4: the calibration's cause (a posture change being confirmed, a new driver being recalibrated).
  return { d: engine.distraction, why: engine.calReason ?? null };
}

export function monitoringOf(x: MonitoringInput): DmsMonitoring {
  switch (x.camera) {
    case 'off':
      return both('off', 'off', x.reason === 'app_inactive' ? 'app_inactive' : x.reason === 'error' ? 'camera' : null);
    case 'starting':
      return both('off', 'off', null);
    case 'paused':
      if (x.reason === 'thermal') return both('off', 'off', 'heat');
      if (x.reason === 'low_light') return both('off', 'limited', 'dark');
      if (x.reason === 'absent') return both('off', 'limited', 'absent');
      if (x.reason === 'interrupted' || x.reason === 'error') return both('off', 'off', 'camera');
      return both('off', 'off', null);
    case 'limited': {
      if (x.reason === 'low_light') return both('off', 'limited', 'dark');
      if (x.reason === 'interrupted' || x.reason === 'error') return both('off', 'off', 'camera');
      const dist = distractionOf(x.engine);
      if (x.reason === 'eyes_not_visible') return literal(dist.d, 'limited', dist.why, 'eyes');
      if (x.reason === 'face_lost') return literal('off', 'limited', dist.why ?? 'face', 'face');
      return both('off', 'off', 'camera');
    }
    case 'active': {
      if (x.engine === null) return both('off', 'off', null);
      const dist = distractionOf(x.engine);
      // C6 round 1 (C6-2): before any EAR reference the sleep rules catch deep closures only (the prior).
      if (x.engine.priorMode === true) return literal(dist.d, 'limited', dist.why, 'learning_eyes');
      return literal(dist.d, 'full', dist.why, null);
    }
  }
}
