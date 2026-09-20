import { CATEGORY, CONSTANTS, DROWSINESS_BASE } from './constants';
import type { ScorableEvent } from './types';

const MPH = CONSTANTS.MPH;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

// Band convention, pinned by the boundary tables in `__tests__/severity.test.ts`: every band
// includes its lower bound (`>=`), except the four open-ended top bands the spec writes as strict
// (`> 0.55 g`, `> 0.38 g`, `> 0.45 g`, `> 5 s`), which a value must exceed to enter. Where a band
// edge is the same quantity as a named detector threshold, the constant is used rather than a
// repeated literal.

/** Phone use, by the speed at the moment of handling (§9.3). Stopped is logged but unscored. */
function phoneSeverity(speedMps: number | undefined): number {
  // NaN fails every band below, so it has to be caught here or it would fall through to 0.3.
  if (speedMps === undefined || !Number.isFinite(speedMps) || speedMps <= 0) return 0;
  if (speedMps >= 25 * MPH) return 1;
  if (speedMps >= CONSTANTS.PHONE_MIN_SPEED_MPS) return 0.7;
  return 0.3;
}

/** Speeding, the greater of the absolute band and the percentage-over band (§9.3). */
function speedingSeverity(overMps: number | undefined, limitMps: number | undefined): number {
  if (overMps === undefined || overMps <= 0) return 0;

  let absolute = 0;
  if (overMps >= CONSTANTS.SEVERE_SPEEDING_OVER_MPS) absolute = 5;
  else if (overMps >= 15 * MPH) absolute = 3.5;
  else if (overMps >= 10 * MPH) absolute = 2;
  else if (overMps >= CONSTANTS.SPEEDING_TOLERANCE_MPS) absolute = 1;

  let percentage = 0;
  if (limitMps !== undefined && limitMps > 0) {
    const over = overMps / limitMps;
    if (over >= 0.4) percentage = 3.5;
    else if (over >= 0.2) percentage = 2;
  }

  return Math.max(absolute, percentage);
}

/** Hard braking, by longitudinal peak g (§9.3). */
function brakingSeverity(peakG: number | undefined): number {
  if (peakG === undefined) return 0;
  if (peakG > 0.55) return 2.5;
  if (peakG >= 0.4) return 1.75;
  if (peakG >= CONSTANTS.HARSH_BRAKE_G) return 1;
  return 0;
}

/** Rapid acceleration, by longitudinal peak g (§9.3). */
function accelSeverity(peakG: number | undefined): number {
  if (peakG === undefined) return 0;
  if (peakG > 0.38) return 1.75;
  if (peakG >= CONSTANTS.HARSH_ACCEL_G) return 1;
  return 0;
}

/** Sharp cornering, by lateral g (§9.3). */
function corneringSeverity(lateralG: number | undefined): number {
  if (lateralG === undefined) return 0;
  if (lateralG > 0.45) return 1.75;
  if (lateralG >= CONSTANTS.HARSH_CORNER_G) return 1;
  return 0;
}

/** Focus and alertness: drowsiness is flat, glances scale with how long the eyes were off (§9.3). */
function focusSeverity(measured: ScorableEvent['measured']): number {
  if (measured.focusKind === 'drowsiness') return 2;
  const glanceS = measured.glanceS;
  if (glanceS === undefined) return 0;
  if (glanceS > 5) return 3;
  if (glanceS >= 3) return 2;
  if (glanceS >= CONSTANTS.EYES_OFF_S) return 1;
  return 0;
}

/**
 * Event severity `s` (§9.3). A measured value that is missing or outside every band scores 0, so an
 * event we cannot characterise costs the driver nothing.
 */
export function severity(e: ScorableEvent): number {
  switch (e.category) {
    case 'phone':
      return phoneSeverity(e.measured.speedMps);
    case 'speeding':
      return speedingSeverity(e.measured.overMps, e.measured.limitMps);
    case 'braking':
      return brakingSeverity(e.measured.peakG);
    case 'accel':
      return accelSeverity(e.measured.peakG);
    case 'cornering':
      return corneringSeverity(e.measured.lateralG);
    case 'focus':
      return focusSeverity(e.measured);
  }
}

const PHONE_DURATION = { perSeconds: 6, min: 0.5, max: 3 } as const;
const SPEEDING_DURATION = { perSeconds: 30, min: 0.5, max: 4 } as const;

/**
 * Duration factor `t` (§9.3): phone `clamp(s / 6, 0.5, 3)`, speeding `clamp(s / 30, 0.5, 4)`, and 1
 * for the instantaneous categories. Correction credit floors `t` at the clamp's minimum for the two
 * sustained categories; the others have no duration to shorten, so they stay at 1.
 */
export function durationFactor(e: ScorableEvent): number {
  let band: typeof PHONE_DURATION | typeof SPEEDING_DURATION;
  if (e.category === 'phone') band = PHONE_DURATION;
  else if (e.category === 'speeding') band = SPEEDING_DURATION;
  else return 1;

  if (e.corrected) return band.min;
  return clamp(e.durationS / band.perSeconds, band.min, band.max);
}

/** Base weight `B` (§9.3); drowsiness carries a heavier base than the rest of the focus category. */
export function baseWeight(e: ScorableEvent): number {
  if (e.category === 'focus' && e.measured.focusKind === 'drowsiness') return DROWSINESS_BASE;
  return CATEGORY[e.category].base;
}
