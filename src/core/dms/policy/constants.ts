// The capture policy's own numbers (plan "Budgets": capture states, speed classes, unknown speed and the
// caps). The wire, the frame-rate set, the watchdog, the pause-after-stop time and the thermal floor come
// from the dms-vision constants (rev1 m1: one source) and are imported where used, never restated here.

/** Speed classes: CLOSURE_WATCH from 10 km/h, FULL from 20 km/h. */
export const SLOW_KMH = 10;
export const FAST_KMH = 20;
/** Up once the speed reaches the threshold on this many consecutive rows… */
export const UP_ROWS = 2;
/** …down once it is below (threshold − DOWN_MARGIN_KMH) on this many consecutive rows. */
export const DOWN_ROWS = 3;
export const DOWN_MARGIN_KMH = 2;

/** A row older than this is unknown speed (rev1 I6). */
export const ROW_STALE_MS = 3_000;
/** Unknown speed with IMU motion: the last known class holds this long (the drive engine's no-fix end). */
export const UNKNOWN_HOLD_MOVING_MS = 600_000;
/** Unknown speed without IMU motion: the last known class holds this long, then CLOSURE_WATCH. */
export const UNKNOWN_HOLD_STILL_MS = 10_000;

/** SEARCH: the face LOST for more than this at ≥ 10 km/h. */
export const SEARCH_LOST_MS = 2_000;
/** HEAD_ONLY_RUN: HEAD_ONLY for at least this at ≥ 20 km/h. */
export const HEAD_ONLY_RUN_MS = 5_000;
/** SETUP (C2) lasts until endSetup() or this long. */
export const SETUP_MAX_MS = 120_000;
/** The preview (Privacy 6): only while stationary, a known speed below this for PREVIEW_STILL_MS. */
export const PREVIEW_STILL_KMH = 5;
export const PREVIEW_STILL_MS = 3_000;
/** Thermal L4: L3 held this long → the HUD dims (dimAdvised). */
export const THERMAL_L4_AFTER_MS = 120_000;
/** Low Power Mode, or the battery below this and not charging → at most POWER_CAP_FPS. */
export const LOW_BATTERY_PCT = 20;
export const POWER_CAP_FPS = 8;

/**
 * The low-light suspend (T13 r1 m1; reversible defaults, user item U-21): LOST because it is too dark, at
 * ≥ minSpeedKmh, continuously for suspendAfterMs → the camera pauses; while suspended it probes for
 * probeForMs every probeEveryMs, and a probe that sees a face resumes.
 */
export const LOW_LIGHT = { suspendAfterMs: 60_000, minSpeedKmh: 20, probeEveryMs: 300_000, probeForMs: 10_000 } as const;

/** The policy's own numbers, checked (an empty list when they are sound). */
export function validatePolicyConstants(l: { suspendAfterMs: number; minSpeedKmh: number; probeEveryMs: number; probeForMs: number } = LOW_LIGHT): string[] {
  const bad: string[] = [];
  if (!(l.suspendAfterMs > 0)) bad.push('LOW_LIGHT.suspendAfterMs: must be > 0');
  if (!(l.minSpeedKmh >= 0)) bad.push('LOW_LIGHT.minSpeedKmh: must be ≥ 0');
  if (!(l.probeForMs > 0 && l.probeForMs < l.probeEveryMs)) bad.push('LOW_LIGHT.probeForMs: must be > 0 and shorter than probeEveryMs');
  return bad;
}
