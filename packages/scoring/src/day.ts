import { CONSTANTS } from './constants';
import type { ScoredTrip } from './types';

/** One of the day's trips, as the day evaluation needs it. */
export interface DayTrip {
  score: number | null;
  status: ScoredTrip['status'];
  durationS: number;
  hadSevereEvent: boolean;
  phoneEvents: number;
  cameraGood: boolean;
}

export interface DayInputs {
  trips: DayTrip[];
}

export interface DayResult {
  safeDay: boolean;
  goodDay: boolean;
  phoneFreeDay: boolean;
  cameraDay: boolean;
  points: number;
  /** Seconds of scored driving; the 10-minute floor for a safe or good day is measured against it. */
  drivingS: number;
}

/**
 * Evaluate one calendar day's trips (§9.9).
 *
 * Only scored trips count, so a passenger ride or a trip the phone barely saw neither earns nor
 * costs anything. Safe and good days are mutually exclusive and both require ten minutes of driving,
 * which keeps a single flawless trip round the block from being a day's achievement; a phone-free
 * day has no such minimum, because leaving the phone alone on a short drive is the same discipline.
 */
export function evaluateDay(d: DayInputs): DayResult {
  const scored = d.trips.filter(
    (t): t is DayTrip & { score: number } => t.status === 'final' && t.score !== null
  );

  const drivingS = scored.reduce((sum, t) => sum + t.durationS, 0);
  const average =
    scored.length === 0 ? 0 : scored.reduce((sum, t) => sum + t.score, 0) / scored.length;
  const droveEnough = drivingS >= CONSTANTS.SAFE_DAY_MIN_DRIVING_S;

  const safeDay =
    droveEnough && average >= CONSTANTS.SAFE_DAY_AVG && !scored.some((t) => t.hadSevereEvent);
  const goodDay = !safeDay && droveEnough && average >= CONSTANTS.GOOD_DAY_AVG;
  const phoneFreeDay =
    scored.length > 0 && scored.reduce((sum, t) => sum + t.phoneEvents, 0) === 0;
  const cameraDay = scored.some((t) => t.cameraGood);

  // Safe and good are exclusive, so the day's points are capped by construction at 50 + 25 + 10.
  const points =
    (safeDay ? CONSTANTS.POINTS.safeDay : goodDay ? CONSTANTS.POINTS.goodDay : 0) +
    (phoneFreeDay ? CONSTANTS.POINTS.phoneFreeDay : 0) +
    (cameraDay ? CONSTANTS.POINTS.cameraDay : 0);

  return { safeDay, goodDay, phoneFreeDay, cameraDay, points, drivingS };
}
