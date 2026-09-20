import { CONSTANTS } from './constants';

const DAY_MS = 86_400_000;

/** The four score bands shown in the app (§9.6): 90+, 80–89, 65–79, below 65. */
export type ScoreBand = 'excellent' | 'good' | 'getting_there' | 'needs_focus';

/** One scored trip, as the long-term score needs it. `durationS` feeds the 60-minute minimum. */
export interface TripForLongTerm {
  /** epoch ms */
  endedAt: number;
  score: number;
  exposure: number;
  durationS: number;
}

export interface LongTermScore {
  score: number | null;
  band: ScoreBand | null;
  /** True while the driver has not yet driven enough for the score to mean anything. */
  provisional: boolean;
  tripsUsed: number;
}

export function band(score: number): ScoreBand {
  if (score >= CONSTANTS.BAND_EXCELLENT) return 'excellent';
  if (score >= CONSTANTS.BAND_GOOD) return 'good';
  if (score >= CONSTANTS.BAND_GETTING_THERE) return 'getting_there';
  return 'needs_focus';
}

/**
 * The long-term score (§9.6): an exposure- and recency-weighted mean of recent trip scores, pulled
 * toward a prior of 80 worth two trips.
 *
 * The prior is what stops a driver's first good trip from reading as a perfect record and their
 * first bad one from reading as a disaster; the 21-day half-life is what lets last month's mistakes
 * fade. Below three trips or an hour of driving the number is withheld entirely rather than shown
 * as a near-prior 80 the driver would read as a judgement.
 */
export function longTermScore(trips: TripForLongTerm[], nowMs: number): LongTermScore {
  // Clamped at 0: a trip dated in the future (a skewed device clock, a daylight-saving jump) would
  // otherwise get a recency weight above 1 and outvote every trip the driver actually just made.
  const ageDays = (t: TripForLongTerm) => Math.max(0, (nowMs - t.endedAt) / DAY_MS);

  // The 60-day window is the score's memory; a driver who drove rarely this month falls back to
  // their last ten trips over six months rather than losing the score altogether.
  const recent = trips.filter((t) => ageDays(t) <= CONSTANTS.LONG_TERM_WINDOW_D);
  const used =
    recent.length >= CONSTANTS.LONG_TERM_MIN_TRIPS
      ? recent
      : trips
          .filter((t) => ageDays(t) <= CONSTANTS.LONG_TERM_MAX_D)
          .sort((a, b) => b.endedAt - a.endedAt)
          .slice(0, CONSTANTS.LONG_TERM_FALLBACK_TRIPS);

  const minutes = used.reduce((sum, t) => sum + t.durationS, 0) / 60;
  if (used.length < CONSTANTS.LONG_TERM_MIN_TRIPS || minutes < CONSTANTS.LONG_TERM_MIN_MINUTES) {
    return { score: null, band: null, provisional: true, tripsUsed: used.length };
  }

  let weightedScore = 0;
  let weight = 0;
  for (const t of used) {
    const w =
      Math.min(t.exposure, CONSTANTS.LONG_TERM_EXPOSURE_CAP) *
      Math.pow(0.5, ageDays(t) / CONSTANTS.LONG_TERM_HALF_LIFE_D);
    weightedScore += w * t.score;
    weight += w;
  }

  const score = Math.round(
    (weightedScore + CONSTANTS.LONG_TERM_K0 * CONSTANTS.LONG_TERM_MU0) /
      (weight + CONSTANTS.LONG_TERM_K0)
  );
  return { score, band: band(score), provisional: false, tripsUsed: used.length };
}
