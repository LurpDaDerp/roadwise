// The capture policy's own numbers (plan "Budgets": capture states, speed classes, unknown speed and the
// caps). The wire, the frame-rate set, the watchdog, the pause-after-stop time and the thermal floor come
// from the dms-vision constants (rev1 m1: one source) and are imported where used, never restated here.

/** Speed classes: SLEEP_WATCH below 20 km/h, FULL from 20 km/h. */
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
/** Unknown speed without IMU motion: the last known class holds this long, then SLEEP_WATCH. */
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
 * Task C3 (rev4 §2.1.3): a known speed below this is a GNSS stop, the engine's STOPPED state (with the motion
 * evidence's latched sensor stop). The same number as the motion evidence's STOP_KMH and the DMS config's
 * alerts.criticalEndBelowKmh.
 */
export const STOP_KMH = 10;

/**
 * The low-light suspend (T13 r1 m1; reversible defaults, user item U-21): LOST because it is too dark,
 * continuously for suspendAfterMs → the camera pauses; while suspended it probes for probeForMs every
 * probeEveryMs (every probeEveryStoppedMs while stopped), and a probe that sees a face resumes. Task C3
 * (rev4 §2.1.5): it arms at any speed (minSpeedKmh 0, was 20).
 */
export const LOW_LIGHT = { suspendAfterMs: 60_000, minSpeedKmh: 0, probeEveryMs: 300_000, probeEveryStoppedMs: 60_000, probeForMs: 10_000 } as const;

/**
 * Task C3 (rev4 §2.1.5, U-12): no one in the seat. STOPPED with no face box at all (LOST with no box, not in
 * the dark) for afterMs → the camera pauses (`absent`); it probes for probeForMs every probeEveryMs, and a
 * probe that sees a face, or moving evidence, resumes. C3 round 2 (review-C3r1 m1): after
 * backoffAfterFailures consecutive probes that failed to resume (the host's count), one probe every
 * backoffProbeEveryMs, so a persistent camera fault does not cold-start the models twice a minute.
 */
export const ABSENT = { afterMs: 180_000, probeEveryMs: 30_000, probeForMs: 5_000, requiresNoBox: true, backoffAfterFailures: 3, backoffProbeEveryMs: 300_000 } as const;

/** Native releases its models after this long paused (dms-vision MODEL_RELEASE_AFTER_PAUSE_MS); every probe gap is shorter. */
const MODEL_RELEASE_MS = 300_000;

type LowLight = { suspendAfterMs: number; minSpeedKmh: number; probeEveryMs: number; probeEveryStoppedMs: number; probeForMs: number };
type Absent = { afterMs: number; probeEveryMs: number; probeForMs: number; requiresNoBox: boolean; backoffAfterFailures: number; backoffProbeEveryMs: number };

/** The policy's own numbers, checked (an empty list when they are sound). */
export function validatePolicyConstants(l: LowLight = LOW_LIGHT, a: Absent = ABSENT): string[] {
  const bad: string[] = [];
  if (!(l.suspendAfterMs > 0)) bad.push('LOW_LIGHT.suspendAfterMs: must be > 0');
  if (!(l.minSpeedKmh >= 0)) bad.push('LOW_LIGHT.minSpeedKmh: must be ≥ 0');
  if (!(l.probeForMs > 0 && l.probeForMs < l.probeEveryMs)) bad.push('LOW_LIGHT.probeForMs: must be > 0 and shorter than probeEveryMs');
  if (!(l.probeEveryStoppedMs > l.probeForMs && l.probeEveryStoppedMs < l.probeEveryMs)) bad.push('LOW_LIGHT.probeEveryStoppedMs: must lie between probeForMs and probeEveryMs');
  if (!(l.probeEveryMs - l.probeForMs < MODEL_RELEASE_MS)) bad.push('LOW_LIGHT.probeEveryMs: a pause must stay under the native model release');
  if (!(a.afterMs > 0)) bad.push('ABSENT.afterMs: must be > 0');
  if (!(a.probeForMs > 0 && a.probeForMs < a.probeEveryMs)) bad.push('ABSENT.probeForMs: must be > 0 and shorter than probeEveryMs');
  if (!(a.probeEveryMs - a.probeForMs < MODEL_RELEASE_MS)) bad.push('ABSENT.probeEveryMs: a pause must stay under the native model release');
  if (!(Number.isInteger(a.backoffAfterFailures) && a.backoffAfterFailures >= 1)) bad.push('ABSENT.backoffAfterFailures: must be a whole number ≥ 1');
  if (!(a.backoffProbeEveryMs >= a.probeEveryMs && a.backoffProbeEveryMs - a.probeForMs < MODEL_RELEASE_MS)) bad.push('ABSENT.backoffProbeEveryMs: must be ≥ probeEveryMs and keep a pause under the native model release');
  return bad;
}
